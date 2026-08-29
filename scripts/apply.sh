#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
AGENTS="${ACP_AGENT:-}"
LIST_ONLY=
INSTALL_MISSING=
[ -n "$AGENTS" ] && INSTALL_MISSING=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)
      echo "--name is derived from --agent; ignoring $2" >&2
      shift 2
      ;;
    --dir)
      ROOT="$(CDPATH= cd -- "$2" && pwd)"
      shift 2
      ;;
    --agent)
      INSTALL_MISSING=1
      if [ -n "$AGENTS" ]; then
        AGENTS="$AGENTS $2"
      else
        AGENTS="$2"
      fi
      shift 2
      ;;
    --agents)
      INSTALL_MISSING=1
      AGENTS=$(printf '%s' "$2" | tr ',+' ' ')
      shift 2
      ;;
    --list)
      LIST_ONLY=1
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$ROOT/treer-agent.json" ]; then
  echo "missing $ROOT/treer-agent.json" >&2
  exit 1
fi

"$ROOT/scripts/map-host-harness-state.sh"
export PATH="${HOME}/.grok/bin:${HOME}/.local/bin:${HOME}/.npm-global/bin:${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell=bash)"
fi

if [ "${LIST_ONLY:-}" = "1" ]; then
  python3 - <<'PY'
import json, shutil
supported = ["grok", "cursor", "claude", "codex"]
base = {"grok": "grok", "cursor": "cursor-agent", "claude": "claude", "codex": "codex"}
ready = [agent for agent in supported if shutil.which(base[agent])]
print(json.dumps({"supported": supported, "ready": ready}, indent=2))
PY
  exit 0
fi
if [ ! -f "$ROOT/apps/web/dist/index.html" ]; then
  echo "missing tracked web dist; this checkout cannot start without a build" >&2
  exit 1
fi
if ! command -v treer >/dev/null 2>&1; then
  echo "treer CLI is not on PATH" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not on PATH" >&2
  exit 1
fi

echo "installing server dependencies in $ROOT/apps/server"
rm -rf "$ROOT/apps/server/node_modules"
npm --prefix "$ROOT/apps/server" install --install-strategy=nested --no-workspaces
if [ ! -f "$ROOT/apps/server/node_modules/ws/package.json" ] \
  || [ ! -x "$ROOT/apps/server/node_modules/.bin/tsx" ] \
  || [ ! -d "$ROOT/apps/server/node_modules/@agentclientprotocol/sdk" ]; then
  echo "server dependencies did not install into $ROOT/apps/server/node_modules" >&2
  exit 1
fi

WHOAMI="$(treer whoami)"
echo "$WHOAMI"
if ! printf '%s' "$WHOAMI" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1; then
  echo "treer whoami did not return JSON; this process is not a managed Agent" >&2
  exit 1
fi

AGENT_CWD="$(python3 -c 'import json, os, sys
root = os.path.abspath(sys.argv[1])
whoami = json.loads(sys.argv[2])
host = os.path.abspath(whoami["machine"]["root"])
rel = os.path.relpath(root, host)
if rel.startswith("..") or os.path.isabs(rel):
    raise SystemExit("checkout %s is outside host root %s" % (root, host))
print(rel)
' "$ROOT" "$WHOAMI")"

base_command() {
  case "$1" in
    grok) echo grok ;;
    cursor) echo cursor-agent ;;
    claude) echo claude ;;
    codex) echo codex ;;
    *) return 1 ;;
  esac
}

server_command() {
  case "$1" in
    grok) echo grok ;;
    cursor) echo cursor-agent ;;
    claude) echo claude-agent-acp ;;
    codex) echo codex-acp ;;
    *) return 1 ;;
  esac
}

adapter_install() {
  case "$1" in
    claude) echo "npm install -g @agentclientprotocol/claude-agent-acp@latest" ;;
    codex) echo "npm install -g @agentclientprotocol/codex-acp@latest" ;;
    *) echo "" ;;
  esac
}

install_base() {
  case "$1" in
    grok)
      npm install --prefix "${HOME}/.npm-global" -g @xai-official/grok@latest
      ;;
    cursor)
      curl -fsSL https://cursor.com/install | sh
      ;;
    claude)
      npm install --prefix "${HOME}/.npm-global" -g @anthropic-ai/claude-code@latest
      ;;
    codex)
      npm install --prefix "${HOME}/.npm-global" -g @openai/codex@latest
      ;;
    *) return 1 ;;
  esac
}

profile_name() {
  case "$1" in
    grok) echo "ACP Grok" ;;
    cursor) echo "ACP Cursor" ;;
    claude) echo "ACP Claude" ;;
    codex) echo "ACP Codex" ;;
    *) echo "ACP $1" ;;
  esac
}

