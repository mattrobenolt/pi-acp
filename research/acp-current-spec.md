# ACP Current Spec & SDK Research — pi-acp Upstream Adoption

**Date:** 2026-05-14  
**SDK version at time of research:** `@agentclientprotocol/sdk` v0.21.1 (latest: v0.21.0 on npm, repo last pushed 2026-04-14)  
**pi-acp package version:** 0.0.27  
**ACP protocol version:** 1 (single integer; only incremented on breaking changes)

Sources: https://agentclientprotocol.com/protocol/schema, https://agentclientprotocol.com/protocol/tool-calls, https://agentclientprotocol.com/protocol/prompt-turn, https://agentclientprotocol.com/protocol/session-setup, https://agentclientprotocol.com/protocol/slash-commands, https://agentclientprotocol.com/protocol/initialization, https://agentclientprotocol.com/rfds/session-usage, https://agentclientprotocol.com/rfds/session-info-update, https://agentclientprotocol.com/updates, https://github.com/agentclientprotocol/typescript-sdk

---

## Summary

ACP is a JSON-RPC 2.0 protocol over NDJSON stdio between code editors (clients) and AI coding agents. pi-acp is currently on SDK `^0.21.1` and implements the main stable surface well. The areas below have had recent spec changes (stabilizations, new fields, schema deltas) that pi-acp either partially implements, uses non-standard workarounds for, or hasn't touched yet.

---

## 1. `session_info_update` — Stabilized March 9, 2026

**Status:** Stabilized (was UNSTABLE). pi-acp already emits it.

### Spec schema

Sent as a `session/update` notification. `SessionUpdate` discriminated on `sessionUpdate` field.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123",
    "update": {
      "sessionUpdate": "session_info_update",
      "title": "My session title",
      "updatedAt": "2026-05-14T12:00:00.000Z",
      "_meta": { "custom": "data" }
    }
  }
}
```

**`SessionInfoUpdate` fields (all optional):**

- `sessionUpdate: "session_info_update"` — discriminator (required)
- `title?: string | null` — update or clear the human-readable session title
- `updatedAt?: string | null` — ISO 8601 timestamp
- `_meta?: object | null` — custom metadata, merged with existing (not replaced wholesale)

**What's excluded:** `sessionId` (already in params) and `cwd` (immutable, set at `session/new`).

**Semantics:** Each notification is a delta, not a full replacement. Fields set to `null` explicitly clear the value. `_meta` is merged, not overwritten.

**No new capability required** — any agent supporting `session/update` can emit this variant. Clients that don't recognize it will ignore it.

### pi-acp current state

Already used in two contexts:

1. **Queue depth metadata** — emits `session_info_update` with `_meta: { piAcp: { queueDepth, running } }` to track turn queue state
2. **`/name` command** — emits `session_info_update` with `title` and `updatedAt` when user explicitly names the session

The `_meta` approach is non-standard but valid under ACP extensibility rules. The `title`/`updatedAt` usage in `/name` is exactly what the spec intends. No changes needed for compliance; the implementation is correct.

**Implication:** pi-acp could also auto-emit `title` after the first agent turn (summarize the conversation subject). The spec was designed to support this pattern — agents setting the title dynamically based on conversation content.

---

## 2. `session/close` and Session Lifecycle — Stabilized April 23, 2026

**Status:** Stabilized. pi-acp does NOT implement this.

### Spec schema

Requires capability advertisement in `initialize` response:

```json
{
  "agentCapabilities": {
    "sessionCapabilities": {
      "close": {}
    }
  }
}
```

Request (client → agent):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/close",
  "params": { "sessionId": "sess_xyz" }
}
```

Response:

```json
{ "jsonrpc": "2.0", "id": 2, "result": {} }
```

**Semantics:** Agent MUST cancel any in-flight work (as if `session/cancel` was called) and then free all resources associated with the session. May return an error if session doesn't exist or isn't active. `CloseSessionRequest` has only `sessionId` (required) and `_meta` (optional). `CloseSessionResponse` is empty (just `_meta`).

### Session lifecycle as a whole

Full lifecycle methods and their capability flags:

