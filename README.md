# ACP Agent UI

Generic Treer Agent iframe for **Agent Client Protocol** harnesses. One recipe
renders Codex, Grok Build, Cursor Agent, Claude Code, and other ACP-capable
CLIs. Treer does not need a separate UI repository per harness.

Each Treer command Agent is one ACP session / one thread. Extra conversations
use Launch. If the harness is not native ACP, `scripts/apply.sh` installs its
adapter before starting the Agent.

## Recipe

Share this repository URL. An installer Agent reads `treer-agent.json` and
`skills/install-codex-agent-ui/SKILL.md`, then runs `scripts/apply.sh`. That
probes available CLIs, installs missing ACP adapters, saves one Launch profile
per harness, and creates the first command Agent for each.

| Agent | ACP transport | Base probe | ACP command | Adapter |
| --- | --- | --- | --- | --- |
| Grok Build | Native | `grok --version` | `grok agent stdio` | none |
| Cursor Agent | Native | `cursor-agent --version` | `cursor-agent acp` | none |
| Claude Code | Adapter | `claude --version` | `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` |
| OpenAI Codex | Adapter | `codex --version` | `codex-acp` | `@agentclientprotocol/codex-acp` |

```bash
git clone https://github.com/dufangshi/codex-agent-ui.git
# from a Treer-managed installer Agent:
./scripts/apply.sh --dir "$PWD"
# or one harness:
./scripts/apply.sh --agent grok
```

`apply.sh` without `--agent` installs every harness whose base CLI is on PATH.

## Run locally

```bash
npm --prefix apps/server install
ACP_AGENT=grok ACP_COMMAND="grok agent stdio" CODEX_AGENT_UI_PORT=4173 \
  CODEX_AGENT_UI_CWD="$PWD" npm --prefix apps/server start
```

The private listener exposes `treer.agent-interface/v1` plus the thread UI.
The start script registers `treer interface register --ui-path /` with prompt,
transcript, state, and abort capabilities.

Treer Host processes do not inherit an interactive shell, so the UI loads
harness credentials from the CLI's usual files (`~/.grok/env`,
`~/.codex/auth.json`) and prefers non-interactive ACP auth (`xai.api_key`,
`cached_token`, `api-key`, `cursor_login`). Browser/ChatGPT login is only
used when a local subscription session already exists.
