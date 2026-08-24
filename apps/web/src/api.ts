/** Resolve against <base href="./"> so Treer's iframe proxy prefix is preserved. */
function pageBase() {
  return document.baseURI || window.location.href;
}

export function treerAgentId() {
  try {
    const href = pageBase();
    const match = href.match(/\/agents\/([^/?#]+)\/ui\/proxy/);
    if (match?.[1]) {
      return match[1];
    }
    return new URL(href).searchParams.get("agent")?.trim() || "";
  } catch {
    return "";
  }
}

function resolveUrl(path: string) {
  const url = new URL(path.replace(/^\//, ""), pageBase());
  const agent = treerAgentId();
  if (agent && !url.searchParams.get("agent")) {
    url.searchParams.set("agent", agent);
  }
  return url.toString();
}

function agentHeaders(): Record<string, string> {
  const agent = treerAgentId();
  return agent ? { "x-treer-agent-id": agent } : {};
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveUrl(path), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...agentHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return (await response.json()) as T;
}

export function connectEvents(onMessage: (data: unknown) => void) {
  const url = new URL("ws", pageBase());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const agent = treerAgentId();
  if (agent) {
    url.searchParams.set("agent", agent);
  }
  const socket = new WebSocket(url);
  socket.onmessage = (event) => {
    try {
      onMessage(JSON.parse(String(event.data)));
    } catch {
      // ignore malformed frames
    }
  };
  return socket;
}
