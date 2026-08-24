import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { defaultAgentId, resolveAgentId } from "./agent-id.js";
import { CodexRuntime, ThreadPathError, type ThreadState } from "./codex.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const webDist = process.env.CODEX_AGENT_UI_WEB_DIST || join(root, "apps/web/dist");
const port = Number(process.env.CODEX_AGENT_UI_PORT || process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) || "4173");
const cwd = resolve(process.env.CODEX_AGENT_UI_CWD || process.cwd());
const command = process.env.CODEX_BIN || "codex";

const runtime = new CodexRuntime(command, cwd, process.env.CODEX_AGENT_UI_ROOT);
const sockets = new Set<{ agentId: string; send: (data: string) => void }>();

function requestUrl(request: IncomingMessage) {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

function agentIdFromRequest(request: IncomingMessage, body?: Record<string, unknown>) {
  const url = requestUrl(request);
  return resolveAgentId({
    query: url.searchParams.get("agent"),
    header: typeof request.headers["x-treer-agent-id"] === "string" ? request.headers["x-treer-agent-id"] : null,
    body: typeof body?.agentId === "string" ? body.agentId : null,
    fallback: defaultAgentId(),
  });
}

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

function toThreadDto(thread: ThreadState) {
  return {
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
  };
}

function statePayload(agentId = defaultAgentId()) {
  const snapshot = runtime.snapshot();
  const current = runtime.threadForAgent(agentId) ?? snapshot.thread;
  const now = current?.updatedAt ?? new Date().toISOString();
  const dto = current ? toThreadDto(current) : null;
  return {
    ready: snapshot.ready,
    cwd: snapshot.cwd,
    root: snapshot.root,
    agentId,
    status: {
      state: snapshot.ready ? "ready" : "starting",
      transport: "stdio",
      lastStartedAt: now,
      lastError: current?.lastError ?? null,
      restartCount: 0,
    },
    modelOptions: snapshot.models,
    threads: current ? [toThreadDto(current)] : [],
    detail: dto && current
      ? {
          thread: dto,
          workspace: {
            id: "local",
            hostId: "local",
            label: current.cwd,
            absPath: current.cwd,
            isFavorite: false,
            createdAt: current.createdAt,
            lastOpenedAt: current.updatedAt,
          },
          workspacePathStatus: "present",
          totalTurnCount: current.turns.length,
          pendingRequests: [],
          pendingSteers: [],
          turns: current.turns,
        }
      : null,
  };
}

function broadcast() {
  for (const socket of sockets) {
    try {
      socket.send(JSON.stringify({ type: "state", ...statePayload(socket.agentId) }));
    } catch {
      sockets.delete(socket);
    }
  }
}

async function threadForRequest(agentId: string) {
  return runtime.threadForAgent(agentId) ?? runtime.bindAgent(agentId);
}

function clientErrorStatus(error: unknown) {
  if (error instanceof ThreadPathError) {
    return 400;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.startsWith("unknown model:") ||
    message.startsWith("unknown thread:") ||
    message === "threadId is required" ||
    message === "prompt is required"
  ) {
    return 400;
  }
  return 500;
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
      const agentId = agentIdFromRequest(request);
      send(response, 200, statePayload(agentId));
      return;
    }
    if (path === "/api/agents/bind" && method === "POST") {
      const body = await readJson(request);
      const agentId = agentIdFromRequest(request, body);
      await runtime.bindAgent(agentId, {
        title: typeof body.title === "string" ? body.title : undefined,
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
      });
      send(response, 200, statePayload(agentId));
      return;
    }
    if (path === "/api/prompt" && method === "POST") {
      const body = await readJson(request);
      const agentId = agentIdFromRequest(request, body);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) {
        send(response, 400, { error: "prompt is required" });
        return;
      }
      const thread = await threadForRequest(agentId);
      await runtime.prompt(prompt, thread.id);
      send(response, 200, statePayload(agentId));
      return;
    }
    if (path === "/api/interrupt" && method === "POST") {
      const agentId = agentIdFromRequest(request);
      const thread = runtime.threadForAgent(agentId);
      if (thread) {
        await runtime.interrupt(thread.id);
      }
      send(response, 200, statePayload(agentId));
      return;
    }
    if (path === "/api/settings" && method === "POST") {
      const body = await readJson(request);
      const agentId = agentIdFromRequest(request, body);
      const thread = await threadForRequest(agentId);
      await runtime.updateSettings({
        model: typeof body.model === "string" ? body.model : undefined,
        reasoningEffort:
          body.reasoningEffort === undefined
            ? undefined
            : typeof body.reasoningEffort === "string" || body.reasoningEffort === null
              ? body.reasoningEffort
              : undefined,
      }, thread.id);
      send(response, 200, statePayload(agentId));
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
    send(response, clientErrorStatus(error), { error: error instanceof Error ? error.message : String(error) });
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
    const agentId = agentIdFromRequest(request);
    const client = { agentId, send: (data: string) => ws.send(data) };
    sockets.add(client);
    ws.send(JSON.stringify({ type: "state", ...statePayload(agentId) }));
    ws.on("close", () => sockets.delete(client));
  });
});

server.on("error", (error) => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    console.error(`port ${port} is already in use; attach to the existing Codex Agent UI instead`);
    process.exit(75);
  }
  throw error;
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
