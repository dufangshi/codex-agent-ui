import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { loadAcpSpawnEnvironment } from "./acp-environment.js";
import { spawnProcess } from "./process.js";

export type LoginStatus = "idle" | "running" | "succeeded" | "failed";

export interface AcpLoginSnapshot {
  available: boolean;
  status: LoginStatus;
  output: string;
  urls: string[];
  deviceCode: string | null;
  error: string | null;
}

const LOGIN_COMMANDS: Record<string, { command: string; args: string[]; env?: NodeJS.ProcessEnv }> = {
  grok: { command: "grok", args: ["login", "--device-auth"] },
  codex: { command: "codex", args: ["login", "--device-auth"] },
  cursor: { command: "cursor-agent", args: ["login"], env: { NO_OPEN_BROWSER: "1" } },
  claude: { command: "claude", args: ["auth", "login"], env: { BROWSER: "echo" } },
};

const MAX_OUTPUT = 64 * 1024;

function cleanTerminalOutput(value: string) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

export function extractLoginUrls(value: string) {
  const urls = cleanTerminalOutput(value).match(/https?:\/\/[^\s<>"']+/g) ?? [];
  return [...new Set(urls.map((url) => url.replace(/[),.;]+$/, "")))];
}

export function extractDeviceCode(value: string) {
  const text = cleanTerminalOutput(value);
  const labelled = text.match(/(?:(?:device|user|authorization)\s+code|confirm\s+(?:this\s+)?code(?:\s+in\s+your\s+browser)?)\s*[:：]?\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  if (labelled?.[1]) return labelled[1];
  for (const url of extractLoginUrls(text)) {
    try {
      const code = new URL(url).searchParams.get("user_code");
      if (code) return code;
    } catch {
      // Continue scanning other links.
    }
  }
  return null;
}

export class AcpLoginService extends EventEmitter {
  private child: ChildProcess | null = null;
  private status: LoginStatus = "idle";
  private output = "";
  private error: string | null = null;
  private agentId = "";

  constructor(
    private readonly harnessId: string,
    private readonly cwd: string,
    private readonly onSuccess: (agentId: string) => Promise<void>,
  ) {
    super();
  }

  snapshot(): AcpLoginSnapshot {
    return {
      available: Boolean(LOGIN_COMMANDS[this.harnessId]),
      status: this.status,
      output: this.output,
      urls: extractLoginUrls(this.output),
      deviceCode: extractDeviceCode(this.output),
      error: this.error,
    };
  }

  async start(agentId: string) {
    const definition = LOGIN_COMMANDS[this.harnessId];
    if (!definition) throw new Error(`Login is not configured for ${this.harnessId}`);
    if (this.child && this.status === "running") return this.snapshot();

    const loaded = await loadAcpSpawnEnvironment();
    this.agentId = agentId;
    this.status = "running";
    this.output = "";
    this.error = null;
    const child = spawnProcess({
      command: definition.command,
      args: definition.args,
      cwd: this.cwd,
      env: { ...loaded.env, ...definition.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const append = (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      this.output = cleanTerminalOutput(`${this.output}${text}`).slice(-MAX_OUTPUT);
      this.emit("state");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (reason) => {
      this.error = reason.message;
      this.status = "failed";
      this.child = null;
      this.emit("state");
    });
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.child = null;
      void this.finish(code);
    });
    this.emit("state");
    return this.snapshot();
  }

  submit(value: string) {
    if (!this.child?.stdin || this.status !== "running") {
      throw new Error("No login is waiting for input");
    }
    this.child.stdin.write(`${value}\n`);
  }

  cancel() {
    if (this.child) {
      const child = this.child;
      this.child = null;
      child.kill("SIGTERM");
    }
    this.status = "idle";
    this.output = "";
    this.error = null;
    this.emit("state");
  }

  private async finish(code: number | null) {
    if (code !== 0) {
      this.status = "failed";
      this.error = `Login exited with status ${code ?? "unknown"}`;
      this.emit("state");
      return;
    }
    try {
      await this.onSuccess(this.agentId);
      this.status = "succeeded";
      this.error = null;
    } catch (reason) {
      this.status = "failed";
      this.error = reason instanceof Error ? reason.message : String(reason);
    }
    this.emit("state");
  }
}