- `session/new` — baseline, no capability flag needed
- `session/load` — requires `agentCapabilities.loadSession: true` (top-level, not in `sessionCapabilities`)
- `session/resume` — requires `agentCapabilities.sessionCapabilities.resume: {}` (stabilized April 22, 2026)
- `session/close` — requires `agentCapabilities.sessionCapabilities.close: {}`
- `session/list` — requires `agentCapabilities.sessionCapabilities.list: {}` (pi-acp uses `unstable_listSessions`)
- `session/cancel` — baseline, no capability flag

Note: `session/load` is still under the top-level `loadSession` boolean, not `sessionCapabilities`. The spec says this will be unified in a future version.

### pi-acp current state

pi-acp implements `session/load` and `session/list` (via `unstable_listSessions`). It has `SessionManager.close()` internally but does not expose it via the ACP `session/close` method. It does NOT advertise `sessionCapabilities.close`.

**Implication:** To implement `session/close`, pi-acp needs to:

1. Add `close: {}` to `sessionCapabilities` in `initialize`
2. Implement a `closeSession(params: CloseSessionRequest)` method on the agent that calls `session.cancel()` then `sessions.close(params.sessionId)` — the internal machinery already exists

### `session/resume` (also newly stabilized)

pi-acp does not implement `session/resume`. The difference from `session/load`: resume does NOT replay conversation history via `session/update` notifications. It just restores context and returns. Useful for reconnecting without re-rendering history.

To add: advertise `sessionCapabilities.resume: {}`, implement `resumeSession()` that spawns pi with the existing session file and returns immediately (no message replay).

---

## 3. `session/request_permission` — Stable, Pi-acp doesn't implement

**Status:** Stable part of baseline protocol.

### Spec schema

This is a **request from agent to client** (reversed direction). The agent calls it; the client responds.

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123",
    "toolCall": {
      "toolCallId": "call_001",
      "sessionUpdate": "tool_call_update"
      // ...any ToolCallUpdate fields
    },
    "options": [
      { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
    ]
  }
}
```

**`RequestPermissionRequest` fields:**

- `sessionId: SessionId` (required)
- `toolCall: ToolCallUpdate` (required) — details about the operation needing permission
- `options: PermissionOption[]` (required)

**`PermissionOption` fields:**

- `optionId: string` (required) — returned in response
- `name: string` (required) — label for UI
- `kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"` (required)

**`RequestPermissionResponse`:**

```json
{
  "outcome": {
    "outcome": "selected",
    "optionId": "allow-once"
  }
}
```

or if cancelled:

```json
{ "outcome": { "outcome": "cancelled" } }
```

**`RequestPermissionOutcome`** is a discriminated union on `outcome` field: `"selected"` (with `optionId`) or `"cancelled"`.

**Critical rule:** If the client sends `session/cancel` while a permission request is in flight, the client MUST respond to the pending `session/request_permission` with `outcome: "cancelled"`. The agent must handle this.

### pi-acp current state

pi-acp does NOT implement permission requests. Pi executes all tools autonomously. This is a fundamental design choice — pi handles its own permission model internally (it has its own `--allow-all`, `--auto-approve` flags etc.). ACP permission requests would require intercepting tool execution at the pi RPC level, which would need a new pi RPC event type before executing a tool call.

**Implication:** This is architecturally blocked on pi exposing a pre-execution hook. Not something pi-acp can implement unilaterally today.

---

## 4. `ToolCallContent` schemas — `diff`, `execute`, `terminal`

**Status:** Stable.

`ToolCallContent` is a discriminated union on the `type` field. Three variants:

### `type: "content"` — standard content block

```json
{
  "type": "content",
  "content": {
    "type": "text",
    "text": "Analysis complete."
  }
}
```

`content` is a `ContentBlock` (text, image, resource, resource_link, audio).

### `type: "diff"` — file modification

```json
{
  "type": "diff",
  "path": "/absolute/path/to/file.ts",
  "oldText": "original content",
  "newText": "new content"
}
```

Fields:

- `path: string` (required) — absolute file path
- `oldText?: string | null` — original content; `null` for new file creation
- `newText: string` (required) — content after modification; empty string = deletion (with non-null `oldText`)
- `_meta?: object | null`

