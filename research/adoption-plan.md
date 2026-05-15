# pi-acp upstream adoption plan

Date: 2026-05-15

This plan is based on fresh research of current ACP, Zed, pi APIs, local code, and upstream issues/PRs. The bias is: make pi feel native in Zed without lying about ACP semantics or cargo-culting upstream diffs.

## Ground rules

- Keep pi as the executor. Do not delegate filesystem or terminal execution to Zed unless we explicitly redesign that layer.
- Prefer stable ACP surfaces. `session_info_update`, `session/close`, `available_commands_update`, and `session/request_permission` are stable enough. `usage_update` is still draft/beta in practice, so gate it.
- Use pi RPC APIs directly where they exist. Pi now supports `prompt.streamingBehavior`, `steer`, `follow_up`, `extension_ui_request`, `get_commands`, `get_session_stats`, and `--session` loading.
- Decompose upstream #19. It has good ideas, but it is too broad and overlaps with narrower PRs.

## Immediate correctness fixes

### 1. Startup info packages/extensions (#37/#36 + #23)

Best solution: rewrite `buildStartupInfo()` to use the existing merged pi settings helper instead of manually reading `~/.pi/agent/settings.json`. Include global and project `packages`, auto-discovered extension files from global/project extension dirs, and respect `PI_CODING_AGENT_DIR`. Remove the fake npm `index.ts` sub-bullet entirely.

Implementation notes:

- Add exported settings/resource helpers in `src/acp/pi-settings.ts` rather than adding more path logic in `agent.ts`.
- Project settings are `.pi/settings.json`; global is `getAgentDir()/settings.json`.
- Prompts path in startup/slash-command code should also use `getAgentDir()` rather than hardcoded `~/.pi/agent`.
- Tests: global-only packages, project-only packages, merge of both, `PI_CODING_AGENT_DIR`, and no fake `index.ts`.

Verdict: do this first. Small, clear, reduces lies.

### 2. Explicit node crypto import (#35)

Best solution: import `randomUUID` from `node:crypto` and use that everywhere instead of global `crypto.randomUUID()`.

Even with `engines >=20`, Zed/npx can pick up project-pinned Node 18. This is cheap defensive compatibility.

Verdict: do immediately.

### 3. Configurable adapter storage dir (#32)

Best solution: add `PI_ACP_DIR` as the explicit override. Default should remain `~/.pi/pi-acp` for backcompat, not silently move existing users. If `PI_CODING_AGENT_DIR` is set and `PI_ACP_DIR` is not, consider using `dirname(PI_CODING_AGENT_DIR)/pi-acp` only behind a migration-aware helper or document the legacy default. Conservative default wins.

Implementation notes:

- `src/acp/paths.ts` should resolve `PI_ACP_DIR`.
- Keep session-map filename stable.
- Hardcoded prompt paths should be fixed separately via `getAgentDir()`.

Verdict: implement `PI_ACP_DIR`; do not relocate defaults without migration.

## Zed-native tool rendering

### 4. Edit/write structured diffs (#29/#19)

Best solution: emit ACP `ToolCallContent { type: "diff", path, oldText, newText }` for edits/writes. The local code already has snapshot-based diff handling in `src/acp/session.ts`; verify it handles pi's current edit schema `{ path, edits: [{ oldText, newText }] }` and write/new-file cases. Prefer snapshot-before + read-after for final accuracy, with pi-provided schema as fallback when filesystem reads fail.

Zed renders diff content as real diff cards when tool kind is `edit`. Raw text success messages are inferior.

Implementation notes:

- Handle live tool execution and restored `toolResult` replay consistently.
- Set `_meta.tool_name` / `tool_name` equivalent so Zed can show names.
- Keep raw input/output for debugging if SDK type allows.
- Tests: edit with multiple replacements, write new file, edit failure, restored tool result.

Verdict: implement targeted, not wholesale #19.

### 5. Bash/terminal rendering (#31/#19)

Best solution for this architecture: set tool `kind` to `execute` for bash, but do **not** emit ACP `terminal` content unless we actually create a client terminal via ACP terminal APIs. Since pi executes locally, terminal content would be semantically wrong without terminal delegation. Use content blocks for stdout/stderr, possibly fenced for non-Zed clients. Zed still improves title rendering for `execute` kind.

