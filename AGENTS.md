# pi-acp

This repo is Matt's Zed-focused ACP adapter for `pi` (`@earendil-works/pi-coding-agent`). Treat it as an owned fork, not as a thin upstream mirror.

`pi-acp` speaks ACP JSON-RPC 2.0 over stdio to Zed and spawns `pi --mode rpc` behind it. The job is to make pi feel native in Zed without modifying pi itself.

## Current architecture

- ACP side: `@agentclientprotocol/sdk`, stdio JSON-RPC.
- pi side: one `pi --mode rpc` subprocess per ACP session, newline-delimited JSON over stdio.
- Core adapter code lives in `src/acp/*`.
- pi process/RPC handling lives in `src/pi-rpc/*`.
- Smoke/eval helpers live in `scripts/*`.
- Tests live in `test/*`.

Session mapping is adapter-managed. pi stores its own session JSONL files; pi-acp stores small metadata under `~/.pi/pi-acp` unless `PI_ACP_DIR` overrides it.

## Product stance

Zed is the compatibility baseline. Other ACP clients may work, but don't bend clean Zed behavior around hypothetical clients.

Do not cargo-cult ACP features pi cannot honestly support. In particular:

- Do not implement fake ACP filesystem delegation. pi already reads/writes locally.
- Do not implement fake ACP terminal delegation. pi already executes locally. Bash cards may use Zed terminal-output metadata for rendering, but Zed is not executing those commands.
- Do not implement fake NES/autocomplete. pi is a turn/session/tool agent, not a next-edit suggestion engine.
- Do not advertise unsupported capabilities just to light up UI.

If Zed has a feature only through internal native-agent hooks, call that out instead of pretending pi-acp can support it through ACP. Editing previous messages is currently in that bucket: Zed wires it to internal `AgentConnection::truncate()`, not an ACP method.

## Tool rendering

Tool card fidelity matters. Zed-visible polish is part of the adapter, not fluff.

Keep `src/acp/translate/pi-tools.ts` as the main place for semantic tool display mapping:

- `bash` / `term` -> execute
- `read` / `ls` -> read
- `write` / `edit` -> edit, with structured diffs when possible
- `find` / `grep` -> search, no fake file locations for search scope
- `webfetch` / `websearch` -> fetch/search-style cards as currently mapped
- `subagent` / `todo` -> think where appropriate

Bash output uses Zed's `_meta.terminal_output` convention. pi may emit cumulative partial output; send terminal deltas, not repeated full output.

Long-term, semantic tool display metadata belongs in pi core/tool registry. Until pi exposes that, adapter-side mapping is acceptable.

## Session behavior

Supported lifecycle:

- `session/new` starts a pi RPC subprocess.
- `session/prompt` sends prompts to pi and streams updates.
- `session/cancel` aborts the current pi turn.
- `session/close` releases adapter state.
- `session/load` replays a stored pi session into Zed.
- `session/resume` reattaches without replaying old messages.
- `session/fork` copies a pi session file into a new independent session.

Be careful with turn completion. `proc.prompt()` resolving means pi accepted the prompt; it does not mean the assistant turn is complete. Completion is driven by pi `agent_end`, with only narrow fallback behavior for older/fake streams.

## Commands and extension UI

Slash commands are a mix of adapter built-ins, file prompts, skills, and pi RPC commands. Preserve that separation.

Extension UI is intentionally partial:

- `notify` -> assistant text
- `select` / `confirm` -> ACP permission prompts
- single-line `input` -> ACP elicitation when available
- status/widget/title/editor UI -> ignore or degrade, don't wedge the turn

## Development

Use npm scripts from this repo:

```sh
npm run fmt
npm run check
npm run lint
npm run test
npm run smoke:eval
```

Normal validation after code edits:

```sh
npm run fmt && npm run check && npm run test && npm run smoke:eval
```

`npm run smoke:eval` builds the adapter and runs a fake-pi ACP harness. It does not require a real pi install.

## Style

Keep changes small and direct. This is infrastructure glue, not an enterprise middleware pageant.

- Prefer small translation helpers with tests.
- Preserve streaming/order guarantees.
- Be explicit about unsupported behavior.
- Avoid unnecessary comments; comment protocol quirks and non-obvious Zed/pi behavior.
- Avoid `any` where it is easy to avoid, but don't contort protocol-boundary code into type cosplay.

## Source control

Matt has allowed normal stage/commit/push flow in this repo. Do not commit unrelated personal/runtime state. Keep generated/vendor/session noise out of commits.

Runtime/debug paths to avoid committing:

- `node_modules/`
- `dist/` unless explicitly needed for a release artifact
- `.direnv/`
- `tmp/`
- `~/.pi/pi-acp/*`
- pi session JSONL files

## Local references

Use the actual local checkouts when needed:

- Zed source: `/Users/matt/code/zed`
- ACP docs/spec checkout may or may not exist locally; prefer web docs or repo discovery instead of assuming an old `~/Dev/learning/...` path.

For pi itself, read the installed pi docs/examples under Matt's pi agent install when working on pi extension/tool APIs.
