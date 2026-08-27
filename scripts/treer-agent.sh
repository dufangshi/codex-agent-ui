#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ACP_AGENT="${ACP_AGENT:-codex}"
NS_PORT="${CODEX_AGENT_UI_PORT:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent)
      ACP_AGENT="$2"
      shift 2
      ;;
    --port)
      NS_PORT="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$ACP_AGENT" in
  grok) DEFAULT_PORT=4173; SERVER_CMD="grok agent stdio" ;;
  cursor) DEFAULT_PORT=4174; SERVER_CMD="cursor-agent acp" ;;
  claude) DEFAULT_PORT=4175; SERVER_CMD="claude-agent-acp" ;;
  codex) DEFAULT_PORT=4176; SERVER_CMD="codex-acp" ;;
  *)
    echo "unknown ACP agent: $ACP_AGENT (expected grok, cursor, claude, or codex)" >&2
    exit 2
    ;;
esac

NS_PORT="${NS_PORT:-$DEFAULT_PORT}"
HEALTH="http://127.0.0.1:${NS_PORT}/api/health"
INSTANCE_ID="${CODEX_AGENT_UI_INSTANCE_ID:-acp-${ACP_AGENT}-${TREER_AGENT_ID:-local}-$$}"
export ACP_AGENT
export ACP_COMMAND="${ACP_COMMAND:-$SERVER_CMD}"
export CODEX_AGENT_UI_CWD="${CODEX_AGENT_UI_CWD:-$(pwd)}"
export CODEX_AGENT_UI_WEB_DIST="${CODEX_AGENT_UI_WEB_DIST:-$ROOT/apps/web/dist}"
export CODEX_AGENT_UI_PORT="$NS_PORT"
export CODEX_AGENT_UI_INSTANCE_ID="$INSTANCE_ID"
export TREER_AIS_INSTANCE_ID="$INSTANCE_ID"

export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell=bash)"
fi
if [ -f "${HOME}/.grok/env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${HOME}/.grok/env"
  set +a
fi

if [ ! -f "$CODEX_AGENT_UI_WEB_DIST/index.html" ]; then
  echo "web dist missing; run: pnpm --dir $ROOT build" >&2
  exit 1
fi

start_server() {
  cd "$ROOT/apps/server"
  if [ ! -x "$ROOT/apps/server/node_modules/.bin/tsx" ] || [ ! -f "$ROOT/apps/server/node_modules/ws/package.json" ]; then
    echo "server dependencies missing; run scripts/apply.sh first" >&2
    exit 1
  fi
  "$ROOT/apps/server/node_modules/.bin/tsx" src/index.ts
}

start_server &
SERVER_PID=$!
cleanup() {
  if command -v treer >/dev/null 2>&1; then
    treer interface clear >/dev/null 2>&1 || true
  fi
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

health_matches() {
  curl -sf "$HEALTH" | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("harness")==sys.argv[1] else 1)' "$ACP_AGENT" 2>/dev/null
}

i=0
while [ "$i" -lt 180 ]; do
  if health_matches; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ACP UI server exited before becoming healthy" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 0.5
done
if ! curl -sf "$HEALTH" >/dev/null 2>&1; then
  echo "ACP UI did not become ready on port $NS_PORT" >&2
  exit 1
fi
echo "started ACP UI ($ACP_AGENT) on 127.0.0.1:${NS_PORT}"

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
echo "registered ACP AIS $INSTANCE_ID on private port $NS_PORT"

wait "$SERVER_PID"
