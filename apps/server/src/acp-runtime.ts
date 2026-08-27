import { EventEmitter } from "node:events";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";

import * as acp from "@agentclientprotocol/sdk";

import { AcpTurnMapper } from "./acp-mapper.js";
import { AcpTerminalService } from "./acp-terminal.js";
import { defaultAgentId } from "./agent-id.js";
import type { ModelOption, ReasoningEffort, TurnDto } from "./map.js";
import { inferWorkspaceRoot, ThreadPathError } from "./path.js";
import { parseCommandLine, spawnProcess } from "./process.js";

export { ThreadPathError };

export interface ThreadState {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  status: "idle" | "running" | "error";
  activeTurnId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  turns: TurnDto[];
}

interface SessionState {
  providerSessionId: string;
  mapper: AcpTurnMapper | null;
  turnStartedAt: string | null;
}

export class AcpRuntime extends EventEmitter {
  private child: ChildProcess | null = null;
  private context: acp.ClientContext | null = null;
  private connection: acp.ClientConnection | null = null;
  private ready = false;
  private readonly threads = new Map<string, ThreadState>();
  private readonly agentSessions = new Map<string, SessionState>();
  private currentId: string | null = null;
  models: ModelOption[] = [];
  readonly root: string;
  private readonly terminal: AcpTerminalService;

  constructor(
    private readonly command: string,
    readonly cwd: string,
    root?: string,
    private readonly displayName = "ACP Agent",
  ) {
    super();
    this.root = inferWorkspaceRoot(cwd, root);
    this.terminal = new AcpTerminalService((sessionId) => {
      for (const thread of this.threads.values()) {
        if (thread.id === sessionId) return thread.cwd;
      }
      return this.cwd;
    });
  }

  get current() {
    return this.currentId ? this.threads.get(this.currentId) ?? null : null;
  }

  threadForAgent(agentId: string) {
    return this.threads.get(agentId.trim() || defaultAgentId()) ?? null;
  }

