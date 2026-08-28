import { EventEmitter } from "node:events";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";

import * as acp from "@agentclientprotocol/sdk";

import {
  describeAcpConfigOptions,
  mapAcpSessionPayload,
  mapAcpUsageUpdate,
  resolveAcpThoughtValue,
  rewriteModelIdForEffort,
  seedContextUsage,
  unavailableContextUsage,
  withCurrentModel,
  type AcpSessionConfig,
  type AcpSessionPayload,
  type ThreadContextUsage,
} from "./acp-config.js";
import { loadAcpSpawnEnvironment, selectAcpAuthMethodIds } from "./acp-environment.js";
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
  contextUsage: ThreadContextUsage;
}

interface SessionState {
  providerSessionId: string;
  mapper: AcpTurnMapper | null;
  turnStartedAt: string | null;
  config: AcpSessionConfig;
  payload: AcpSessionPayload;
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
    const loaded = await loadAcpSpawnEnvironment();
    this.emit("log", `ACP env sources: ${loaded.sources.join(", ") || "process env"}`);
    const child = spawnProcess({
      command: parsed.command,
      args: parsed.args,
      cwd: this.cwd,
      env: loaded.env,
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
    const ordered = selectAcpAuthMethodIds({
      advertised: methods,
      env: loaded.env,
      hasChatGptSession: loaded.hasChatGptSession,
    });
    this.emit("log", `ACP auth order: ${ordered.join(", ") || "(skip)"}`);
    let authenticated = ordered.length === 0;
    for (const methodId of ordered) {
      try {
        await withTimeout(
          this.context.request(acp.methods.agent.authenticate, {
            methodId,
            _meta: { headless: true },
          }),
          12_000,
          `ACP authenticate ${methodId} timed out`,
        );
        this.emit("log", `ACP authenticated with ${methodId}`);
        authenticated = true;
        break;
      } catch (error) {
        this.emit("log", `ACP auth ${methodId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!authenticated && methods.length > 0 && ordered.length > 0) {
      throw new Error("ACP agent requires authentication, but no advertised method succeeded");
    }
    if (!authenticated) {
      this.emit("log", "ACP authenticate skipped; trying session/new with existing CLI login");
    }
    this.ready = true;
    this.models = [];
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
      model: null,
      reasoningEffort: null,
      status: "idle",
      activeTurnId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      turns: [],
      contextUsage: unavailableContextUsage(now),
    };
    this.threads.set(id, thread);
    const session: SessionState = {
      providerSessionId: response.sessionId,
      mapper: null,
      turnStartedAt: null,
      config: mapAcpSessionPayload({}),
      payload: {},
    };
    this.agentSessions.set(id, session);
    this.applySessionPayload(thread, session, sessionPayloadFromNew(response));
    this.currentId = id;
    if (input.model && input.model !== "default" && input.model !== thread.model) {
      await this.updateSettings({ model: input.model }, id);
    }
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

  async updateSettings(input: { model?: string; reasoningEffort?: string | null } = {}, threadId?: string) {
    const thread = threadId ? this.requireThread(threadId) : this.current;
    if (!thread) throw new Error("ACP is not ready");
    const session = this.agentSessions.get(thread.id);
    if (!session) throw new Error("ACP session is not bound");
    if (typeof input.model === "string" && input.model.trim()) {
      const nextModel = input.model.trim();
      if (!session.config.models.some((entry) => entry.model === nextModel) && session.config.models.length > 0) {
        throw new Error(`unknown model: ${nextModel}`);
      }
      if (nextModel !== thread.model) {
        await this.writeModel(session, thread, nextModel);
      }
    }
    if (input.reasoningEffort !== undefined) {
      const thoughtValue = resolveAcpThoughtValue(session.config, input.reasoningEffort);
      const currentThoughtValue = session.config.thoughtValues.find((entry) => (
        entry.effort === thread.reasoningEffort
      ))?.value ?? null;
      if (thoughtValue && thoughtValue !== currentThoughtValue) {
        await this.writeThought(session, thread, thoughtValue);
      }
    }
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
      if (session.providerSessionId !== notification.sessionId) continue;
      const thread = this.threads.get(agentId);
      if (!thread) continue;
      const update = notification.update;
      if (update.sessionUpdate === "config_option_update") {
        this.applySessionPayload(thread, session, {
          ...session.payload,
          configOptions: update.configOptions,
        });
        this.emit("state");
        continue;
      }
      if (update.sessionUpdate === "usage_update") {
        thread.contextUsage = mapAcpUsageUpdate(update);
        thread.updatedAt = new Date().toISOString();
        this.emit("state");
        continue;
      }
      if (!session.mapper) continue;
      session.mapper.apply(update);
      const turn = session.mapper.snapshot("inProgress");
      turn.startedAt = session.turnStartedAt;
      const index = thread.turns.findIndex((entry) => entry.id === session.mapper?.turnId);
      if (index >= 0) thread.turns[index] = turn;
      thread.updatedAt = new Date().toISOString();
      this.emit("state");
    }
  }

  private applySessionPayload(
    thread: ThreadState,
    session: SessionState,
    payload: AcpSessionPayload,
  ) {
    const config = mapAcpSessionPayload(payload);
    session.payload = payload;
    session.config = config;
    this.models = config.models;
    thread.model = config.model;
    thread.reasoningEffort = config.reasoningEffort;
    if (thread.contextUsage.availability !== "available" || !thread.contextUsage.modelContextWindow) {
      thread.contextUsage = seedContextUsage(config.modelContextWindow, thread.updatedAt);
    } else if (config.modelContextWindow && config.modelContextWindow !== thread.contextUsage.modelContextWindow) {
      thread.contextUsage = mapAcpUsageUpdate({
        used: thread.contextUsage.tokensInContextWindow ?? 0,
        size: config.modelContextWindow,
      }, new Date().toISOString());
    }
    thread.updatedAt = new Date().toISOString();
    this.emit(
      "log",
      `ACP config: model=${config.model ?? "(none)"} effort=${config.reasoningEffort ?? "auto"} via ${config.modelWrite ?? "none"}/${config.thoughtWrite ?? "none"} options=${describeAcpConfigOptions(config.options)}`,
    );
  }

  private async writeModel(session: SessionState, thread: ThreadState, nextModel: string) {
    const context = this.requireContext();
    if (session.config.modelWrite === "config" && session.config.modelConfigId) {
      const response = await context.request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.providerSessionId,
        configId: session.config.modelConfigId,
        value: nextModel,
      });
      this.applySessionPayload(thread, session, {
        ...session.payload,
        configOptions: response.configOptions,
        models: withCurrentModel(session.payload, nextModel).models ?? session.payload.models,
      });
      return;
    }
    if (session.config.modelWrite === "set_model") {
      await context.request("session/set_model" as never, {
        sessionId: session.providerSessionId,
        modelId: nextModel,
      } as never);
      this.applySessionPayload(thread, session, withCurrentModel(session.payload, nextModel));
      return;
    }
    throw new Error(`unknown model: ${nextModel}`);
  }

  private async writeThought(session: SessionState, thread: ThreadState, thoughtValue: string) {
    const context = this.requireContext();
    if (session.config.thoughtWrite === "config" && session.config.thoughtConfigId) {
      const response = await context.request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.providerSessionId,
        configId: session.config.thoughtConfigId,
        value: thoughtValue,
      });
      this.applySessionPayload(thread, session, {
        ...session.payload,
        configOptions: response.configOptions,
      });
      return;
    }
    if (session.config.thoughtWrite === "set_mode") {
      await context.request(acp.methods.agent.session.setMode, {
        sessionId: session.providerSessionId,
        modeId: thoughtValue,
      });
      const current = currentLegacyFor(session.payload, thread.model);
      if (current?._meta) {
        current._meta.reasoningEffort = thoughtValue;
      }
      this.applySessionPayload(thread, session, session.payload);
      return;
    }
    if (session.config.thoughtWrite === "model_id" && thread.model) {
      const nextModel = rewriteModelIdForEffort(thread.model, thoughtValue);
      await this.writeModel(session, thread, nextModel);
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

function sessionPayloadFromNew(response: acp.NewSessionResponse): AcpSessionPayload {
  const extra = response as acp.NewSessionResponse & { models?: AcpSessionPayload["models"] };
  return {
    configOptions: response.configOptions ?? [],
    models: extra.models ?? null,
    modes: response.modes ?? null,
    _meta: response._meta ?? null,
  };
}

function currentLegacyFor(payload: AcpSessionPayload, modelId: string | null) {
  const available = payload.models?.availableModels ?? [];
  return available.find((entry) => entry.modelId === modelId) ?? available[0] ?? null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
