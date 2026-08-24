---
name: install-codex-agent-ui
description: Install Codex Agent UI from this repo's treer-agent.json as a Treer command Agent. Use when asked to install, import, or apply the Codex Agent UI recipe from git.
---

# Install Codex Agent UI

You are the **installer**. The thing you create is a different **command** Agent.
Do not try to run `codex app-server` in this process.

## Preconditions

This process must be a Treer-managed Agent:

```bash
test -n "${TREER_AGENT_ID:-}" && test -n "${TREER_AGENT_SERVER_URL:-}"
treer whoami
```

Need `git`, `node`, `npm`, `curl`, `codex`, and `treer` on PATH. If `codex` is
missing, install it with `npm install -g @openai/codex`.

## Procedure

Read `treer-agent.json` at the repository root. Then run the apply script. Do
not invent a second install path.

```bash
REPO_URL="$(python3 -c 'import json; print(json.load(open("treer-agent.json"))["source"]["git"])')"
REF="$(python3 -c 'import json; print(json.load(open("treer-agent.json"))["source"]["ref"])')"
DEST="${TREER_RECIPE_DIR:-$PWD/codex-agent-ui}"
if [ ! -f "$DEST/scripts/apply.sh" ]; then
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$DEST"
fi
"$DEST/scripts/apply.sh" --name "${TREER_RECIPE_AGENT_NAME:-codex-ui}" --dir "$DEST"
```

If this checkout already contains `scripts/apply.sh`, skip clone and run:

```bash
./scripts/apply.sh --name "${TREER_RECIPE_AGENT_NAME:-codex-ui}"
```

`apply.sh` installs isolated server dependencies, upserts a Launch profile
from `treer-agent.json`, creates the first command Agent with a Host-relative
`--cwd`, and waits until `/.treer/agent` is reachable through the registered
service. Later threads use that Launch option; do not run this installer again.

## Success

Stop only when all of these are true:

1. `treer agent show <name>` exists and is not `failed` or `exited`.
2. `treer network service list` shows an Agent-scoped HTTP service for that Agent.
3. `treer status` includes an `agent_uis` entry for that Agent.
4. `treer agent admin profile show` returns the name from `treer-agent.json`.

The installer cannot probe another Agent's service (`service_not_owned`).
Readiness for operators is `GET /.treer/agent` through the Agent UI
proxy: HTTP 200 and `ready: true`.

Do not put secrets in a launch profile. Do not use `--publish`. The start script
registers `--agent self` and `treer ui set` itself.
