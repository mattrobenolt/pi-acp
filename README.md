# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent.

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Status

This is a practical adapter intended to make pi usable from [Zed](https://zed.dev) via ACP. It tracks pi's RPC mode instead of reimplementing pi, so the supported surface is the intersection of ACP, Zed, and `pi --mode rpc`.

Expect minor breaking changes. Zed is the primary target; other ACP clients may work but are not the compatibility baseline.

## Features

- Streams assistant output as ACP `agent_message_chunk` and hidden thinking as `agent_thought_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available for ACP clients that support opening referenced files
  - Relative file paths from pi are resolved against the session cwd
  - `bash` is emitted as ACP tool kind `execute`
  - `edit` and `write` attempt to emit ACP structured diffs on completion
- Session persistence and restore
  - pi stores its own sessions under the configured pi session directory
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` and `session/resume` can reattach to a previous pi session file
  - sessions can be forked by copying the pi session file with a new session id, preserving history without mutating the source
  - sessions get an initial title from the first prompt and can be closed from the ACP client
  - ACP `additionalDirectories` are accepted on new/load/resume/fork/list, stored in adapter metadata, surfaced in session metadata/startup info, and used for exact-match session list filtering. pi still uses `cwd` as the execution base; these roots are context metadata, not a sandbox.
- Zed-focused session metadata
  - initializes with conservative capability negotiation and `_meta.piAcp` debug details for the ACP handshake
  - emits `session_info_update._meta.piAcp` with pi-acp version, model, context window, session file, additional directories, queue state, and startup info
  - exposes ACP session config options for pi auto-compaction, steering mode, and follow-up mode, and keeps them in sync with adapter slash commands
  - emits best-effort ACP `usage_update` telemetry from pi session stats when the context window is known; clients can opt out with `clientCapabilities._meta["usage-update"] = false`
- Slash commands
  - advertises pi RPC commands, file-based prompt commands, skill commands, and adapter built-ins to the ACP client
  - expands file-based prompt commands before sending to pi
  - handles adapter built-ins directly where needed for headless/editor usage
- Extension UI bridge
  - `select` and `confirm` requests are bridged to ACP `session/request_permission`
  - `notify` is surfaced as assistant text so notification-only extension commands work in Zed
  - fire-and-forget UI updates such as status/widget/title are ignored rather than wedging the turn
- Diagnostics extension methods under the `pi-acp/*` namespace for custom ACP clients
  - `pi-acp/session` returns adapter-side session metadata
  - `pi-acp/state` returns live `pi --mode rpc` state
  - `pi-acp/commands` returns the current advertised command catalog
  - `pi-acp/reloadCommands` refreshes the ACP `available_commands_update` notification
- Skills and pi packages are loaded by pi directly and are available in ACP sessions
- Startup info mirrors pi's terminal prelude: pi version, context, skills, prompts, extensions, and configured packages. Disable it with `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`).
- Session history is supported in Zed. Session loading/resume/fork maps to pi's session files, so sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js 24+
- `pi` installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

### Add pi-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

#### Using ACP Registry in Zed or other clients that support it:

In Zed launch the registry with `zed: acp registry` command and select `pi ACP` adapter from the list. This will automatically add the agent server configuration to your `settings.json` and keep it up to date:

```json
  "agent_servers": {
    "pi-acp": {
      "type": "registry",
    },
  }
```

#### Using with `npx` (no global install needed, always loads the latest version):

Add the following to your Zed `settings.json`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "pi-acp"],
      "env": {}
    }
  }
```

#### Global install

```bash
npm install -g pi-acp
```

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
```

### Environment variables

- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP `promptCapabilities.embeddedContext` support to the client. Default: disabled. If a client sends embedded `resource` blocks anyway, `pi-acp` converts them into plain-text prompt context.
- `PI_ACP_ENABLE_EXTENSION_COMMANDS=false` hides extension-provided pi commands from the advertised slash command list. Defaults to true, matching pi settings unless overridden.
- `PI_ACP_SKIP_PI_AUTH=1` skips the startup auth preflight that turns “no configured models” into ACP `AUTH_REQUIRED`.
- `PI_ACP_PI_COMMAND=/path/to/pi` overrides the `pi` executable used by the adapter.
- `PI_ACP_DIR=/path/to/state` overrides adapter state storage. Default: `~/.pi/pi-acp`.
- `PI_ACP_DEBUG_LOG=/tmp/pi-acp.jsonl` writes JSONL debug events. Useful when diagnosing Zed/ACP behavior.

You can add environment variables in the Zed settings with:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {
          "PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true",
      }
    }
  }
```

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

#### 2) Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/steering [all|one-at-a-time]` – get/set pi steering mode
- `/follow-up [all|one-at-a-time]` – get/set pi follow-up mode
- `/changelog` – print the installed pi changelog (best-effort)

Other built-in commands:

- `/model` - maps to model selector in Zed
- `/thinking` - maps to 'mode' selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

#### 3) Pi RPC and skill commands

`pi-acp` asks pi for its command catalog via RPC and advertises those commands to the ACP client. Skill commands appear as `/skill:skill-name` when enabled in pi settings.

Extension commands are advertised by default. They run through pi's RPC command path, so behavior depends on which extension UI APIs they use. Notification-only commands work and display in Zed; `select`/`confirm` are bridged to ACP permissions; unsupported dialog/editor UI is cancelled or ignored so the adapter should degrade rather than hang.

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

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

### Smoke / eval harness

`scripts/smoke-eval.mjs` is a self-contained ACP smoke harness that runs against the
compiled adapter using a fake pi subprocess (`scripts/fake-pi.mjs` + `scripts/fake-pi-bin.sh`).
No real pi installation is required.

```bash
npm run smoke:eval          # build + run all suites
SMOKE_VERBOSE=1 npm run smoke:eval   # print every JSON-RPC frame
```

Covered flows:

- `initialize` handshake
- `session/new` — sessionId, command advertisement via `session/update`
- `session/prompt` — plain text, streaming `session/update` chunks
- `session/prompt` — built-in slash command (`/session`)
- `session/cancel`
- `session/close`
- `session/load` — cross-process replay
- `session/resume` — reattach without replaying prior messages
- `session/fork` — copy a pi session file into an independent fork

Extension UI notify/select is covered by unit tests in `test/extension-ui.test.ts`
(the ACP SDK routes those requests internally and they don't surface cleanly over raw stdio).

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol)

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally.
- ACP `additionalDirectories` are metadata only in the adapter. They are stored, advertised, and included in startup context, but pi still operates from the session `cwd`; they do not enforce filesystem scope.
- MCP servers are accepted in ACP params and stored in session state, but not wired through to pi by this adapter. Configure MCP through pi itself if you need it in a pi session.
- Extension UI support is partial. `notify`, `select`, `confirm`, and single-line `input` are handled; richer TUI/editor/status/widget behavior is degraded.
- pi commands are advertised from `get_commands`, but not every pi or extension command has a perfect ACP/Zed equivalent.
- Queue/active-turn behavior is adapter-managed: normal concurrent prompts are sent to pi as steering messages.

## License

MIT (see [LICENSE](LICENSE)).
