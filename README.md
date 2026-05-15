# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi-coding-agent), maintained as a local Zed integration.

`pi-acp` speaks **ACP JSON-RPC 2.0 over stdio** to an ACP client and spawns `pi --mode rpc` behind it. Zed is the target client. Other ACP clients may work, but this repo does not optimize for generic compatibility when Zed needs specific behavior.

This repo started as a fork of `svkozak/pi-acp`, but it has diverged enough that it should be treated as its own adapter. The MIT license attribution is preserved in `LICENSE`.

## Status

Practical, Zed-focused, and intentionally not upstream-compatible. The adapter tracks pi's RPC mode instead of reimplementing pi, so the supported surface is the useful intersection of Zed, ACP, and `pi --mode rpc`.

Expect changes as pi, ACP, and Zed move.

## Features

- Streams assistant output as ACP `agent_message_chunk` and hidden thinking as `agent_thought_chunk`.
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`.
  - File paths are resolved against the session cwd where appropriate.
  - Read/write/edit tools surface file locations and structured diffs when possible.
  - Search tools such as `grep`, `find`, and `websearch` render as search/fetch cards instead of fake file locations.
  - Bash renders as a Zed terminal-style execute card, including ANSI color output via Zed's `_meta.terminal_output` convention.
  - Common pi tools get Zed-friendly titles/kinds: `read`, `write`, `edit`, `bash`, `term`, `find`, `grep`, `webfetch`, `websearch`, `todo`, `subagent`, `mcp`, scratchpad, and memory tools.
- Session lifecycle support.
  - pi stores its own sessions under the configured pi session directory.
  - `pi-acp` stores adapter metadata in `~/.pi/pi-acp/session-map.json`.
  - `session/load` replays a previous pi session into Zed.
  - `session/resume` reattaches to an existing pi session file without replaying prior messages.
  - `session/fork` copies a pi session file into a new independent session.
  - `session/close` cancels/releases adapter state.
- Zed-focused metadata and diagnostics.
  - Conservative capability negotiation with `_meta.piAcp` debug details.
  - `session_info_update._meta.piAcp` includes pi-acp version, model, context window, session file, additional directories, queue state, and startup info.
  - Best-effort ACP `usage_update` from pi stats when context window data is available.
  - Custom diagnostic extension methods under `pi-acp/*`: `pi-acp/session`, `pi-acp/state`, `pi-acp/commands`, and `pi-acp/reloadCommands`.
- Slash commands.
  - Advertises pi RPC commands, file-based prompt commands, skill commands, and adapter built-ins.
  - Expands file-based prompt commands before sending to pi.
  - Handles some commands adapter-side when pi's interactive UI equivalent does not make sense in Zed.
- Extension UI bridge.
  - `select` and `confirm` map to ACP permission prompts.
  - Single-line `input` uses ACP elicitation when available.
  - `notify` is surfaced as assistant text.
  - Fire-and-forget UI calls such as status/widget/title/editor text are ignored rather than wedging the turn.
- Startup info mirrors pi's terminal prelude: pi version, context, skills, prompts, extensions, and configured packages. Disable it with `quietStartup: true` in pi settings.

## Requirements

- Node.js 24+
- A working `pi` install available on `PATH`, or set `PI_ACP_PI_COMMAND=/path/to/pi`
- pi configured separately for model providers/API keys
- Zed configured with this adapter as a custom ACP agent server

Install pi separately if needed:

```bash
npm install -g @earendil-works/pi-coding-agent
```

## Installation

Add to your Zed `settings.json` (`cmd+shift+p` → "zed: open settings"):

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["@mattrobenolt/pi-acp@latest"]
    }
  }
}
```

This runs the adapter via npx on each session start. No global install needed.

## Building from source

```bash
git clone https://github.com/mattrobenolt/pi-acp
cd pi-acp
npm install
npm run build
```

Then point Zed at the built output:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"]
    }
  }
}
```

For live TypeScript execution during development:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "./node_modules/.bin/tsx",
      "args": ["/path/to/pi-acp/src/index.ts"]
    }
  }
}
```

## Environment variables

- `PI_ACP_PI_COMMAND=/path/to/pi` overrides the `pi` executable used by the adapter.
- `PI_ACP_DIR=/path/to/state` overrides adapter state storage. Default: `~/.pi/pi-acp`.
- `PI_ACP_DEBUG_LOG=/tmp/pi-acp.jsonl` writes JSONL debug events for ACP/Zed diagnostics.
- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP `promptCapabilities.embeddedContext`. If a client sends embedded `resource` blocks anyway, `pi-acp` converts them into plain-text prompt context.
- `PI_ACP_ENABLE_EXTENSION_COMMANDS=false` hides extension-provided pi commands from the advertised slash command list. Defaults to true, matching pi settings unless overridden.
- `PI_ACP_SKIP_PI_AUTH=1` skips the startup auth preflight that turns “no configured models” into ACP `AUTH_REQUIRED`.

Example:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["@mattrobenolt/pi-acp@latest"],
      "env": {
        "PI_ACP_DEBUG_LOG": "/tmp/pi-acp.jsonl"
      }
    }
  }
}
```

## Slash commands

`pi-acp` advertises several command sources to Zed.

File-based prompt commands are loaded from:

- `~/.pi/agent/prompts/**/*.md`
- `<cwd>/.pi/prompts/**/*.md`

Adapter built-ins:

- `/compact [instructions...]` — run pi compaction
- `/autocompact on|off|toggle` — toggle automatic compaction
- `/export` — export the current session to HTML in the session cwd
- `/session` — show session stats
- `/name <name>` — set session display name
- `/steering [all|one-at-a-time]` — get/set pi steering mode
- `/follow-up [all|one-at-a-time]` — get/set pi follow-up mode
- `/changelog` — print the installed pi changelog, best effort

Zed-native mappings:

- `/model` maps to Zed's model selector
- `/thinking` maps to Zed's mode selector
- `/clear` is intentionally not implemented; start a new Zed thread instead

pi RPC commands and skill commands are also advertised from pi's command catalog. Extension commands are enabled by default, but their behavior depends on what extension UI APIs they use.

## Authentication

`pi-acp` exposes ACP terminal-auth metadata so Zed can show an authenticate banner when pi reports missing auth/configuration. The terminal auth command runs:

```bash
pi-acp --terminal-login
```

In source installs, Zed launches that through the configured adapter command. You can also just run pi directly in a terminal and configure providers there:

```bash
pi
```

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run fmt
npm run check      # tsgo --noEmit
npm run lint       # oxlint --deny-warnings
npm run test
npm run build      # tsdown -> dist/index.js
```

