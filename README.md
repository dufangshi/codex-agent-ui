# Codex Agent UI

Slim Codex thread UI for Treer's Agent UI iframe. A Treer **command** Agent
runs HTTP + WebSocket next to `codex app-server` inside the Linux network
sandbox. Treer only iframes the page.

This is not Treer's `kind=codex` PTY TUI.

## Recipe

Share this repository URL. An installer Agent (Codex or Claude) reads
`treer-agent.json` and `skills/install-codex-agent-ui/SKILL.md`, then runs
`scripts/apply.sh`. That creates a separate command Agent whose start script
is `scripts/treer-agent.sh`, and saves a workspace launch profile (`Codex Agent
UI`) so Launch can open another thread without running the installer again.

A clone can start without building thread-ui: `apps/web/dist` is tracked.
`/.treer/agent` returns HTTP 200 only after `codex app-server` is ready.

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
`/api/workspaces/.../agents/.../ui/proxy/`.
