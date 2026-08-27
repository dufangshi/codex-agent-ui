import type * as acp from "@agentclientprotocol/sdk";

import type { HistoryItem, TurnDto } from "./map.js";

export class AcpTurnMapper {
  private readonly items = new Map<string, HistoryItem>();
  private readonly order: string[] = [];
  private agentIndex = 0;
  private thoughtIndex = 0;
  private currentAgentId: string | null = null;
  private currentThoughtId: string | null = null;

  constructor(
    readonly turnId: string,
    initial: HistoryItem[] = [],
  ) {
    for (const item of initial) this.upsert(item);
  }

  snapshot(status: TurnDto["status"] = "inProgress", error: string | null = null): TurnDto {
    return {
      id: this.turnId,
      startedAt: null,
      status,
      error,
      items: this.order.map((id) => this.items.get(id)!).filter(Boolean),
    };
  }

  apply(update: acp.SessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        this.finishThought();
        const delta = contentText(update.content);
        const id = this.currentAgentId ?? `${this.turnId}:agent:${++this.agentIndex}`;
        this.currentAgentId = id;
        const current = this.items.get(id);
        this.upsert({
          id,
          kind: "agentMessage",
          text: `${current?.text ?? ""}${delta}`,
          status: "running",
          sourceTurnId: this.turnId,
        });
        return;
      }
      case "agent_thought_chunk": {
        this.finishAgent();
        const delta = contentText(update.content);
        const id = this.currentThoughtId ?? `${this.turnId}:thought:${++this.thoughtIndex}`;
        this.currentThoughtId = id;
        const current = this.items.get(id);
        this.upsert({
          id,
          kind: "reasoning",
          text: `${current?.text ?? ""}${delta}`,
          status: "running",
          sourceTurnId: this.turnId,
        });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        this.finishOpen();
        const toolCallId = "toolCallId" in update ? update.toolCallId : "";
        const title = ("title" in update ? update.title : undefined)
          || ("name" in update ? update.name : undefined)
          || "Tool call";
        const kind = toolKind("kind" in update ? update.kind ?? undefined : undefined, title);
        this.upsert({
          id: toolCallId || `${this.turnId}:tool:${this.order.length}`,
          kind,
          text: title,
          status: mappedStatus("status" in update ? update.status ?? undefined : undefined),
          sourceTurnId: this.turnId,
        });
        return;
      }
      case "plan": {
        this.finishOpen();
        this.upsert({
          id: `${this.turnId}:plan`,
          kind: "other",
          text: update.entries.map((entry) => `- [${entry.status === "completed" ? "x" : " "}] ${entry.content}`).join("\n"),
          status: update.entries.every((entry) => entry.status === "completed") ? "completed" : "running",
          sourceTurnId: this.turnId,
        });
        return;
      }
      default:
        return;
    }
  }

  complete(status: TurnDto["status"], error: string | null = null) {
    this.finishOpen();
    for (const item of this.items.values()) {
      if (item.status === "running") item.status = status === "failed" ? "failed" : "completed";
    }
    return this.snapshot(status, error);
  }

  private upsert(item: HistoryItem) {
    if (!this.items.has(item.id)) this.order.push(item.id);
    this.items.set(item.id, item);
  }

  private finishAgent() {
    if (this.currentAgentId) {
      const item = this.items.get(this.currentAgentId);
      if (item) item.status = "completed";
      this.currentAgentId = null;
    }
  }

  private finishThought() {
    if (this.currentThoughtId) {
      const item = this.items.get(this.currentThoughtId);
      if (item) item.status = "completed";
      this.currentThoughtId = null;
    }
  }

  private finishOpen() {
    this.finishAgent();
    this.finishThought();
  }
}

function contentText(content: acp.ContentBlock) {
  if (content.type === "text") return content.text;
  if (content.type === "resource_link") return content.uri;
  return "";
}

function toolKind(kind: string | undefined, title: string): HistoryItem["kind"] {
  const name = `${kind ?? ""} ${title}`.toLowerCase();
  if (kind === "execute" || name.includes("command") || name.includes("shell")) return "commandExecution";
  if (kind === "edit" || kind === "delete" || kind === "move") return "fileChange";
  if (kind === "think") return "reasoning";
  return "toolCall";
}

function mappedStatus(status: string | undefined) {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "running";
}
