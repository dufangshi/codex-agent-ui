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
const completedOperations = new Map<string, number>();
const AIS_PROTOCOL = "treer.agent-interface/v1";
const aisUiPath = "/";
const aisCapabilities = ["prompt.submit", "transcript.read", "state.observe", "abort"];
const processInstanceId =
  process.env.CODEX_AGENT_UI_INSTANCE_ID?.trim()
  || process.env.TREER_AIS_INSTANCE_ID?.trim()
  || `codex-ui-${defaultAgentId()}`;

function requestUrl(request: IncomingMessage) {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

function headerValue(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  return typeof value === "string" ? value.trim() : "";
}

function agentIdFromRequest(request: IncomingMessage, body?: Record<string, unknown>) {
  const url = requestUrl(request);
  return resolveAgentId({
    query: url.searchParams.get("agent"),
    header: headerValue(request, "x-treer-agent-id") || null,
    body: typeof body?.agentId === "string" ? body.agentId : null,
    fallback: defaultAgentId(),
  });
}

function interfaceIdentity(request: IncomingMessage, body?: Record<string, unknown>) {
  const agentId = agentIdFromRequest(request, body);
  const instanceId = headerValue(request, "x-treer-interface-instance") || processInstanceId;
  return { agentId, instanceId };
}

function runtimeStatus(agentId: string) {
  const snapshot = runtime.snapshot();
  const thread = runtime.threadForAgent(agentId) ?? snapshot.thread;
  if (!snapshot.ready) {
    return { status: "starting" as const, error: thread?.lastError ?? null };
  }
  if (thread?.status === "running") {
    return { status: "working", error: thread.lastError };
  }
  if (thread?.status === "error") {
    return { status: "blocked", error: thread.lastError };
  }
  return { status: "idle", error: thread?.lastError ?? null };
}

function transcriptPayload(request: IncomingMessage, url: URL) {
  const { agentId, instanceId } = interfaceIdentity(request);
  const thread = runtime.threadForAgent(agentId) ?? runtime.snapshot().thread;
  const entries = (thread?.turns ?? []).flatMap((turn) =>
    turn.items.map((item, index) => ({
      id: item.id || `${turn.id}:${index}`,
      kind: item.kind,
      role: item.kind === "userMessage" ? "user" : item.kind === "agentMessage" ? "assistant" : null,
      content: item.text,
      created_at: turn.startedAt,
    })),
  );
  const cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0);
  const limit = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100));
  const page = entries.slice(cursor, cursor + limit);
  const next = cursor + page.length;
  return {
    agent_id: agentId,
    interface_instance_id: instanceId,
    cursor: String(cursor),
    next_cursor: next < entries.length ? String(next) : null,
    entries: page,
  };
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
  const url = requestUrl(request);
  const path = requestPath(request.url ?? "/");
  try {
    if (path === "/v1/manifest" && (method === "GET" || method === "HEAD")) {
      const { instanceId } = interfaceIdentity(request);
      send(response, 200, {
        protocol: AIS_PROTOCOL,
        instance_id: instanceId,
        capabilities: aisCapabilities,
        ui_path: aisUiPath,
      });
      return;
    }
    if (path === "/v1/health" && (method === "GET" || method === "HEAD")) {
      const snapshot = runtime.snapshot();
      const { instanceId } = interfaceIdentity(request);
      send(response, snapshot.ready ? 200 : 503, {
        instance_id: instanceId,
        status: snapshot.ready ? "ok" : "starting",
      });
      return;
    }
    if (path === "/v1/status" && method === "GET") {
      const { agentId, instanceId } = interfaceIdentity(request);
      await runtime.bindAgent(agentId);
      const current = runtimeStatus(agentId);
      send(response, 200, {
        agent_id: agentId,
        interface_instance_id: instanceId,
        status: current.status,
        busy: current.status === "working",
        error: current.error,
      });
      return;
    }
    if (path === "/v1/transcript" && method === "GET") {
      const { agentId } = interfaceIdentity(request);
      await runtime.bindAgent(agentId);
      send(response, 200, transcriptPayload(request, url));
      return;
    }
    if (path === "/v1/prompts" && method === "POST") {
      const body = await readJson(request);
      const { agentId, instanceId } = interfaceIdentity(request, body);
      const operationId = typeof body.operation_id === "string" ? body.operation_id.trim() : "";
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!operationId || !text) {
        send(response, 400, { error: "operation_id and text are required" });
        return;
      }
      const opKey = `${agentId}:${operationId}`;
      if (completedOperations.has(opKey)) {
        send(response, 202, { accepted: true, duplicate: true, operation_id: operationId, agent_id: agentId, interface_instance_id: instanceId });
        return;
      }
      completedOperations.set(opKey, Date.now());
      try {
        const thread = await runtime.bindAgent(agentId);
        await runtime.prompt(text, thread.id);
      } catch (error) {
        completedOperations.delete(opKey);
        throw error;
      }
      while (completedOperations.size > 1024) {
        completedOperations.delete(completedOperations.keys().next().value!);
      }
      send(response, 202, { accepted: true, operation_id: operationId, agent_id: agentId, interface_instance_id: instanceId });
      return;
    }
    if (path === "/v1/abort" && method === "POST") {
      const { agentId } = interfaceIdentity(request);
      const thread = runtime.threadForAgent(agentId);
      if (thread) {
        await runtime.interrupt(thread.id);
      }
      send(response, 202, { accepted: true });
      return;
    }
    if (path === "/api/health" || path === "/.treer/agent") {
      const snapshot = runtime.snapshot();
      const surface = {
        protocol: "treer.agent.surface",
        version: 1,
        ready: snapshot.ready,
        title: snapshot.thread?.title ?? "Codex",
        ui: true,
        capabilities: aisCapabilities,
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
