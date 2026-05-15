# Context for: adopting upstream issues/PRs in pi-acp

## Relevant Files

- `src/index.ts` — stdio ACP entrypoint, terminal-auth bootstrap via `--terminal-login`, process shutdown wiring.
- `src/acp/agent.ts` — main ACP implementation: `initialize`, `newSession`, `loadSession`, `prompt`, `unstable_listSessions`, `setSessionMode`, auth preflight, startup info, command advertisement.
- `src/acp/session.ts` — session lifecycle and event bridge from pi RPC events to ACP `session/update` emissions; queueing, tool call/status emission, replay handling.
- `src/acp/session-store.ts` — adapter-owned mapping from ACP sessionId to pi session file for restore/load.
- `src/acp/paths.ts` — adapter storage path (`~/.pi/pi-acp/...`).
- `src/acp/pi-settings.ts` — global/project pi settings merge; quiet startup, skill commands, enabled models.
- `src/acp/auth.ts` / `src/acp/auth-required.ts` — terminal auth method advertising and auth-required error shaping.
- `src/acp/pi-commands.ts` / `src/acp/slash-commands.ts` — command translation from pi + file prompts into ACP available commands; slash command expansion.
- `src/acp/translate/pi-tools.ts` / `src/acp/translate/pi-messages.ts` / `src/acp/translate/prompt.ts` — text/tool/prompt translation helpers.
- `src/acp/pi-sessions.ts` — session list/restore discovery from pi session files.
- `src/pi-rpc/process.ts` / `src/pi-rpc/command.ts` — subprocess wrapper and pi spawn command selection.
- `test/*` — coverage for startup info, session restore/list, auth, tool translation, command filtering, enabled models, event emission.

## Project Structure

`src/acp` is the adapter layer; `src/pi-rpc` is the low-level subprocess protocol wrapper. The ACP agent owns most policy decisions, while `PiRpcProcess` just turns JSONL RPC into typed-ish requests/events. The test suite is split into unit tests for translation/utilities and component tests for end-to-end-ish adapter behavior with fakes.

## Conventions

The code is very defensive and “best effort” heavy: most reads are wrapped in try/catch, errors are downgraded to ACP `RequestError` shapes where possible, and notification failures are ignored so prompt completion keeps moving. Ordering matters: session updates are serialized through `Session.emit()` and a `lastEmit` promise chain. A lot of behavior is intentionally client-specific (Zed comments show up everywhere), but the implementation keeps fallbacks for plain ACP clients.

## Dependencies

`@agentclientprotocol/sdk` is the main contract surface. `PiRpcProcess` depends on Node child_process + readline and speaks pi’s NDJSON RPC. Settings and restore logic depend on `~/.pi/agent/settings.json` plus `<cwd>/.pi/settings.json`, and session history depends on the pi session JSONL layout under `~/.pi/agent/sessions` or a custom `sessionDir`.

## Key Findings

Startup info is split between `PiAcpAgent.newSession()` and `PiAcpSession`: `newSession()` computes the text via `buildStartupInfo(...)` unless `quietStartup` is on, stores it with `session.setStartupInfo()`, and schedules both `sendStartupInfoIfPending()` and command advertisement with `setTimeout(0)`. `PiAcpSession` also re-emits the startup info on the first prompt as a fallback if the client misses the out-of-turn emission.

Settings paths are local-only adapter helpers in `pi-settings.ts`: `getAgentDir()` resolves `PI_CODING_AGENT_DIR` or defaults to `~/.pi/agent`; settings are merged from global `settings.json` and project `.pi/settings.json`. `getQuietStartup()`, `getEnableSkillCommands()`, and the new `getEnabledModels()` all read from that merged view.

Session store/restore is split across two mechanisms. On create, `SessionManager.create()` asks pi for `getState()`, records `{sessionId,cwd,sessionFile}` in `SessionStore`, and keeps the live `PiAcpSession` in-memory. On `loadSession()`, the agent first checks the mapping file, then falls back to scanning pi’s session dir via `findPiSessionFile()`, then spawns `pi --mode rpc --session <file>`, replays messages from `getMessages()`, and emits synthetic ACP tool events for historical `toolResult` entries.

ACP session/update emission is centralized in `PiAcpSession.emit()`, which serializes updates and swallows client-side notification failures. `handlePiEvent()` translates `message_update`, `tool_execution_start/update/end`, `auto_retry_*`, `auto_compaction_*`, and `agent_end` into ACP session updates, with special handling for edit diffs via a pre-edit file snapshot. `agent_end` is the point where `session/prompt` actually resolves.

Tool translation is mostly in `src/acp/session.ts` plus `src/acp/translate/pi-tools.ts`. Paths are resolved against session cwd, edit tools try to infer a unique 1-based line, bash is intentionally downgraded to ACP `other`, and `toolResultToText()` prefers textual content, then `details.diff`, then stdout/stderr, then JSON fallback.

Auth preflight happens in two places: `newSession()` checks `getAvailableModels()` / `getState()` for auth-like failures and zero models, and `PiAcpSession.startTurn()` maps prompt-time subprocess failures through `maybeAuthRequiredError()`. `auth.ts` advertises a single terminal-login auth method, optionally with Zed’s `_meta["terminal-auth"]` launch hint.

Commands are sourced from both pi and local markdown prompts. `getCommands()` is converted by `toAvailableCommandsFromPiGetCommands()` with extension commands hidden by default and skill commands optionally filtered by `getEnableSkillCommands()`. Built-ins are merged in `builtinAvailableCommands()`. Slash commands are expanded locally in `PiAcpSession.prompt()` via `expandSlashCommand()` because pi RPC mode doesn’t do that itself.

The pi RPC process is intentionally thin: `PiRpcProcess.spawn()` starts `pi --mode rpc --no-themes` (plus `--session` when loading), captures non-JSON stdout as prelude lines, and exposes one-request-per-JSON-line helpers for state, models, commands, session stats, export, etc.

Tests are already pointed at the exact seams upstream changes will hit: `startup-info-*`, `session-list-and-load`, `session-load-toolresult`, `session-events`, `enabled-models`, `auth-methods-terminal-auth-meta`, and the command/text translators.

## Gotchas

The biggest sharp edge is that the adapter’s behavior is split across live-session creation and restore paths; changing one without the other will leave `newSession` and `loadSession` inconsistent. Another one: `newSession()` calls `cleanupFailedNewSession()` on several early exits, which deletes both the live session and the mapping file if present. The current implementation also has client-specific timing assumptions (`setTimeout(0)` for startup info and command updates), so anything that changes emission ordering can break Zed behavior without obvious type errors.

There are likely conflicts with the current uncommitted changes in `src/acp/agent.ts` and `src/acp/pi-settings.ts`. The working tree already adds `getEnabledModels()` and model filtering in `getModelState()`; any upstream PR touching model selection, startup info, or settings merging is going to collide there. `package.json` / `package-lock.json` are also locally bumped from `@agentclientprotocol/sdk` `0.12.0` to `0.21.1`, so any upstream SDK-surface change should be checked against that version skew before assuming behavior matches. The new test `test/unit/enabled-models.test.ts` is untracked and directly exercises the new settings-driven model filtering path.
