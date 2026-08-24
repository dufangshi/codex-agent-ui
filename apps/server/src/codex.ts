import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { basename } from "node:path";

import { JsonRpcClient } from "./jsonrpc.js";
import {
  fallbackModelOption,
  mapModelOption,
  mapReasoningEffort,
  mapTurn,
  yoloResponse,
  type ModelOption,
  type ReasoningEffort,
  type TurnDto,
} from "./map.js";
import { defaultAgentId } from "./agent-id.js";
import { inferWorkspaceRoot, resolveThreadCwd, ThreadPathError } from "./path.js";

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

export interface CreateThreadInput {
  title?: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string | null;
}

interface ThreadStartResult {
  thread: { id: string; name?: string | null; cwd?: string; model?: string };
  model?: string;
  reasoningEffort?: unknown;
  reasoning_effort?: unknown;
}

export class CodexRuntime extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private client: JsonRpcClient | null = null;
  private ready = false;
  private readonly threads = new Map<string, ThreadState>();
  private readonly agentThreads = new Map<string, string>();
  private currentId: string | null = null;
  models: ModelOption[] = [];
  readonly root: string;

  constructor(
    private readonly command: string,
    readonly cwd: string,
    root?: string,
  ) {
    super();
    this.root = inferWorkspaceRoot(cwd, root);
  }

  get current(): ThreadState | null {
    return this.currentId ? this.threads.get(this.currentId) ?? null : null;
  }

  listThreads() {
    return [...this.threads.values()].sort((left, right) => {
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
  }

  async start() {
    const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
    });
    this.child = child;
    const client = new JsonRpcClient(child.stdout, child.stdin);
    this.client = client;

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        this.emit("log", text);
      }
    });
    child.on("exit", (code, signal) => {
      this.ready = false;
      this.emit("exit", { code, signal });
    });

    client.on("notification", (event) => {
      void this.onNotification(event as { method?: string; params?: Record<string, unknown> });
    });
    client.on("request", (request) => {
      const method = String((request as { method?: string }).method ?? "");
      const id = (request as { id: number }).id;
      const params = (request as { params?: unknown }).params;
      try {
        client.respond(id, yoloResponse(method, params));
      } catch (error) {
        this.emit("log", `failed to auto-approve ${method}: ${error}`);
      }
    });

    await client.request("initialize", {
      clientInfo: {
        name: "codex-agent-ui",
        title: "Codex Agent UI",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.ready = true;
    this.models = await this.loadModels().catch((error) => {
      this.emit("log", `model/list failed: ${error}`);
      return [] as ModelOption[];
    });
    const thread = await this.createThread({ title: "Codex", cwd: this.cwd });
    this.agentThreads.set(defaultAgentId(), thread.id);
  }

  threadForAgent(agentId: string) {
    const id = agentId.trim() || defaultAgentId();
    const threadId = this.agentThreads.get(id);
    return threadId ? this.threads.get(threadId) ?? null : null;
  }

  async bindAgent(agentId: string, input: CreateThreadInput = {}) {
    const id = agentId.trim() || defaultAgentId();
    const existing = this.threadForAgent(id);
    if (existing) {
      this.currentId = existing.id;
      await this.refresh(existing.id).catch((error) => this.emit("log", `thread refresh skipped: ${error}`));
      this.emit("state");
      return existing;
    }
    const thread = await this.createThread(input);
    this.agentThreads.set(id, thread.id);
    this.emit("state");
    return thread;
  }

  async createThread(input: CreateThreadInput = {}) {
    if (!this.client || !this.ready) {
      throw new Error("Codex is not ready");
    }
    const cwd = resolveThreadCwd(input.cwd, this.cwd, this.root);
    const model = this.resolveModel(input.model);
    const reasoningEffort = this.resolveEffort(model, input.reasoningEffort);
    const started = await this.client.request<ThreadStartResult>(
      "thread/start",
      {
        cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        experimentalRawEvents: false,
        persistExtendedHistory: true,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
      },
      60_000,
    );
    const thread = this.threadFromStart(started, input.title, cwd);
    this.remember(thread);
    this.currentId = thread.id;
    if (this.models.length === 0) {
      this.models = fallbackModelOption(thread.model, thread.reasoningEffort);
    }
    this.applyModelDefaults(thread.id);
    await this.refresh(thread.id).catch((error) => this.emit("log", `thread refresh skipped: ${error}`));
    this.emit("state");
    return this.requireThread(thread.id);
  }

  async selectThread(threadId: string) {
    if (!this.client || !this.ready) {
      throw new Error("Codex is not ready");
    }
    const id = threadId.trim();
    if (!id) {
      throw new Error("threadId is required");
    }
    if (!this.threads.has(id)) {
      throw new Error(`unknown thread: ${id}`);
    }
    this.currentId = id;
    await this.refresh(id);
    this.emit("state");
    return this.requireThread(id);
  }

  async prompt(text: string, threadId?: string) {
    const thread = threadId ? this.requireThread(threadId) : this.current;
    if (!this.client || !thread) {
      throw new Error("Codex is not ready");
    }
    const turn = await this.client.request<{ turn: { id: string } }>(
      "turn/start",
      {
        threadId: thread.id,
        input: [{ type: "text", text, text_elements: [] }],
        ...(thread.model ? { model: thread.model } : {}),
        ...(thread.reasoningEffort ? { effort: thread.reasoningEffort } : {}),
      },
      60_000,
    );
    this.remember({
      ...thread,
      status: "running",
      activeTurnId: turn.turn.id,
      updatedAt: new Date().toISOString(),
    });
    this.emit("state");
    await this.refresh(thread.id);
  }

  async interrupt(threadId?: string) {
    const thread = threadId ? this.requireThread(threadId) : this.current;
    if (!this.client || !thread?.activeTurnId) {
      return;
    }
    await this.client.request("turn/interrupt", {
      threadId: thread.id,
      turnId: thread.activeTurnId,
    });
    await this.refresh(thread.id);
  }

  async updateSettings(input: { model?: string; reasoningEffort?: string | null }, threadId?: string) {
    const thread = threadId ? this.requireThread(threadId) : this.current;
    if (!thread) {
      throw new Error("Codex is not ready");
    }
    const nextModel =
      typeof input.model === "string" && input.model.trim() ? input.model.trim() : thread.model;
    const nextEffort =
      input.reasoningEffort === undefined ? thread.reasoningEffort : mapReasoningEffort(input.reasoningEffort);
    this.remember({
      ...thread,
      model: nextModel,
      reasoningEffort: this.resolveEffort(nextModel, nextEffort),
      updatedAt: new Date().toISOString(),
    });
    this.applyModelDefaults(thread.id);
    this.emit("state");
  }

  async stop() {
    this.client?.close();
    this.child?.kill("SIGTERM");
    this.client = null;
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
      threads: this.listThreads(),
      models: this.models,
    };
  }

  private remember(thread: ThreadState) {
    this.threads.set(thread.id, thread);
  }

  private requireThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`unknown thread: ${threadId}`);
    }
    return thread;
  }

  private threadFromStart(started: ThreadStartResult, title: string | undefined, cwd: string): ThreadState {
    const now = new Date().toISOString();
    const model = started.model ?? started.thread.model ?? null;
    const reasoningEffort = mapReasoningEffort(started.reasoningEffort ?? started.reasoning_effort);
    const requestedTitle = title?.trim();
    return {
      id: started.thread.id,
      title: requestedTitle || started.thread.name?.trim() || basename(started.thread.cwd || cwd) || "Codex",
      cwd: started.thread.cwd || cwd,
      model,
      reasoningEffort,
      status: "idle",
      activeTurnId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
  }

  private resolveModel(requested?: string) {
    const model = requested?.trim();
    if (!model) {
      return this.models.find((entry) => entry.isDefault)?.model ?? this.models[0]?.model ?? null;
    }
    if (this.models.length > 0 && !this.models.some((entry) => entry.model === model)) {
      throw new Error(`unknown model: ${model}`);
    }
    return model;
  }

  private resolveEffort(model: string | null, requested?: string | null) {
    const option = this.models.find((entry) => entry.model === model) ?? null;
    let nextEffort = requested === undefined ? null : mapReasoningEffort(requested);
    if (!option) {
      return nextEffort;
    }
    const supported = option.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
    if (nextEffort && supported.length > 0 && !supported.includes(nextEffort)) {
      nextEffort = option.defaultReasoningEffort;
    }
    return nextEffort ?? option.defaultReasoningEffort;
  }

  private async loadModels() {
    if (!this.client) {
      return [] as ModelOption[];
    }
    const models: ModelOption[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.client.request<{
        data?: unknown[];
        nextCursor?: string | null;
        next_cursor?: string | null;
      }>("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      const batch = Array.isArray(response.data) ? response.data : [];
      for (const [index, entry] of batch.entries()) {
        const mapped = mapModelOption(entry, models.length + index);
        if (mapped && !mapped.hidden) {
          models.push(mapped);
        }
      }
      cursor = response.nextCursor ?? response.next_cursor ?? undefined;
    } while (cursor);
    return models;
  }

  private applyModelDefaults(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }
    const option =
      this.models.find((entry) => entry.model === thread.model) ??
      this.models.find((entry) => entry.isDefault) ??
      this.models[0] ??
      null;
    if (!option) {
      return;
    }
    this.remember({
      ...thread,
      model: thread.model ?? option.model,
      reasoningEffort: this.resolveEffort(thread.model ?? option.model, thread.reasoningEffort),
    });
  }

  private async refresh(threadId = this.currentId) {
    if (!this.client || !threadId) {
      return;
    }
    const existing = this.threads.get(threadId);
    if (!existing) {
      return;
    }
    try {
      const response = await this.client.request<{ thread: Record<string, unknown> }>("thread/read", {
        threadId,
        includeTurns: true,
      });
      const record = response.thread as {
        id?: string;
        name?: string | null;
        cwd?: string;
        status?: { type?: string; activeFlags?: string[] };
        turns?: Array<Record<string, unknown>>;
      };
      const turns = Array.isArray(record.turns) ? record.turns.map((turn) => mapTurn(turn)) : [];
      const active = turns.find((turn) => turn.status === "inProgress");
      const statusType = record.status && typeof record.status === "object" ? record.status.type : null;
      this.remember({
        ...existing,
        id: record.id ?? existing.id,
        title: record.name?.trim() || existing.title,
        cwd: record.cwd || existing.cwd,
        status: statusType === "active" || active ? "running" : statusType === "systemError" ? "error" : "idle",
        activeTurnId: active?.id ?? null,
        lastError: turns.find((turn) => turn.error)?.error ?? null,
        updatedAt: new Date().toISOString(),
        turns,
      });
      this.emit("state");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not materialized")) {
        this.emit("state");
        return;
      }
      throw error;
    }
  }

  private async onNotification(event: { method?: string; params?: Record<string, unknown> }) {
    const method = event.method ?? "";
    if (
      !(
        method.startsWith("turn/") ||
        method.startsWith("item/") ||
        method.startsWith("thread/") ||
        method === "error"
      )
    ) {
      return;
    }
    const threadId = eventThreadId(event.params) ?? this.currentId;
    try {
      await this.refresh(threadId);
    } catch (error) {
      this.emit("log", `refresh failed: ${error}`);
    }
  }
}

function eventThreadId(params?: Record<string, unknown>) {
  if (!params) {
    return null;
  }
  if (typeof params.threadId === "string" && params.threadId.trim()) {
    return params.threadId;
  }
  if (typeof params.thread_id === "string" && params.thread_id.trim()) {
    return params.thread_id;
  }
  const thread = params.thread;
  if (thread && typeof thread === "object" && typeof (thread as { id?: unknown }).id === "string") {
    return (thread as { id: string }).id;
  }
  return null;
}
