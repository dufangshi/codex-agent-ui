import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

export interface ParsedCommandLine {
  command: string;
  args: string[];
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function parseCommandLine(value: string): ParsedCommandLine {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote === "'") {
      if (character === "'") quote = null;
      else token += character;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else token += character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    token += character;
    started = true;
  }
  if (quote) throw new Error("unterminated quote in command");
  if (started) tokens.push(token);
  const [command, ...args] = tokens;
  if (!command) throw new Error("command is empty");
  return { command, args };
}

export async function resolveExecutable(command: string) {
  if (command.includes("/") || command.includes("\\")) {
    try {
      await access(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function spawnProcess(options: {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: SpawnOptions["stdio"];
}): ChildProcess {
  return spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? "pipe",
    shell: false,
  });
}

export function runProcess(options: {
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawnProcess({ ...options, stdio: ["ignore", "pipe", "pipe"] });
    const max = options.maxOutputBytes ?? 256 * 1024;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const append = (current: Buffer, chunk: Buffer) =>
      Buffer.concat([current, chunk]).subarray(0, max);
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
      : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout: "", stderr: error.message });
    });
  });
}