There is no `type: "execute"` variant — this appears to be a misread of the `ToolKind` enum. The `kind` field on a tool call (not on the content) can be `"execute"` to indicate the tool is running commands.

### `type: "terminal"` — live terminal output

```json
{
  "type": "terminal",
  "terminalId": "term_xyz789"
}
```

Fields:

- `terminalId: string` (required) — ID from a prior `terminal/create` response
- `_meta?: object | null`

When embedded in a tool call, the client displays live output as it's generated and keeps displaying it even after `terminal/release` is called. The terminal content type is a reference — it points to a terminal managed by the client's `terminal/*` API.

### `ToolKind` enum values

Used in the `kind` field of `tool_call` / `tool_call_update` notifications. Not part of `ToolCallContent`:
`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`

### pi-acp current state

pi-acp implements `diff` correctly for edit operations (captures pre-edit file content, reads post-edit content, emits structured diff). It also emits `content` blocks for text. It does NOT use `terminal` content because pi runs bash internally rather than delegating to the client's terminal API. That's intentional — using the client terminal would require the agent to compose `terminal/create` → embed terminalId → `terminal/wait_for_exit` → `terminal/release`, all of which requires the client to have `terminal: true` capability.

**Implication for `execute` kind:** pi-acp maps `bash` tool calls to `kind: "other"` deliberately (comment in code explains: many clients render `execute` kind via terminal API only). This is correct given pi-acp's architecture. If/when pi-acp were to delegate terminal execution to the client, the `terminal` content type would be the right approach.

---

## 5. `usage_update` — RFD status: Draft (not stabilized)

**Status:** RFD in draft as of 2025-12-19. NOT yet part of stable spec. Not in current SDK types as stable.

### Proposed schema

Two-part design:

**Part 1: `usage` field in `PromptResponse`** (per-turn token counts)

```json
{
  "stopReason": "end_turn",
  "usage": {
    "total_tokens": 53000,
    "input_tokens": 35000,
    "output_tokens": 12000,
    "thought_tokens": 5000,
    "cached_read_tokens": 5000,
    "cached_write_tokens": 1000
  }
}
```

- `total_tokens`, `input_tokens`, `output_tokens` — required
- `thought_tokens`, `cached_read_tokens`, `cached_write_tokens` — optional

**Part 2: `session/update` with `sessionUpdate: "usage_update"`** (session-level context/cost)

```json
{
  "sessionUpdate": "usage_update",
  "used": 53000,
  "size": 200000,
  "cost": {
    "amount": 0.045,
    "currency": "USD"
  }
}
```

- `used: number` (required) — tokens currently in context
- `size: number` (required) — total context window size
- `cost?: { amount: number, currency: string }` — optional, cumulative session cost

Clients should send `usage_update` on `session/new`, `session/load`, `session/resume`, and after each `session/prompt` response.

### pi-acp current state

pi-acp's `/session` command already fetches `getSessionStats()` from pi RPC which includes `cost` and `tokens` (input, output, cacheRead, cacheWrite, total). This data could directly populate both the `PromptResponse.usage` field and `usage_update` notifications once the RFD stabilizes.

**Implication:** When this stabilizes (likely near-term given the RFD is complete and detailed), pi-acp would:

1. Add `usage` to `PromptResponse` after `agent_end` by calling `getSessionStats()`
2. Emit `session_update` with `sessionUpdate: "usage_update"` after prompt completion

The pi RPC `getSessionStats()` already returns the right shape. The main work is wiring it to emit at the right times.

---

## 6. Slash Commands / `available_commands_update`

**Status:** Stable. pi-acp implements this.

### Spec schema

Agent sends this notification after `session/new` or `session/load` to advertise available slash commands:

```json
{
  "sessionUpdate": "available_commands_update",
  "availableCommands": [
    {
      "name": "web",
      "description": "Search the web for information",
      "input": { "hint": "query to search for" }
    },
    {
      "name": "test",
      "description": "Run tests for the current project"
    }
  ]
}
```

**`AvailableCommand` fields:**

