/** Resolve against <base href="./"> so Treer's iframe proxy prefix is preserved. */
function pageBase() {
  return document.baseURI || window.location.href;
}

function resolveUrl(path: string) {
  return new URL(path.replace(/^\//, ""), pageBase()).toString();
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveUrl(path), {
    ...init,
    headers: {
      "content-type": "application/json",
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
