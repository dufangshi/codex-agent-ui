export const LOCAL_AGENT_ID = "local";

export function defaultAgentId(env = process.env) {
  const fromEnv = env.TREER_AGENT_ID?.trim();
  return fromEnv || LOCAL_AGENT_ID;
}

export function resolveAgentId(input: {
  query?: string | null;
  header?: string | null;
  body?: string | null;
  fallback?: string;
}) {
  const candidates = [input.query, input.header, input.body, input.fallback];
  for (const value of candidates) {
    const next = value?.trim();
    if (next) {
      return next;
    }
  }
  return defaultAgentId();
}
