#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
NS_PORT="${CODEX_AGENT_UI_PORT:-4173}"
HEALTH="http://127.0.0.1:${NS_PORT}/api/health"
SURFACE="http://127.0.0.1:${NS_PORT}/.treer/agent"
BIND="http://127.0.0.1:${NS_PORT}/api/agents/bind"
INSTANCE_ID="${CODEX_AGENT_UI_INSTANCE_ID:-codex-ui-${TREER_AGENT_ID:-local}-$$}"
export CODEX_AGENT_UI_CWD="${CODEX_AGENT_UI_CWD:-$(pwd)}"
export CODEX_AGENT_UI_WEB_DIST="${CODEX_AGENT_UI_WEB_DIST:-$ROOT/apps/web/dist}"
export CODEX_AGENT_UI_PORT="$NS_PORT"
export CODEX_AGENT_UI_INSTANCE_ID="$INSTANCE_ID"
export TREER_AIS_INSTANCE_ID="$INSTANCE_ID"

export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell=bash)"
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

health_ok() {
  curl -sf "$HEALTH" >/dev/null 2>&1 && curl -sf "$SURFACE" >/dev/null 2>&1
}

bind_agent() {
  python3 - "$BIND" <<'PY'
import json, os, sys, urllib.error, urllib.request

url = sys.argv[1]
payload = json.dumps({"agentId": os.environ.get("TREER_AGENT_ID") or "local"}).encode()
req = urllib.request.Request(url, data=payload, headers={"content-type": "application/json"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        print(resp.read().decode())
except urllib.error.HTTPError as error:
    print(error.read().decode(), file=sys.stderr)
    raise
PY
}

register_ui() {
  if ! command -v treer >/dev/null 2>&1; then
    echo "treer CLI is not on PATH; cannot register Agent Interface" >&2
    exit 1
  fi
  treer interface register \
    --port "$NS_PORT" \
    --instance-id "$INSTANCE_ID" \
    --capability prompt.submit \
    --capability transcript.read \
    --capability state.observe \
    --capability abort \
    --ui-path /
  echo "registered Codex AIS $INSTANCE_ID on private port $NS_PORT"
}

keep_registered() {
  while [ "${1:-}" = "" ] || kill -0 "$1" 2>/dev/null; do
    if [ "${1:-}" = "" ] && ! health_ok; then
      return 0
    fi
    treer interface register \
      --port "$NS_PORT" \
      --instance-id "$INSTANCE_ID" \
      --capability prompt.submit \
      --capability transcript.read \
      --capability state.observe \
      --capability abort \
      --ui-path / >/dev/null 2>&1 || true
    sleep 20
    if [ "${1:-}" = "" ] && ! health_ok; then
      return 0
    fi
  done
}

wait_for_health() {
  i=0
  while [ "$i" -lt 180 ]; do
    if health_ok; then
      return 0
    fi
    if [ -n "${1:-}" ] && ! kill -0 "$1" 2>/dev/null; then
      return 1
    fi
    i=$((i + 1))
    sleep 0.5
  done
  return 1
}

attach_existing() {
  echo "attaching to existing Codex Agent UI on 127.0.0.1:${NS_PORT}"
  bind_agent
  register_ui
  keep_registered
  echo "shared Codex Agent UI listener is gone"
}

# Reuse one app-server + frontend when this Agent can reach an already
# healthy listener (same network namespace). Linux sandboxes usually cannot.
if health_ok; then
  attach_existing
  exit 0
fi

start_server &
SERVER_PID=$!
cleanup() {
  if command -v treer >/dev/null 2>&1; then
    treer interface clear >/dev/null 2>&1 || true
  fi
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if ! wait_for_health "$SERVER_PID"; then
  if health_ok; then
    trap - EXIT INT TERM
    attach_existing
    exit 0
  fi
  echo "Codex Agent UI did not become ready on port $NS_PORT" >&2
  exit 1
fi
echo "started Codex Agent UI on 127.0.0.1:${NS_PORT}"
bind_agent
register_ui
keep_registered "$SERVER_PID" &
wait "$SERVER_PID"
