#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
NS_PORT="${CODEX_AGENT_UI_PORT:-4173}"
HEALTH="http://127.0.0.1:${NS_PORT}/api/health"
SURFACE="http://127.0.0.1:${NS_PORT}/.treer/agent"
export CODEX_AGENT_UI_CWD="${CODEX_AGENT_UI_CWD:-$(pwd)}"
export CODEX_AGENT_UI_WEB_DIST="${CODEX_AGENT_UI_WEB_DIST:-$ROOT/apps/web/dist}"
export CODEX_AGENT_UI_PORT="$NS_PORT"

export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell=sh)"
fi
if command -v codex >/dev/null 2>&1; then
  export CODEX_BIN="$(command -v codex)"
fi

if [ ! -f "$CODEX_AGENT_UI_WEB_DIST/index.html" ]; then
  echo "web dist missing; run: pnpm --dir $ROOT build" >&2
  exit 1
fi

start_server() {
  if command -v pnpm >/dev/null 2>&1 && [ -f "$ROOT/pnpm-workspace.yaml" ] && [ -d "$ROOT/node_modules" ]; then
    cd "$ROOT"
    pnpm --filter @codex-agent-ui/server start
    return
  fi
  cd "$ROOT/apps/server"
  if [ ! -x "$ROOT/apps/server/node_modules/.bin/tsx" ] || [ ! -f "$ROOT/apps/server/node_modules/ws/package.json" ]; then
    echo "server dependencies missing; run scripts/apply.sh first" >&2
    exit 1
  fi
  "$ROOT/apps/server/node_modules/.bin/tsx" src/index.ts
}

# Always start inside this Agent process. Reusing a host listener would
# bypass the Linux network sandbox.
start_server &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

i=0
while [ "$i" -lt 180 ]; do
  if curl -sf "$HEALTH" >/dev/null 2>&1 && curl -sf "$SURFACE" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Codex Agent UI server exited before becoming healthy" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 0.5
done
if ! curl -sf "$HEALTH" >/dev/null 2>&1 || ! curl -sf "$SURFACE" >/dev/null 2>&1; then
  echo "Codex Agent UI did not become ready on port $NS_PORT" >&2
  exit 1
fi
echo "started Codex Agent UI on 127.0.0.1:${NS_PORT}"

if ! command -v treer >/dev/null 2>&1; then
  echo "treer CLI is not on PATH; cannot register Agent UI" >&2
  exit 1
fi

# Treer's iframe tunnel reaches this listener through the Agent-scoped Unix
# bridge. Do not register a host-loopback machine service; that older path
# required --publish and is not the current embed spec.
SERVICE_NAME="${CODEX_AGENT_UI_SERVICE:-codex-ui}"
register() {
  treer network service create "$1" --agent self --port "$NS_PORT" --protocol http
}

if ! register "$SERVICE_NAME"; then
  SERVICE_NAME="${CODEX_AGENT_UI_SERVICE:-codex-ui}-${TREER_AGENT_ID:-$$}"
  register "$SERVICE_NAME"
fi
treer ui set "$SERVICE_NAME"
echo "registered Treer Agent UI for Agent-scoped service $SERVICE_NAME on ns port $NS_PORT"

wait "$SERVER_PID"
