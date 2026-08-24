import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { CodexRuntime } from "./codex.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const webDist = process.env.CODEX_AGENT_UI_WEB_DIST || join(root, "apps/web/dist");
const port = Number(process.env.CODEX_AGENT_UI_PORT || process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) || "4173");
const cwd = resolve(process.env.CODEX_AGENT_UI_CWD || process.cwd());
const command = process.env.CODEX_BIN || "codex";

const runtime = new CodexRuntime(command, cwd);
const sockets = new Set<{ send: (data: string) => void }>();

function mime(file: string) {
  switch (extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function send(response: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(payload);
}

function serveFile(response: ServerResponse, file: string) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    return false;
  }
  const headers: Record<string, string> = {
    "content-type": mime(file),
    "cache-control": "no-store",
  };
  if (extname(file) === ".html") {
    headers["content-security-policy"] =
      "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:";
  }
  response.writeHead(200, headers);
  createReadStream(file).pipe(response);
  return true;
}

function requestPath(url: string) {
  const pathname = new URL(url, "http://127.0.0.1").pathname;
  return pathname.replace(/\/+$/, "") || "/";
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function statePayload() {
  const snapshot = runtime.snapshot();
  const thread = snapshot.thread;
  const now = thread?.updatedAt ?? new Date().toISOString();
  const dto = thread
    ? {
        id: thread.id,
        workspaceId: "local",
        provider: "codex",
        providerSessionId: thread.id,
        source: "supervisor",
        title: thread.title,
        model: thread.model,
        reasoningEffort: thread.reasoningEffort,
        fastMode: false,
        collaborationMode: "default",
        approvalMode: "yolo",
        sandboxMode: "workspace-write",
        status: thread.status === "running" ? "running" : thread.status === "error" ? "error" : "idle",
        summaryText: null,
        lastError: thread.lastError,
        activeTurnId: thread.activeTurnId,
        isLoaded: true,
        isPinned: false,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        lastTurnStartedAt: thread.turns.at(-1)?.startedAt ?? null,
        lastTurnCompletedAt: null,
      }
    : null;
  return {
    ready: snapshot.ready,
    status: {
      state: snapshot.ready ? "ready" : "starting",
      transport: "stdio",
      lastStartedAt: now,
      lastError: thread?.lastError ?? null,
      restartCount: 0,
    },
    modelOptions: snapshot.models,
    threads: dto ? [dto] : [],
    detail: dto && thread
      ? {
          thread: dto,
          workspace: {
            id: "local",
            hostId: "local",
            label: thread.cwd,
            absPath: thread.cwd,
            isFavorite: false,
            createdAt: thread.createdAt,
            lastOpenedAt: thread.updatedAt,
          },
          workspacePathStatus: "present",
          totalTurnCount: thread.turns.length,
          pendingRequests: [],
          pendingSteers: [],
          turns: thread.turns,
        }
      : null,
  };
}

function broadcast() {
  const encoded = JSON.stringify({ type: "state", ...statePayload() });
  for (const socket of sockets) {
    try {
      socket.send(encoded);
    } catch {
      sockets.delete(socket);
    }
  }
}

runtime.on("state", broadcast);
runtime.on("log", (message) => {
  console.log(`[codex] ${message}`);
});

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const path = requestPath(request.url ?? "/");
  try {
    if (path === "/api/health" || path === "/.treer/agent") {
      const snapshot = runtime.snapshot();
      const surface = {
        protocol: "treer.agent.surface",
        version: 1,
        ready: snapshot.ready,
        title: snapshot.thread?.title ?? "Codex",
        ui: true,
        capabilities: ["ui"],
      };
      if (path === "/api/health") {
        send(response, snapshot.ready ? 200 : 503, { ok: snapshot.ready, ready: snapshot.ready });
        return;
      }
      send(response, snapshot.ready ? 200 : 503, surface);
      return;
    }
    if (path === "/api/state" && method === "GET") {
      send(response, 200, statePayload());
      return;
    }
    if (path === "/api/prompt" && method === "POST") {
      const body = await readJson(request);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) {
        send(response, 400, { error: "prompt is required" });
        return;
      }
      await runtime.prompt(prompt);
      send(response, 200, statePayload());
      return;
    }
    if (path === "/api/interrupt" && method === "POST") {
      await runtime.interrupt();
      send(response, 200, statePayload());
      return;
    }
    if (path === "/api/settings" && method === "POST") {
      const body = await readJson(request);
      await runtime.updateSettings({
        model: typeof body.model === "string" ? body.model : undefined,
        reasoningEffort:
          body.reasoningEffort === undefined
            ? undefined
            : typeof body.reasoningEffort === "string" || body.reasoningEffort === null
              ? body.reasoningEffort
              : undefined,
      });
      send(response, 200, statePayload());
      return;
    }

    const relative = path === "/" ? "index.html" : path.slice(1);
    const file = normalize(join(webDist, relative));
    if (file.startsWith(webDist) && serveFile(response, file)) {
      return;
    }
    if (method === "GET" && serveFile(response, join(webDist, "index.html"))) {
      return;
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const socketsServer = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const path = requestPath(request.url ?? "/");
  if (path !== "/ws") {
    socket.destroy();
    return;
  }
  socketsServer.handleUpgrade(request, socket, head, (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: "state", ...statePayload() }));
    ws.on("close", () => sockets.delete(ws));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`codex-agent-ui listening on http://127.0.0.1:${port}`);
  runtime.start().catch((error) => {
    console.error("failed to start Codex app-server", error);
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void runtime.stop().finally(() => process.exit(0));
  });
}