ensure_adapter() {
  agent="$1"
  base="$(base_command "$agent")"
  server="$(server_command "$agent")"
  install="$(adapter_install "$agent")"
  if ! command -v "$base" >/dev/null 2>&1; then
    if [ "${INSTALL_MISSING:-}" = "1" ]; then
      echo "installing base CLI for $agent"
      install_base "$agent"
    else
      echo "skipping $agent: base CLI '$base' is not on PATH" >&2
      return 1
    fi
  fi
  if ! command -v "$base" >/dev/null 2>&1; then
    echo "base CLI '$base' is still missing after install" >&2
    return 1
  fi
  if [ -n "$install" ] && ! command -v "$server" >/dev/null 2>&1; then
    echo "installing ACP adapter for $agent: $install"
    sh -c "$install"
  fi
  if ! command -v "$server" >/dev/null 2>&1; then
    echo "ACP server '$server' is still missing for $agent" >&2
    return 1
  fi
  echo "ACP $agent is ready (base=$base server=$server)"
  return 0
}

SELECTED=""
if [ -z "$AGENTS" ] || [ "$AGENTS" = "all" ]; then
  for candidate in grok cursor claude codex; do
    if ensure_adapter "$candidate"; then
      SELECTED="$SELECTED $candidate"
    fi
  done
else
  for candidate in $AGENTS; do
    ensure_adapter "$candidate"
    SELECTED="$SELECTED $candidate"
  done
fi
SELECTED=$(printf '%s' "$SELECTED" | xargs)
if [ -z "$SELECTED" ]; then
  echo "no ACP agents are available; install grok, cursor-agent, claude, or codex first" >&2
  exit 1
fi

upsert_and_start() {
  agent="$1"
  name="acp-$agent"
  profile="$(profile_name "$agent")"
  description="Treer iframe UI over Agent Client Protocol for $(profile_name "$agent")."
  echo "saving launch profile $profile with cwd $AGENT_CWD"
  python3 - "$profile" "$description" "$AGENT_CWD" "$agent" <<'PY'
import json, subprocess, sys

name, description, cwd, agent = sys.argv[1:5]
command = "./scripts/treer-agent.sh"
args = ["--agent", agent]

def run_treer(argv):
    print("+", " ".join(argv), flush=True)
    subprocess.check_call(argv)

exists = subprocess.run(
    ["treer", "agent", "admin", "profile", "show", name],
    capture_output=True,
    text=True,
)
if exists.returncode == 0:
    update = [
        "treer", "agent", "admin", "profile", "update", name,
        "--description", description, "--cwd", cwd, "--command", command,
    ]
    for item in args:
        update.extend(["--arg", item])
    run_treer(update)
else:
    run_treer([
        "treer", "agent", "admin", "profile", "create", name,
        "--description", description, "--cwd", cwd, command, "--", *args,
    ])
print(json.dumps({"ok": True, "profile": name, "cwd": cwd, "command": command, "args": args}))
PY

  start_agent() {
    echo "creating command agent $name with host-relative cwd $AGENT_CWD"
    treer agent admin create --machine self --kind command --name "$name" --cwd "$AGENT_CWD" -- \
      ./scripts/treer-agent.sh --agent "$agent"
  }

  if treer agent show "$name" >/dev/null 2>&1; then
    STATUS="$(treer agent show "$name" | python3 -c 'import json,sys; rec=json.load(sys.stdin); rec=rec.get("agent", rec); print(rec.get("status") or "")')"
    if [ "$STATUS" = "failed" ] || [ "$STATUS" = "exited" ]; then
      echo "agent $name is $STATUS; recreating"
      treer agent admin delete "$name"
      start_agent
    else
      echo "agent $name already exists ($STATUS); waiting for readiness"
    fi
  else
    start_agent
  fi

  python3 - "$name" <<'PY'
import json, subprocess, sys, time

name = sys.argv[1]

def run(args):
    return subprocess.check_output(args, text=True)

def load_json(raw, label):
    raw = (raw or "").strip()
    if not raw:
        raise ValueError(f"{label} returned empty output")
    return json.loads(raw)

def agent_record():
    try:
        payload = load_json(run(["treer", "agent", "show", name]), "treer agent show")
    except subprocess.CalledProcessError:
        return None
    if isinstance(payload, dict) and payload.get("error"):
        return None
    return payload

required = {"prompt.submit", "transcript.read", "state.observe", "abort"}
deadline = time.time() + 300
last = "not visible"
while time.time() < deadline:
    agent = agent_record()
    if not agent:
        last = "agent not visible yet"
        time.sleep(2)
        continue
    record = agent.get("agent") if isinstance(agent.get("agent"), dict) else agent
    status = record.get("status")
    if status in {"failed", "exited"}:
        raise SystemExit(f"agent {name} entered {status}")
    interface = record.get("interface") if isinstance(record.get("interface"), dict) else None
    capabilities = set(interface.get("capabilities") or []) if interface else set()
    if (
        interface
        and interface.get("protocol") == "treer.agent-interface/v1"
        and interface.get("ui_path") == "/"
        and required.issubset(capabilities)
    ):
        print(json.dumps({"ok": True, "agent": record, "interface": interface}, indent=2))
        raise SystemExit(0)
    last = f"status={status}, interface={interface}"
    time.sleep(2)

raise SystemExit(f"timed out waiting for {name}: {last}")
PY
}

for agent in $SELECTED; do
  upsert_and_start "$agent"
done

echo "installed ACP UI for:$SELECTED"
