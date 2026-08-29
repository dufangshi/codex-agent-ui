import { homedir } from "node:os";
import { join } from "node:path";
import { access, readFile } from "node:fs/promises";

export interface AdvertisedAuthMethod {
  id: string;
  type?: string;
}

export interface AcpEnvironmentLoad {
  env: NodeJS.ProcessEnv;
  sources: string[];
  hasChatGptSession: boolean;
  hasGrokSession: boolean;
  hasCursorSession: boolean;
  hasClaudeSession: boolean;
}

const INTERACTIVE_AUTH_IDS = new Set(["grok.com", "browser", "terminal"]);

export function parseExportEnvFile(text: string) {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = body.indexOf("=");
    if (separator <= 0) continue;
    const key = body.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function firstPresent(...values: Array<string | undefined>) {
  return values.find((value) => Boolean(value?.trim()))?.trim() || "";
}

export function selectAcpAuthMethodIds(input: {
  harnessId: string;
  advertised: AdvertisedAuthMethod[];
  env: NodeJS.ProcessEnv;
  hasChatGptSession?: boolean;
  hasGrokSession?: boolean;
  hasCursorSession?: boolean;
  hasClaudeSession?: boolean;
}) {
  const advertised = input.advertised.filter((entry) => {
    if (!entry?.id) return false;
    if (entry.type === "terminal") return false;
    return !INTERACTIVE_AUTH_IDS.has(entry.id);
  });
  const advertisedIds = advertised.map((entry) => entry.id);
  const has = (id: string) => advertisedIds.includes(id);
  const hasXai = Boolean(firstPresent(input.env.XAI_API_KEY, input.env.GROK_CODE_XAI_API_KEY));
  const hasOpenAi = Boolean(firstPresent(input.env.OPENAI_API_KEY, input.env.CODEX_API_KEY));
  const hasAnthropic = Boolean(firstPresent(
    input.env.ANTHROPIC_API_KEY,
    input.env.CLAUDE_CODE_OAUTH_TOKEN,
  ));
  let candidates: Array<string | null>;
  switch (input.harnessId) {
    case "grok":
      candidates = [
        has("none") ? "none" : null,
        hasXai && has("xai.api_key") ? "xai.api_key" : null,
        input.hasGrokSession && has("cached_token") ? "cached_token" : null,
      ];
      break;
    case "codex":
      candidates = [
        has("none") ? "none" : null,
        hasOpenAi && has("api-key") ? "api-key" : null,
        input.hasChatGptSession && (has("chat-gpt") || has("chatgpt"))
          ? (has("chat-gpt") ? "chat-gpt" : "chatgpt")
          : null,
      ];
      break;
    case "cursor":
      candidates = [
        has("none") ? "none" : null,
        input.hasCursorSession && has("cursor_login") ? "cursor_login" : null,
      ];
      break;
    case "claude":
      candidates = [
        has("none") ? "none" : null,
        (input.hasClaudeSession || hasAnthropic) && has("cached_token") ? "cached_token" : null,
        hasAnthropic && has("api-key") ? "api-key" : null,
      ];
      break;
    default:
      candidates = [has("none") ? "none" : null];
  }
  const ordered = candidates;
  return ordered.filter((id, index): id is string =>
    Boolean(id) && ordered.indexOf(id) === index,
  );
}

async function readText(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadAcpSpawnEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  home = inherited.HOME || homedir(),
): Promise<AcpEnvironmentLoad> {
  const env: NodeJS.ProcessEnv = { ...inherited };
  const sources: string[] = [];
  let hasChatGptSession = false;
  const hasGrokSession = await pathExists(join(home, ".grok", "auth.json"));
  const hasCursorSession = await pathExists(join(home, ".cursor", "cli-config.json"));
  const hasClaudeSession = await pathExists(join(home, ".claude", ".credentials.json"));

  const grokEnvPath = join(home, ".grok", "env");
  const grokEnvText = await readText(grokEnvPath);
  if (grokEnvText) {
    const parsed = parseExportEnvFile(grokEnvText);
    for (const [key, value] of Object.entries(parsed)) {
      if (!env[key]) env[key] = value;
    }
    sources.push(grokEnvPath);
  }

  const codexHome = firstPresent(env.CODEX_HOME) || join(home, ".codex");
  env.HOME = home;
  env.CODEX_HOME = codexHome;
  env.CODEX_PATH = firstPresent(env.CODEX_PATH) || "codex";
  sources.push("CODEX_HOME");

  const authText = await readText(join(codexHome, "auth.json"));
  if (authText) {
    try {
      const auth = JSON.parse(authText) as {
        OPENAI_API_KEY?: unknown;
        tokens?: { access_token?: unknown; refresh_token?: unknown };
      };
      if (!env.OPENAI_API_KEY && typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim()) {
        env.OPENAI_API_KEY = auth.OPENAI_API_KEY.trim();
        sources.push("codex auth.json");
      }
      hasChatGptSession = Boolean(
        (typeof auth.tokens?.access_token === "string" && auth.tokens.access_token)
        || (typeof auth.tokens?.refresh_token === "string" && auth.tokens.refresh_token),
      );
    } catch {
      // Codex can still start; authenticate will fail with a clear ACP error.
    }
  }

  return {
    env,
    sources,
    hasChatGptSession,
    hasGrokSession,
    hasCursorSession,
    hasClaudeSession,
  };
}