- `name: string` (required) — command name without `/` prefix (e.g., `"web"`, `"test"`)
- `description: string` (required) — human-readable description
- `input?: AvailableCommandInput | null` — optional; if present, has `hint: string` (required)

**`AvailableCommandInput`:** currently only supports unstructured text. `hint` is shown when input hasn't been provided.

Commands are invoked as regular `session/prompt` requests with the command text as a `ContentBlock::Text` starting with `/`:

```json
{ "type": "text", "text": "/web agent client protocol" }
```

The agent recognizes the `/command` prefix and handles accordingly. Commands can be updated dynamically at any time by sending another `available_commands_update`.

### pi-acp current state

Implemented correctly. pi-acp:

1. Sends `available_commands_update` after both `session/new` and `session/load` (deferred via `setTimeout` so the client has registered the sessionId first)
2. Merges pi's native commands (from `getCommands()`) with file-based prompt templates (`~/.pi/agent/prompts/**/*.md`) and built-in commands (`/compact`, `/session`, `/name`, `/steering`, `/follow-up`, `/changelog`, `/export`, `/autocompact`)
3. Handles slash commands in `prompt()` before forwarding to pi

One subtle issue: the setTimeout delay is a workaround for clients ignoring notifications for unregistered sessionIds. This is correct behavior but fragile — some clients may have race conditions with very slow notification processing.

---

## 7. Authentication / `authRequired` / Terminal Auth

**Status:** Auth methods are stable. The "terminal auth" extension pattern is a client-specific convention (Zed), not standardized in ACP.

### Spec schema

**In `initialize` response:**

```json
{
  "authMethods": [
    {
      "id": "my_auth_method",
      "name": "Login",
      "description": "Optional description"
    }
  ]
}
```

`AuthMethod` (stable fields):

- `id: string` (required)
- `name: string` (required)
- `description?: string | null`
- `_meta?: object | null`
- No `type` field in the stable spec — the "type/args/env" shape is from a draft RFD on auth methods

**`auth_required` error:** When agent returns an error with code -32001 (ACP-defined) and `data: { authMethods: AuthMethod[] }`. This causes the client to prompt the user to authenticate.

**`authenticate` request (client → agent):**

```json
{ "methodId": "my_auth_method" }
```

Response is empty `{}`. After this, the client can proceed to `session/new`.

### pi-acp current state

pi-acp's auth approach is dual-format:

```typescript
const method: any = {
  id: PI_SETUP_METHOD_ID,
  name: 'Launch pi in the terminal',
  description: '...',
  // Draft RFD fields (registry-required):
  type: 'terminal',
  args: ['--terminal-login'],
  env: {}
}
// Zed-specific extension:
method._meta = {
  'terminal-auth': {
    command: 'pi-acp',
    args: ['--terminal-login'],
    label: 'Launch pi'
  }
}
```

The Zed-specific `_meta["terminal-auth"]` shape is NOT in the ACP spec — it's a Zed extension convention. The `type: "terminal"` / `args` / `env` fields are from an unreleased Auth Methods RFD that's been in draft for a while. Neither is in the stable spec.

pi-acp detects auth failures by pattern-matching error messages from pi's stderr/output against strings like "api key", "unauthorized", "401", etc. This is fragile but workable given pi's current error reporting.

The `authenticate()` handler is a no-op — it just returns successfully, because the actual auth flow happens out-of-band in a terminal.

**Implication:** The current approach is pragmatic but tied to Zed's convention. If other clients adopt different terminal-auth conventions, pi-acp would need to adapt. Watch the Auth Methods RFD for stabilization.

---

## 8. Prompt Behavior During Active Turns

### What the spec says

The spec does not define a rule preventing new `session/prompt` requests while a turn is active. The agent is expected to handle or queue them. The spec does say:

- Clients send `session/cancel` to abort an active turn
- On cancel, agent MUST eventually respond to the `session/prompt` with `stopReason: "cancelled"`
- Agent MAY still send `session/update` notifications after receiving `session/cancel`, but MUST do so before responding to the prompt
- Clients SHOULD still accept tool call updates after sending `session/cancel`
- If a permission request is in flight when cancel arrives, client MUST respond with `outcome: "cancelled"`