Normal validation after code edits:

```bash
npm run fmt && npm run check && npm run test && npm run smoke:eval
```

## Smoke / eval harness

`scripts/smoke-eval.mjs` is a self-contained ACP smoke harness that runs against the compiled adapter using a fake pi subprocess (`scripts/fake-pi.mjs` + `scripts/fake-pi-bin.sh`). No real pi installation is required.

```bash
npm run smoke:eval
SMOKE_VERBOSE=1 npm run smoke:eval
```

Covered flows include initialize, session/new, command advertisement, prompt streaming, slash commands, cancel, close, load, resume, and fork.

Project layout:

- `src/acp/*` — ACP server and translation layer
- `src/pi-rpc/*` — pi subprocess wrapper
- `scripts/*` — smoke/eval helpers
- `test/*` — unit/component/ACP protocol tests

## Limitations

- Zed editing of previous messages is not available for ACP agents yet. Zed currently wires that UI to its internal `AgentConnection::truncate()` hook, not to an ACP method. `pi-acp` supports ACP session fork, but Zed does not use ACP fork for this feature.
- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally. Bash output is rendered with Zed terminal metadata, but Zed is not executing the command.
- ACP `additionalDirectories` are metadata only. They are stored, advertised, and included in startup context, but pi still operates from the session `cwd`; they do not enforce filesystem scope.
- MCP servers passed by ACP are stored in session state but not wired through to pi by this adapter. Configure MCP through pi itself.
- Extension UI support is partial. `notify`, `select`, `confirm`, and single-line `input` work; richer TUI/editor/status/widget behavior is degraded.
- pi commands are advertised from `get_commands`, but not every pi or extension command has a perfect ACP/Zed equivalent.
- Tool card metadata is adapter-maintained. pi's tool registry does not yet expose semantic ACP/Zed display metadata, so custom tool rendering may need adapter-side mapping.
- Queue/active-turn behavior is adapter-managed: normal concurrent prompts are sent to pi as steering messages.

## License and attribution

MIT. See [LICENSE](LICENSE).

This repository preserves the original MIT copyright notice from `svkozak/pi-acp`.
