---
name: install-codex-agent-ui
description: Install the generic ACP Agent UI as Treer command Agents. Use when asked to install, import, or apply the Codex/ACP Agent UI recipe from git.
---

# Install ACP Agent UI

You are the **installer**. The thing you create is a different **command** Agent
for each ACP harness. Do not run the ACP server or UI in this process.

## Preconditions

This process must be a Treer-managed Agent:

```bash
test -n "${TREER_AGENT_ID:-}" && test -n "${TREER_AGENT_SERVER_URL:-}"
treer whoami
```

Need `git`, `node`, `npm`, `curl`, and `treer` on PATH. Passing an explicit
`--agent` installs that harness CLI when it is missing:

- Codex: `npm install -g @openai/codex`
- Claude Code: official `claude` CLI
- Grok Build: `grok` CLI
- Cursor: `cursor-agent` CLI

## Procedure

Read `treer-agent.json` at the repository root. Inspect the recipe, then ask
the human which agents to install. Do not invent a second install path.

```bash
REPO_URL="$(python3 -c 'import json; print(json.load(open("treer-agent.json"))["source"]["git"])')"
REF="$(python3 -c 'import json; print(json.load(open("treer-agent.json"))["source"]["ref"])')"
DEST="${TREER_RECIPE_DIR:-$PWD/codex-agent-ui}"
if [ ! -f "$DEST/scripts/apply.sh" ]; then
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$DEST"
fi
"$DEST/scripts/apply.sh" --list
```

Show `supported` and `ready` to the user and wait for which harnesses to
install. Then pass only those names:

```bash
"$DEST/scripts/apply.sh" --dir "$DEST" --agent grok --agent cursor
```

If this checkout already contains `scripts/apply.sh`, skip clone, run
`--list`, ask, then run `./scripts/apply.sh --agent ...`.

Do not run `apply.sh` with no `--agent` from this installer: that installs
every CLI on PATH. `apply.sh` installs isolated server dependencies, installs
an ACP adapter when the harness is not native ACP, upserts a Launch profile
per chosen harness, creates that command Agent, and waits until its verified
Interface descriptor includes `ui_path` and the required capabilities.

## Success

Stop only when all of these are true for each created Agent:

1. `treer agent show acp-<harness>` exists and is not `failed` or `exited`.
2. That Agent's `interface.protocol` is `treer.agent-interface/v1`.
3. That Agent's `interface.ui_path` is `/`.
4. That Agent's `interface.capabilities` include `prompt.submit`,
   `transcript.read`, `state.observe`, and `abort`.
5. `treer agent admin profile show` returns `ACP Codex`, `ACP Grok`,
   `ACP Cursor`, and/or `ACP Claude` for the harnesses that were installed.

The created interface is allowed to be unauthenticated. It must still be
online; the human can use `/login` in its slash toolbox to complete OAuth.
Do not put secrets in a launch profile. Do not use `--publish`.