There is no spec prohibition on queueing prompts, but there's also no defined protocol for it. Clients that send a second prompt while one is active are technically doing something outside the documented flow.

### pi-acp current state

pi-acp implements a turn queue internally. If a second `session/prompt` arrives while a turn is active, it's queued. A notification is sent to the client:

```
"Queued message (position N)."
```

And a `session_info_update` with `_meta: { piAcp: { queueDepth: N, running: true } }`.

When the active turn completes, the next queued prompt starts and the client gets:

```
"Starting queued message. (N remaining)"
```

**The comment in the code notes that queueing notifications "doesn't work in Zed yet."** Zed likely doesn't display agent messages sent outside of a response-to-prompt context. This is a Zed rendering limitation, not an ACP spec issue.

**Cancel behavior:** `cancel()` aborts the current turn via `proc.abort()` AND resolves all queued turns with `'cancelled'`. The ACP stop reason for a cancelled turn is correctly returned as `"cancelled"`.

The `wasCancelRequested()` check is used in error handling: if pi's subprocess rejects its promise AND cancel was requested, we return `'cancelled'` rather than treating it as an error.

---

## 9. `session/list` and `SessionInfo` shape

**Status:** Stabilized March 9, 2026. pi-acp uses `unstable_listSessions`.

### Spec schema

`SessionInfo` (what `session/list` returns per-session, and what `session_info_update` mirrors):

- `sessionId: SessionId` (required)
- `cwd: string` (required)
- `title?: string | null`
- `updatedAt?: string | null` — ISO 8601

`ListSessionsRequest`:

- `cwd?: string | null` — filter by working directory
- `cursor?: string | null` — for pagination

`ListSessionsResponse`:

- `sessions: SessionInfo[]` (required)
- `nextCursor?: string | null`

### pi-acp current state

Implemented as `unstable_listSessions` which maps to `session/list` under the unstable capability `list: {}`. The implementation is functionally correct — cursor-based pagination, cwd filtering, correct `SessionInfo` shape. The method name `unstable_listSessions` in the SDK corresponds to the now-stable `session/list` method. This should be renamed if/when the SDK exposes a stable `listSessions` method.

---

## 10. Key Gaps and Implementation Priorities

**Ready to implement (unblocked):**

1. **`session/close`** — `SessionManager.close()` already exists internally; just needs the ACP method, capability advertisement, and handler. Low effort, high value for clients that want clean teardown.

2. **`session/resume`** — Similar to `session/load` but without message replay. Needs capability advertisement. Medium effort.

3. **`usage_update` (when stabilized)** — pi RPC's `getSessionStats()` already returns the needed data. Wire it to emit after `agent_end`.

4. **Rename `unstable_listSessions` → `listSessions`** — when SDK v0.21+ exposes the stable method name.

**Architecturally blocked:**

5. **`session/request_permission`** — needs pi to expose a pre-execution hook. Not feasible without changes to pi's RPC protocol.

**Not applicable / intentional:**

6. **`terminal` content type for bash** — pi runs bash internally. Delegating to client terminals would require pi to support it natively. Current `kind: "other"` mapping for bash is correct for now.

---

## 11. SDK Notes (`@agentclientprotocol/sdk` v0.21.x)

- Transport: `ndJsonStream` over stdio (NDJSON). Only transport currently in stable spec.
- Core classes: `AgentSideConnection` (agent side), `ClientSideConnection` (client side)
- All protocol types exported directly from the package (TypeScript + Zod validation)
- `PROTOCOL_VERSION` constant = `1`
- `RequestError.authRequired(data, message)` — static helper for auth errors
- `RequestError.invalidParams(message)` — static helper
- `RequestError.internalError(data, message)` — static helper
- The SDK's `unstable_*` method names (like `unstable_listSessions`, `unstable_setSessionModel`) correspond to capabilities that were unstable at SDK release time; some have since stabilized in the spec but may not yet be renamed in the SDK
- v0.21.0 was released 2026-04-14; v0.21.1 (what pi-acp uses) appears to be a patch on top of that