If we later choose true client-side terminal delegation, that is a larger design: `terminal/create` -> run command in Zed terminal -> stream/wait/release. That is not pi-acp's current model.

Implementation notes:

- Change kind mapping for `bash` from `other` to `execute`.
- Preserve local execution semantics in comments and tests.
- For Zed, `execute` title is plain text and appropriate for command labels.
- Do not claim `terminal` content without a real terminalId.

Verdict: adopt #31's kind direction, reject fake terminal content.

## Sessions and lifecycle

### 6. Session title + close (#25/#24)

Best solution: implement stable `session/close` and emit `session_info_update.title` from a conservative first-prompt title. Do not use another model call just to title the thread. Zed respects user title overrides separately, so agent-supplied title is safe.

Implementation notes:

- Advertise `sessionCapabilities.close = {}`.
- Add `closeSession({ sessionId })` calling cancel then `SessionManager.close()`.
- Auto-title from first user prompt: strip slash-command wrappers, collapse whitespace, truncate to ~60 chars, avoid titles for empty/binary prompts.
- Do not overwrite an explicit `/name` title.
- Optionally mirror pi session name via `set_session_name` if that doesn't cause surprises.

Verdict: extract the useful parts of #25; don't need fancy title worker.

### 7. Auto-restore after adapter restart (#28)

Best solution: add an `ensureSession(sessionId, opts)` helper in `PiAcpAgent` used by `prompt`, `cancel`, model-setting, and mode-setting methods. If a session isn't live, consult `SessionStore`, spawn `pi --mode rpc --session <stored.sessionFile>`, recreate the `PiAcpSession`, and continue. Do not replay history for this path; this is resume-for-continuation, not explicit `session/load`.

Implementation notes:

- Use stored `cwd`, session file, and incoming `mcpServers` if available.
- Re-load commands/startup state as needed.
- If store has no entry, return the current invalid params error.
- Avoid deleting store mappings on transient spawn failures unless we know the file is gone.
- Tests: prompt after fresh manager with existing session-map, cancel after restart, model/mode after restart, missing file error.

Verdict: high-value Zed durability fix.

### 8. Consider stable `session/resume`

Best solution: after auto-restore, implement ACP `session/resume` as a no-replay attach using the same restore primitive. Zed prefers load or resume for restored panels; resume avoids re-sending history.

Verdict: good follow-up, after #28.

## Pi-native behavior

### 9. Mid-run prompts -> pi streaming behavior / steer (#7)

Best solution: stop doing adapter-only queueing for active turns. Pi RPC now supports `prompt` with `streamingBehavior: "steer" | "followUp"`, plus explicit `steer` and `follow_up`. For a normal second ACP prompt during active streaming, send `prompt` with `streamingBehavior: "steer"` by default so slash/extension commands still work. Expose config/env to use `followUp` if desired.

Implementation notes:

- Update `PiRpcProcess.prompt()` command type to accept `streamingBehavior`.
- In `PiAcpSession.prompt()`, if running, call pi prompt with streaming behavior instead of local queue.
- Preserve cancel semantics.
- Keep `/steering` and `/follow-up` mode commands for delivery mode configuration.

Verdict: do after session correctness; this makes pi-acp more pi-like.

### 10. Extension UI -> ACP permission bridge (#22/#26)

Best solution: bridge only `extension_ui_request` methods `select` and `confirm` to stable `session/request_permission` when tied to an in-flight tool call. Respond back to pi with `extension_ui_response`. Drop or text-log unsupported `input`/`editor` until ACP elicitation stabilizes.

Important correction from research: this is **not** blocked on a new pi hook. Pi RPC already emits `extension_ui_request` and expects `extension_ui_response`.

Implementation notes:

- `PiRpcProcess` needs a generic send for `extension_ui_response` or typed helper.
- `PiAcpSession` needs to track current/in-flight tool calls enough to populate `toolCall` in permission request.
- Map `confirm`: Allow/Deny options -> `{ confirmed: true/false }`.
- Map `select`: options -> permission options; return selected option value via `value`.
- On ACP cancelled or timeout, send `{ cancelled: true }` unless pi timeout already handled it.
- On `session/cancel`, cancel pending permission requests.

