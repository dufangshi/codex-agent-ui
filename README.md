# Codex Agent UI

Slim Codex thread UI for Treer's Agent UI iframe. A Treer **command** Agent
runs HTTP + WebSocket next to `codex app-server` inside the Linux network
sandbox. Treer only iframes the page.

This is not Treer's `kind=codex` PTY TUI.

One Treer Agent is one Codex thread. Extra conversations are another Agent.
The start script starts `app-server` plus the frontend only when this process
cannot already reach a healthy listener of this recipe. If it can, it binds a
new thread on that shared process and registers this Agent's UI.

## Recipe

Share this repository URL. An installer Agent (Codex or Claude) reads
`treer-agent.json` and `skills/install-codex-agent-ui/SKILL.md`, then runs
`scripts/apply.sh`. That creates a separate command Agent whose start script
is `scripts/treer-agent.sh`, and saves a workspace launch profile (`Codex Agent
UI`) so Launch can create another Agent. Do not install the recipe again for
another thread.

A clone can start without building thread-ui: `apps/web/dist` is tracked.
The private listener exposes `treer.agent-interface/v1` (`/v1/manifest`,
`/v1/status`, `/v1/prompts`, `/v1/transcript`, `/v1/abort`) plus the browser
page. `/.treer/agent` returns HTTP 200 only after `codex app-server` is ready.

```bash
git clone https://github.com/dufangshi/codex-agent-ui.git
# from a Treer-managed installer Agent:
./scripts/apply.sh --name codex-ui
```

## Run locally

```bash
pnpm install
pnpm build
CODEX_AGENT_UI_CWD="$PWD" pnpm start
```

Listens on `127.0.0.1:4173`. Pages use relative `api/` and `ws` URLs plus
`<base href="./">` so Treer can iframe them under
`/api/workspaces/.../agents/.../interface/ui/`. The start script registers
that page with `treer interface register --ui-path /` and the prompt,
transcript, state, and abort capabilities. `ui_path` is the HTTP path on the
Agent's private loopback server (`/`), not a git URL. Current fnm only
accepts `--shell=bash` (not `sh`).