  async start() {
    if (this.ready) return;
    const parsed = parseCommandLine(this.command);
    const child = spawnProcess({
      command: parsed.command,
      args: parsed.args,
      cwd: this.cwd,
      env: {
        ...process.env,
        HOME: process.env.HOME,
        CODEX_HOME: process.env.CODEX_HOME || `${process.env.HOME ?? ""}/.codex`,
        CODEX_PATH: process.env.CODEX_PATH || "codex",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr?.on("data", (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.trim()) this.emit("log", text.trim());
    });
    child.on("exit", () => {
      this.ready = false;
    });
    if (!child.stdin || !child.stdout) {
      throw new Error("ACP agent did not expose stdio");
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const app = acp
      .client({ name: "treer-acp-ui" })
      .onRequest(acp.methods.client.session.requestPermission, (request) =>
        this.autoApprove(request.params))
      .onNotification(acp.methods.client.session.update, (notification) =>
        this.handleUpdate(notification.params))
      .onRequest(acp.methods.client.fs.readTextFile, async (request) => {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(request.params.path, "utf8");
        return { content };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (request) => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(request.params.path, request.params.content);
        return {};
      })
      .onRequest(acp.methods.client.terminal.create, (request) => this.terminal.create(request.params))
      .onRequest(acp.methods.client.terminal.output, (request) => this.terminal.output(request.params))
      .onRequest(acp.methods.client.terminal.waitForExit, (request) => this.terminal.waitForExit(request.params))
      .onRequest(acp.methods.client.terminal.kill, (request) => this.terminal.kill(request.params))
      .onRequest(acp.methods.client.terminal.release, (request) => this.terminal.release(request.params));
    this.connection = app.connect(stream);
    this.context = this.connection.agent;
    const initialized = await this.context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        session: { compaction: {}, configOptions: { boolean: {} } },
        plan: {},
      },
      clientInfo: { name: "treer-acp-ui", title: "Treer ACP UI", version: "0.1.0" },
    });
    const methods = initialized.authMethods ?? [];
    this.emit("log", `ACP auth methods: ${methods.map((entry) => entry.id).join(", ") || "(none)"}`);
    const preferred = methods.filter((entry) => !("type" in entry && entry.type === "terminal"));
    const hasApiKey = Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
    const ordered = [
      preferred.find((entry) => entry.id === "none"),
      preferred.find((entry) => entry.id === "chat-gpt" || entry.id === "chatgpt"),
      hasApiKey ? preferred.find((entry) => entry.id === "api-key") : undefined,
      ...preferred,
      ...methods,
    ].filter((entry, index, list): entry is (typeof methods)[number] =>
      entry != null && list.findIndex((candidate) => candidate?.id === entry.id) === index,
    );
    let authenticated = ordered.length === 0;
    for (const method of ordered) {
      try {
        await this.context.request(acp.methods.agent.authenticate, { methodId: method.id });
        this.emit("log", `ACP authenticated with ${method.id}`);
        authenticated = true;
        break;
      } catch (error) {
        this.emit("log", `ACP auth ${method.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!authenticated) {
      throw new Error("ACP agent requires authentication, but no advertised method succeeded");
    }
    this.ready = true;
    this.models = [{
      id: "default",
      model: "default",
      displayName: `${this.displayName} default`,
      description: "",
      isDefault: true,
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
    }];
    this.emit("state");
  }

  async bindAgent(agentId: string, input: { title?: string; cwd?: string; model?: string } = {}) {
    await this.start();
    const id = agentId.trim() || defaultAgentId();
    const existing = this.threads.get(id);
    if (existing) {
      this.currentId = id;
      this.emit("state");
      return existing;
    }
    const cwd = resolve(input.cwd || this.cwd);
    const context = this.requireContext();
    const response = await context.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
      _meta: { yoloMode: true },
    });
    const now = new Date().toISOString();
    const thread: ThreadState = {
      id,
      title: input.title?.trim() || basename(cwd) || this.displayName,
      cwd,
      model: input.model && input.model !== "default" ? input.model : null,
      reasoningEffort: null,
      status: "idle",
      activeTurnId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    this.threads.set(id, thread);
    this.agentSessions.set(id, {
      providerSessionId: response.sessionId,
      mapper: null,
      turnStartedAt: null,
    });
    this.currentId = id;
    this.emit("state");
    return thread;
  }

  async prompt(text: string, threadId?: string) {
    const thread = threadId ? this.requireThread(threadId) : this.current;
    if (!thread) throw new Error("ACP is not ready");
    const session = this.agentSessions.get(thread.id);
    if (!session) throw new Error("ACP session is not bound");
    if (session.mapper) throw new Error("ACP session already has an active turn");
    const turnId = randomUUID();
    const startedAt = new Date().toISOString();
    const mapper = new AcpTurnMapper(turnId, [{
      id: `${turnId}:user`,
      kind: "userMessage",
      text,
      sourceTurnId: turnId,
    }]);
    session.mapper = mapper;
    session.turnStartedAt = startedAt;
    const started = mapper.snapshot("inProgress");
    started.startedAt = startedAt;
    thread.status = "running";
    thread.activeTurnId = turnId;
    thread.updatedAt = startedAt;
    thread.turns.push(started);
    this.emit("state");
    const context = this.requireContext();
    void context.request(acp.methods.agent.session.prompt, {
      sessionId: session.providerSessionId,
      prompt: [{ type: "text", text }],
    }).then(
      (response) => this.finishTurn(
        thread,
        session,
        mapper,
        response.stopReason === "cancelled" ? "interrupted" : "completed",
      ),
      (error) => this.finishTurn(
        thread,
        session,
        mapper,
        "failed",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  async interrupt(threadId?: string) {
    const thread = threadId ? this.requireThread(threadId) : this.current;
    if (!thread) return;
    const session = this.agentSessions.get(thread.id);
    if (!session?.mapper) return;
    await this.requireContext().notify(acp.methods.agent.session.cancel, {
      sessionId: session.providerSessionId,
    });
  }

  async updateSettings(_input?: { model?: string; reasoningEffort?: string | null }, _threadId?: string) {
    this.emit("state");
  }

  async stop() {
    this.terminal.stop();
    this.connection?.close();
    this.child?.kill("SIGTERM");
    this.connection = null;
    this.context = null;
    this.child = null;
    this.ready = false;
  }

  snapshot() {
    return {
      ready: this.ready,
      cwd: this.cwd,
      root: this.root,
      currentId: this.currentId,
      thread: this.current,
      threads: [...this.threads.values()],
      models: this.models,
    };
  }

  private finishTurn(
    thread: ThreadState,
    session: SessionState,
    mapper: AcpTurnMapper,
    status: TurnDto["status"],
    error: string | null = null,
  ) {
    if (session.mapper !== mapper) return;
    const turn = mapper.complete(status, error);
    turn.startedAt = session.turnStartedAt;
    const index = thread.turns.findIndex((entry) => entry.id === mapper.turnId);
    if (index >= 0) thread.turns[index] = turn;
    session.mapper = null;
    session.turnStartedAt = null;
    thread.activeTurnId = null;
    thread.status = status === "failed" ? "error" : "idle";
    thread.lastError = error;
    thread.updatedAt = new Date().toISOString();
    this.emit("state");
  }

  private handleUpdate(notification: acp.SessionNotification) {
    for (const [agentId, session] of this.agentSessions) {
      if (session.providerSessionId !== notification.sessionId || !session.mapper) continue;
      session.mapper.apply(notification.update);
      const thread = this.threads.get(agentId);
      if (!thread) continue;
      const turn = session.mapper.snapshot("inProgress");
      turn.startedAt = session.turnStartedAt;
      const index = thread.turns.findIndex((entry) => entry.id === session.mapper?.turnId);
      if (index >= 0) thread.turns[index] = turn;
      thread.updatedAt = new Date().toISOString();
      this.emit("state");
    }
  }

  private autoApprove(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    const allow = params.options.find((option) => option.kind === "allow_always")
      ?? params.options.find((option) => option.kind === "allow_once");
    if (!allow) {
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }

  private requireContext() {
    if (!this.context) throw new Error("ACP is not ready");
    return this.context;
  }

  private requireThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    return thread;
  }
}