Verdict: high strategic value for safety; implement after tool/session basics.

## Auth and provider behavior

### 11. Runtime auth/provider detection (#15/#17/#18/#10)

Best solution: avoid static env-var whack-a-mole as the primary signal. Let pi start far enough to load extensions/providers, call `get_available_models`, and classify actual runtime errors via `maybeAuthRequiredError`. Add an explicit `PI_ACP_SKIP_PI_AUTH=1` escape hatch for dynamic-provider users if any preflight remains. Vertex env vars can be accepted, but they are a partial fix, not the strategy.

Implementation notes:

- Inspect upstream `fix/runtime-auth-detection` before editing.
- Terminal auth meta is Zed-specific but useful; keep it.
- If ACP auth methods stabilize typed terminal auth, support both typed and `_meta["terminal-auth"]`.
- Tests: no models with auth-like error -> authRequired; dynamic provider bypass -> spawn allowed; Vertex env recognized only as compatibility.

Verdict: rewrite around runtime classification; don't grow a giant env allowlist.

## Commands and metadata

### 12. Extension slash commands (#20/#19)

Best solution: expose extension commands by default for this fork, with `PI_ACP_ENABLE_EXTENSION_COMMANDS=0` and settings override for users who want less noise. Pi users expect extension commands to exist; Zed's slash palette is the correct ACP surface.

Implementation notes:

- `get_commands` already returns source; `toAvailableCommandsFromPiGetCommands()` currently filters extension commands.
- Add `getEnableExtensionCommands(cwd)` beside `getEnableSkillCommands`.
- Send `available_commands_update` after new/load/restore.
- Tests for env > project > global > default.

Verdict: implement separately, not via #19 blob.

### 13. Usage telemetry/session metadata (#19)

Best solution: gate usage telemetry behind `PI_ACP_ENABLE_USAGE_UPDATE=1` or auto-enable only for Zed beta-capable clients if reliable. ACP usage_update remains draft/RFD-ish and Zed may gate rendering behind beta flags. Still, pi has `get_session_stats`, so implementation is easy once gated.

Implementation notes:

- Emit stable `session_info_update._meta.piAcp` freely for version/model/sessionFile/debug metadata.
- For `usage_update`, use `get_session_stats()` after prompt completion and maybe after session create/load.
- Avoid inline text status for Zed when native rendering works; allow `PI_ACP_USAGE_STATUS=always|never|auto` if implemented.

Verdict: lower priority; useful but should not block correctness.

### 14. `/version`

Best solution: add a small built-in slash command returning package version, git sha if embedded, SDK version, and pi version. Useful during Zed debugging.

Verdict: cheap, but not urgent.

## CLI and compatibility

### 15. Forward pi CLI args (#21)

Best solution: support explicit `--` passthrough first. Be cautious about forwarding all unknown pi-acp args by default because it constrains future adapter CLI design. Zed custom agent server settings can pass args, so `pi-acp -- --model ...` is acceptable.

Implementation notes:

- If adopting upstream PR, change policy to explicit passthrough unless we deliberately want unknown forwarding.
- Strip adapter-owned flags only in the passthrough segment.
- Tests are straightforward.

Verdict: implement explicit passthrough; don't make unknown-forwarding the default unless Matt wants convenience over future CLI hygiene.

### 16. Windows/IntelliJ (#27/#33)

Best solution: keep spawn resolution robust (`pi`, `pi.cmd`, `pi.exe`) without contaminating core logic. IntelliJ hangs need more protocol logs before action.

Verdict: opportunistic small fix for Windows launcher; defer IntelliJ.

## Recommended implementation order

1. Crypto import, startup info packages, remove fake `index.ts`, hardcoded paths.
2. Edit/write diff correctness and bash kind rendering.
3. Session title/close and auto-restore.
4. Runtime auth detection and extension commands.
5. Mid-run steer/follow-up.
6. Permission bridge.
7. Usage telemetry, `/version`, CLI passthrough, Windows niceties.

This order front-loads low-risk correctness, then Zed UX, then deeper protocol behavior.
