import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import type * as acp from "@agentclientprotocol/sdk";

import { parseCommandLine, spawnProcess } from "./process.js";

interface TerminalState {
  child: ChildProcess;
  chunks: Buffer[];
  outputByteLimit: number;
  exitStatus: acp.TerminalExitStatus | null;
  exitPromise: Promise<acp.WaitForTerminalExitResponse>;
  resolveExit: (status: acp.WaitForTerminalExitResponse) => void;
}

export class AcpTerminalService {
  private readonly terminals = new Map<string, TerminalState>();

  constructor(private readonly sessionCwd: (sessionId: string) => string | null) {}

  create(params: acp.CreateTerminalRequest): acp.CreateTerminalResponse {
    const terminalId = randomUUID();
    const cwd = params.cwd ?? this.sessionCwd(params.sessionId) ?? process.cwd();
    const parsed = params.args && params.args.length > 0
      ? { command: params.command, args: params.args }
      : parseCommandLine(params.command);
    const child = spawnProcess({
      command: parsed.command,
      args: parsed.args,
      cwd,
      env: {
        ...process.env,
        ...Object.fromEntries((params.env ?? []).map((entry) => [entry.name, entry.value])),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolveExit!: (status: acp.WaitForTerminalExitResponse) => void;
    const exitPromise = new Promise<acp.WaitForTerminalExitResponse>((resolve) => {
      resolveExit = resolve;
    });
    const state: TerminalState = {
      child,
      chunks: [],
      outputByteLimit: Math.max(1, params.outputByteLimit ?? 1024 * 1024),
      exitStatus: null,
      exitPromise,
      resolveExit,
    };
    this.terminals.set(terminalId, state);
    const append = (chunk: Buffer | string) => {
      state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("close", (code, signal) => {
      const exitStatus: acp.TerminalExitStatus = {
        exitCode: code,
        signal,
      };
      state.exitStatus = exitStatus;
      state.resolveExit({ exitCode: code, signal });
    });
    return { terminalId };
  }

  output(params: acp.TerminalOutputRequest): acp.TerminalOutputResponse {
    const state = this.require(params.terminalId);
    const complete = Buffer.concat(state.chunks);
    const truncated = complete.byteLength > state.outputByteLimit;
    const output = truncated
      ? complete.subarray(complete.byteLength - state.outputByteLimit).toString("utf8")
      : complete.toString("utf8");
    return { output, truncated, exitStatus: state.exitStatus };
  }

  waitForExit(params: acp.WaitForTerminalExitRequest) {
    return this.require(params.terminalId).exitPromise;
  }

  async kill(params: acp.KillTerminalRequest) {
    this.require(params.terminalId).child.kill("SIGTERM");
    return {};
  }

  async release(params: acp.ReleaseTerminalRequest) {
    const state = this.terminals.get(params.terminalId);
    if (!state) return {};
    state.child.kill("SIGTERM");
    this.terminals.delete(params.terminalId);
    return {};
  }

  stop() {
    for (const state of this.terminals.values()) state.child.kill("SIGTERM");
    this.terminals.clear();
  }

  private require(terminalId: string) {
    const state = this.terminals.get(terminalId);
    if (!state) throw new Error(`unknown terminal: ${terminalId}`);
    return state;
  }
}
