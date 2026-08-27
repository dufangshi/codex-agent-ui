import { parseCommandLine, resolveExecutable, runProcess } from "./process.js";

export type AcpTransport = "native" | "adapter";
export type AcpAvailability = "ready" | "base_missing" | "adapter_missing" | "server_unavailable";

export interface AcpAgentDefinition {
  id: string;
  displayName: string;
  description: string;
  transport: AcpTransport;
  baseCommand: string;
  baseProbeCommand: string;
  serverCommand: string;
  serverProbeCommand: string;
  installCommand: string | null;
  defaultPort: number;
}

export interface AcpAgentCatalogEntry extends AcpAgentDefinition {
  availability: AcpAvailability;
  baseVersion: string | null;
  serverVersion: string | null;
  statusMessage: string;
}

export const builtinAcpAgents: AcpAgentDefinition[] = [
  {
    id: "grok",
    displayName: "Grok Build",
    description: "xAI Grok coding agent with native ACP support.",
    transport: "native",
    baseCommand: "grok",
    baseProbeCommand: "grok --version",
    serverCommand: "grok agent stdio",
    serverProbeCommand: "grok agent stdio --help",
    installCommand: null,
    defaultPort: 4173,
  },
  {
    id: "cursor",
    displayName: "Cursor Agent",
    description: "Cursor CLI coding agent with native ACP support.",
    transport: "native",
    baseCommand: "cursor-agent",
    baseProbeCommand: "cursor-agent --version",
    serverCommand: "cursor-agent acp",
    serverProbeCommand: "cursor-agent acp --help",
    installCommand: null,
    defaultPort: 4174,
  },
  {
    id: "claude",
    displayName: "Claude Code",
    description: "Claude Code connected through the Claude Agent ACP adapter.",
    transport: "adapter",
    baseCommand: "claude",
    baseProbeCommand: "claude --version",
    serverCommand: "claude-agent-acp",
    serverProbeCommand: "claude-agent-acp --version",
    installCommand: "npm install -g @agentclientprotocol/claude-agent-acp@latest",
    defaultPort: 4175,
  },
  {
    id: "codex",
    displayName: "OpenAI Codex",
    description: "Local Codex CLI connected through the ACP adapter.",
    transport: "adapter",
    baseCommand: "codex",
    baseProbeCommand: "codex --version",
    serverCommand: "codex-acp",
    serverProbeCommand: "codex-acp --version",
    installCommand: "npm install -g @agentclientprotocol/codex-acp@latest",
    defaultPort: 4176,
  },
];

function firstLine(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

async function probe(commandLine: string) {
  const parsed = parseCommandLine(commandLine);
  const executable = await resolveExecutable(parsed.command);
  if (!executable) {
    return { available: false, version: null, error: `missing executable: ${parsed.command}` };
  }
  const result = await runProcess({
    command: parsed.command,
    args: parsed.args,
    timeoutMs: 8_000,
  });
  return {
    available: result.code === 0,
    version: result.code === 0 ? firstLine(result.stdout) ?? firstLine(result.stderr) : null,
    error: result.code === 0 ? null : firstLine(result.stderr) ?? firstLine(result.stdout),
  };
}

export function resolveAcpAgent(id: string) {
  const definition = builtinAcpAgents.find((entry) => entry.id === id);
  if (!definition) {
    throw new Error(`Unknown ACP agent: ${id}. Expected one of ${builtinAcpAgents.map((entry) => entry.id).join(", ")}`);
  }
  return definition;
}

export async function inspectAcpAgent(id: string): Promise<AcpAgentCatalogEntry> {
  const definition = resolveAcpAgent(id);
  const base = await probe(definition.baseProbeCommand);
  if (!base.available) {
    return {
      ...definition,
      availability: "base_missing",
      baseVersion: null,
      serverVersion: null,
      statusMessage: `Install the base agent first. Probe: ${definition.baseProbeCommand}`,
    };
  }
  if (definition.transport === "adapter" && !(await resolveExecutable(parseCommandLine(definition.serverCommand).command))) {
    return {
      ...definition,
      availability: "adapter_missing",
      baseVersion: base.version,
      serverVersion: null,
      statusMessage: `Base agent detected. Install its ACP adapter: ${definition.installCommand}`,
    };
  }
  const server = await probe(definition.serverProbeCommand);
  if (!server.available) {
    return {
      ...definition,
      availability: "server_unavailable",
      baseVersion: base.version,
      serverVersion: null,
      statusMessage: server.error ?? `ACP server probe failed: ${definition.serverProbeCommand}`,
    };
  }
  return {
    ...definition,
    availability: "ready",
    baseVersion: base.version,
    serverVersion: server.version,
    statusMessage: `Ready. ACP command: ${definition.serverCommand}`,
  };
}

export async function ensureAcpAdapter(id: string) {
  let current = await inspectAcpAgent(id);
  if (current.availability === "base_missing") {
    throw new Error(current.statusMessage);
  }
  if (current.availability === "adapter_missing") {
    if (!current.installCommand) {
      throw new Error(`${current.displayName} needs an ACP adapter, but no install command is configured.`);
    }
    const parsed = parseCommandLine(current.installCommand);
    const result = await runProcess({
      command: parsed.command,
      args: parsed.args,
      timeoutMs: 180_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    if (result.code !== 0) {
      throw new Error(firstLine(result.stderr) ?? firstLine(result.stdout) ?? `${current.installCommand} failed`);
    }
    current = await inspectAcpAgent(id);
  }
  if (current.availability !== "ready") {
    throw new Error(current.statusMessage);
  }
  return current;
}
