#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
NAME="${TREER_RECIPE_AGENT_NAME:-codex-ui}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)
      NAME="$2"
      shift 2
      ;;
    --dir)
      ROOT="$(CDPATH= cd -- "$2" && pwd)"
      shift 2
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
# Isolate from the parent pnpm workspace. A workspace-hoisted lockfile
# produces broken ../../node_modules/.pnpm symlinks after a git clone.
rm -rf "$ROOT/apps/server/node_modules"
npm --prefix "$ROOT/apps/server" install --install-strategy=nested --no-workspaces
if [ ! -f "$ROOT/apps/server/node_modules/ws/package.json" ] || [ ! -x "$ROOT/apps/server/node_modules/.bin/tsx" ]; then
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

echo "saving launch profile from $ROOT/treer-agent.json with cwd $AGENT_CWD"
python3 - "$ROOT/treer-agent.json" "$AGENT_CWD" <<'PY'
import json, subprocess, sys

meta = json.load(open(sys.argv[1]))
cwd = sys.argv[2]
name = (meta.get("name") or "").strip() or "recipe"
description = meta.get("description") or ""
run = meta.get("run") if isinstance(meta.get("run"), dict) else {}
command = (run.get("command") or "./scripts/treer-agent.sh").strip()
args = run.get("args") or []
if not command:
    raise SystemExit("treer-agent.json run.command is empty")
if not isinstance(args, list) or any(not isinstance(item, str) for item in args):
    raise SystemExit("treer-agent.json run.args must be an array of strings")

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
        "treer",
        "agent",
        "admin",
        "profile",
        "update",
        name,
        "--description",
        description,
        "--cwd",
        cwd,
        "--command",
        command,
    ]
    if args:
        for item in args:
            update.extend(["--arg", item])
    else:
        update.append("--clear-args")
    run_treer(update)
else:
    create = [
        "treer",
        "agent",
        "admin",
        "profile",
        "create",
        name,
        "--description",
        description,
        "--cwd",
        cwd,
        command,
    ]
    if args:
        create.append("--")
        create.extend(args)
    run_treer(create)
print(json.dumps({"ok": True, "profile": name, "cwd": cwd, "command": command, "args": args}))
PY

create_agent() {
  echo "creating command agent $NAME with host-relative cwd $AGENT_CWD"
  treer agent admin create --machine self --kind command --name "$NAME" --cwd "$AGENT_CWD" -- ./scripts/treer-agent.sh
}

if treer agent show "$NAME" >/dev/null 2>&1; then
  STATUS="$(treer agent show "$NAME" | python3 -c 'import json,sys; rec=json.load(sys.stdin); rec=rec.get("agent", rec); print(rec.get("status") or "")')"
  if [ "$STATUS" = "failed" ] || [ "$STATUS" = "exited" ]; then
    echo "agent $NAME is $STATUS; recreating"
    treer agent admin delete "$NAME"
    create_agent
  else
    echo "agent $NAME already exists ($STATUS); waiting for readiness"
  fi
else
  create_agent
fi

python3 - "$NAME" <<'PY'
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

def status_snapshot():
    return load_json(run(["treer", "status"]), "treer status")

def services():
    payload = load_json(run(["treer", "network", "service", "list"]), "treer network service list")
    if isinstance(payload, dict):
        return payload.get("services") or payload.get("items") or []
    return payload if isinstance(payload, list) else []

def service_for_agent(agent_id):
    matches = []
    for service in services():
        if not isinstance(service, dict):
            continue
        target = service.get("target_agent_id") or service.get("agent_id")
        if target == agent_id and service.get("protocol") == "http":
            matches.append(service)
    return matches

deadline = time.time() + 300
last = ""
while time.time() < deadline:
    agent = agent_record()
    if not agent:
        last = "agent not visible yet"
        time.sleep(2)
        continue
    record = agent.get("agent") if isinstance(agent.get("agent"), dict) else agent
    agent_id = record.get("agent_id") or record.get("id")
    status = record.get("status")
    if status in {"failed", "exited"}:
        raise SystemExit(f"agent {name} entered {status}")
    matches = service_for_agent(agent_id) if agent_id else []
    snapshot = status_snapshot()
    uis = snapshot.get("agent_uis") or []
    ui = next((item for item in uis if isinstance(item, dict) and item.get("agent_id") == agent_id), None)
    if ui and matches:
        print(json.dumps({"ok": True, "agent": record, "service": matches[0], "ui": ui}, indent=2))
        raise SystemExit(0)
    if not matches:
        last = f"agent {name} status={status} has no Agent-scoped HTTP service yet"
    elif not ui:
        last = f"agent {name} has a service but no agent_uis entry yet"
    time.sleep(2)

raise SystemExit(f"timed out waiting for {name} UI readiness: {last}")
PY
