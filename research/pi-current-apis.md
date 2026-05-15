# Pi Coding Agent — Current API Reference for pi-acp

Researched from the installed package at `~/.pi/agent/node_modules/@earendil-works/pi-coding-agent@0.74.0` docs.
Source docs base: `~/.pi/agent/node_modules/@earendil-works/pi-coding-agent/docs/`

---

## RPC Mode

Launch with `pi --mode rpc [options]`. Protocol is JSONL over stdin/stdout, LF-delimited.

**Important framing detail:** Split on `\n` only — do NOT use Node `readline` because it also splits on U+2028 and U+2029 (valid in JSON strings). Strip optional trailing `\r`.

Commands go to stdin; events and responses come from stdout. Commands have an optional `id` field for correlation. Events never have `id`.

### Command → Response pattern

```json
// stdin
{"id": "req-1", "type": "prompt", "message": "Hello"}

// stdout (response)
{"id": "req-1", "type": "response", "command": "prompt", "success": true}

// stdout (events, async)
{"type": "agent_start"}
{"type": "message_update", "message": {...}, "assistantMessageEvent": {...}}
...
{"type": "agent_end", "messages": [...]}
```

Error response shape:

```json
{ "type": "response", "command": "set_model", "success": false, "error": "Model not found: ..." }
```

---

## Prompting Commands

### `prompt`

Send a user message. Optional `images: ImageContent[]`.

During active streaming, must specify `streamingBehavior`:

- `"steer"` — delivers after current tool calls finish, before next LLM call
- `"followUp"` — delivers only after agent is fully idle

Extension slash commands (e.g. `/mycommand`) execute immediately even during streaming. Skill commands (`/skill:name`) and prompt templates are expanded before delivery.

```json
{"type": "prompt", "message": "Refactor this", "streamingBehavior": "steer"}
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64...", "mimeType": "image/png"}]}
```

### `steer`

Queue a steering message (no extension commands allowed here; use `prompt` for those). Delivered after current turn's tool calls finish, before next LLM call.

```json
{ "type": "steer", "message": "Stop — focus on error handling instead" }
```

### `follow_up`

Queue a follow-up for when the agent is fully idle.

```json
{ "type": "follow_up", "message": "After that, write tests" }
```

### `abort`

Abort the current operation immediately.

```json
{ "type": "abort" }
```

---

## Queue Mode Control

### `set_steering_mode`

Controls how steering messages queued via `steer` are delivered.

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
// or
{"type": "set_steering_mode", "mode": "all"}
```

- `"one-at-a-time"` (default) — one steering message per completed assistant turn
- `"all"` — deliver all queued messages at once after current turn

Also settable in `settings.json` as `steeringMode`.

### `set_follow_up_mode`

Same shape as above, for follow-up messages. `"one-at-a-time"` is default. Setting: `followUpMode`.

```json
{ "type": "set_follow_up_mode", "mode": "all" }
```

---

## Session Loading

### `--session <path|id>` CLI flag

Loads a specific session file by path or partial UUID. Partial UUID matching searches `sessionDir`. Takes precedence over `--continue`/`--resume`.

```bash
pi --mode rpc --session abc123           # partial UUID
pi --mode rpc --session /path/to/session.jsonl
```

### `--fork <path|id>`

Like `--session` but forks the session into a new file before starting. Original is preserved.

### Session directory precedence

1. `--session-dir` CLI flag
2. `PI_CODING_AGENT_SESSION_DIR` env var
3. `sessionDir` in `settings.json`
4. Default: `~/.pi/agent/sessions/` (organized by CWD)

### `switch_session` RPC command

Load a different session at runtime. Can be cancelled by an extension's `session_before_switch` handler.

```json
{ "type": "switch_session", "sessionPath": "/path/to/session.jsonl" }
// Response includes: {"data": {"cancelled": false}}
```

### `new_session` RPC command

Start a fresh session. Optional `parentSession` field for tracking lineage.

```json
{ "type": "new_session", "parentSession": "/path/to/parent.jsonl" }
```

---

## Extension UI Protocol (RPC mode)

When extensions call `ctx.ui.select()`, `ctx.ui.confirm()`, etc., these become a request/response sub-protocol layered on top of the normal event stream.

Two categories:

**Dialog methods** (block until client responds): `select`, `confirm`, `input`, `editor`

These emit `extension_ui_request` to stdout with a unique `id`. The client must send back `extension_ui_response` with the matching `id`. If the request has a `timeout` field, the agent auto-resolves with a default after timeout — client doesn't need to track it.

**Fire-and-forget** (no response expected): `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`

### Requests (stdout)

```json
// select — user picks from options
{"type": "extension_ui_request", "id": "uuid-1", "method": "select",
 "title": "Allow?", "options": ["Allow", "Block"], "timeout": 10000}

// confirm — yes/no
{"type": "extension_ui_request", "id": "uuid-2", "method": "confirm",
 "title": "Clear session?", "message": "All messages will be lost.", "timeout": 5000}

// input — free text
{"type": "extension_ui_request", "id": "uuid-3", "method": "input",
 "title": "Enter value", "placeholder": "type something..."}

// editor — multiline
{"type": "extension_ui_request", "id": "uuid-4", "method": "editor",
 "title": "Edit text", "prefill": "Line 1\nLine 2"}

// notify — fire-and-forget, notifyType: "info" | "warning" | "error"
{"type": "extension_ui_request", "id": "uuid-5", "method": "notify",
 "message": "Done", "notifyType": "info"}

// setStatus — footer status bar
{"type": "extension_ui_request", "id": "uuid-6", "method": "setStatus",
 "statusKey": "my-ext", "statusText": "Turn 3..."}

// setWidget — text block above/below editor
{"type": "extension_ui_request", "id": "uuid-7", "method": "setWidget",
 "widgetKey": "my-ext", "widgetLines": ["Line 1"], "widgetPlacement": "aboveEditor"}
```

### Responses (stdin, for dialog methods only)

```json
// select/input/editor value
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}

// confirm
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}

// cancel any dialog
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

**RPC degradation:** `ctx.hasUI` is `true` in RPC mode. `ctx.ui.custom()` returns `undefined`. `setWorkingMessage()`, `setWorkingIndicator()`, `setFooter()`, `setHeader()`, `setEditorComponent()`, `setToolsExpanded()` are no-ops. `getEditorText()` returns `""`. `getAllThemes()` returns `[]`. `getTheme()` returns `undefined`. `setTheme()` returns `{success: false}`.

---

## Tool Execution Events

### RPC events (stdout)

```json
// Tool starts (preflight order for parallel tools)
{"type": "tool_execution_start", "toolCallId": "call_abc", "toolName": "bash", "args": {"command": "ls"}}

// Streaming partial output (accumulated, not delta)
{"type": "tool_execution_update", "toolCallId": "call_abc", "toolName": "bash",
 "args": {"command": "ls"},
 "partialResult": {"content": [{"type": "text", "text": "partial..."}], "details": {"truncation": null, "fullOutputPath": null}}}

// Tool completes
{"type": "tool_execution_end", "toolCallId": "call_abc", "toolName": "bash",
 "result": {"content": [{"type": "text", "text": "total 48\n..."}], "details": {...}},
 "isError": false}
```

`partialResult.content` is the accumulated output so far (replace your display on each update, don't append).

### Tool names for built-in tools

Standard names: `bash`, `read`, `write`, `edit`. Extensions add custom tool names.

### Extension-side tool events

```typescript
pi.on('tool_call', async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input (mutable)
  // Return {block: true, reason: "..."} to block execution
})

pi.on('tool_result', async (event, ctx) => {
  // event.toolName, event.toolCallId, event.content, event.details, event.isError
  // Return partial patch: {content?, details?, isError?}
})

pi.on('tool_execution_start', async (event, ctx) => {
  /* event.toolCallId, event.toolName, event.args */
})
pi.on('tool_execution_update', async (event, ctx) => {
  /* + event.partialResult */
})
pi.on('tool_execution_end', async (event, ctx) => {
  /* + event.result, event.isError */
})
```

Type guards available: `isToolCallEventType("bash", event)`, `isBashToolResult(event)` (narrows `event.details` to `BashToolDetails`).

`event.input` is mutable in `tool_call` — mutations propagate to actual execution and to later handlers. No re-validation after mutation.

Parallel tool execution: `tool_execution_start` fires in source order (preflight), `tool_execution_update` interleaves, `tool_execution_end` fires in completion order, final `toolResult` message events emit in source order.

---

## `get_commands`

Lists all available slash commands: extension commands, prompt templates, skills.

```json
{ "type": "get_commands" }
```

Response:

```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {
        "name": "session-name",
        "description": "Set or clear session name",
        "source": "extension",
        "path": "/home/user/.pi/agent/extensions/session.ts"
      },
      {
        "name": "fix-tests",
        "description": "Fix failing tests",
        "source": "prompt",
        "location": "project",
        "path": "/home/user/myproject/.pi/agent/prompts/fix-tests.md"
      },
      {
        "name": "skill:brave-search",
        "description": "Web search via Brave API",
        "source": "skill",
        "location": "user",
        "path": "/home/user/.pi/agent/skills/brave-search/SKILL.md"
      }
    ]
  }
}
```

Fields:

- `source`: `"extension"` | `"prompt"` | `"skill"`
- `location`: `"user"` | `"project"` | `"path"` (not present for extension-source commands)
- `path`: absolute path to source file (optional)

**Note:** Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are NOT included. Invoke via `prompt` with a `/` prefix.

Extension-side equivalent: `pi.getCommands()` returns the same list with richer `sourceInfo` including `scope` (`"user"` | `"project"` | `"temporary"`) and `origin` (`"package"` | `"top-level"`).

Extension commands registered via `pi.registerCommand(name, options)`. If multiple extensions register the same name, they get numeric suffixes (`/review:1`, `/review:2`). Supports `getArgumentCompletions` for autocomplete.

---

## Settings and Package Discovery

### Settings files

| Location                    | Scope                      |
| --------------------------- | -------------------------- |
| `~/.pi/agent/settings.json` | Global                     |
| `.pi/settings.json`         | Project (overrides global) |

Project settings do a **deep merge** for nested objects (e.g. `compaction`), not a replacement.

Relevant settings for pi-acp:

```json
{
  "packages": ["npm:@foo/bar", "git:github.com/user/repo@v1"],
  "extensions": ["/absolute/path/ext.ts", "./relative-to-settings-dir.ts"],
  "skills": [...],
  "prompts": [...],
  "themes": [...],
  "enableSkillCommands": true,
  "sessionDir": ".pi/sessions",
  "steeringMode": "one-at-a-time",
  "followUpMode": "one-at-a-time",
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "enabledModels": ["claude-*", "gpt-4o"]
}
```

### `PI_CODING_AGENT_DIR`

Overrides the entire config directory (default `~/.pi/agent`). All relative paths in settings resolve relative to this directory.

Other env vars:

- `PI_CODING_AGENT_SESSION_DIR` — session storage override (lower priority than `--session-dir`)
- `PI_PACKAGE_DIR` — override package install directory (useful for Nix/Guix store)
- `PI_OFFLINE=1` — disable all startup network ops (update checks, telemetry)
- `PI_SKIP_VERSION_CHECK=1` — skip only version check
- `PI_TELEMETRY=0` — disable install telemetry only

### Package discovery order

1. Global `~/.pi/agent/settings.json` → `packages` array
2. Project `.pi/settings.json` → `packages` array (project entry wins on duplicate identity)
3. CLI `-e` / `--extension` flags (temporary, not persisted)

Package identity: npm by name, git by URL (without ref), local by resolved absolute path.

Auto-discovered resource directories (no config needed):

- `~/.pi/agent/extensions/*.ts` and `extensions/*/index.ts`
- `.pi/extensions/*.ts` and `.pi/extensions/*/index.ts`
- Same pattern for `skills/`, `prompts/`, `themes/`

### `resources_discover` extension event

Extensions can contribute additional resource paths dynamically:

```typescript
pi.on('resources_discover', async (event, _ctx) => {
  // event.cwd, event.reason ("startup" | "reload")
  return {
    skillPaths: ['/path/to/skills'],
    promptPaths: ['/path/to/prompts'],
    themePaths: ['/path/to/themes']
  }
})
```

---

## Auth and Model Discovery

### Auth file: `~/.pi/agent/auth.json`

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "openai": { "type": "api_key", "key": "sk-..." },
  "google": { "type": "api_key", "key": "..." }
}
```

Key field supports:

- `"sk-ant-..."` — literal
- `"MY_ENV_VAR"` — env var name (resolved at request time)
- `"!command"` — shell command, stdout used as key (cached for process lifetime)

Auth file credentials take priority over environment variables. Created with `0600` permissions.

Credential resolution order: CLI `--api-key` → `auth.json` → env var → `models.json` provider keys.

### Dynamic provider registration (extensions)

```typescript
export default async function (pi: ExtensionAPI) {
  // Async factory — awaited before session_start, so models available at startup
  const res = await fetch('http://localhost:1234/v1/models')
  const { data } = await res.json()

  pi.registerProvider('local-llm', {
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'LOCAL_API_KEY', // env var name or literal
    api: 'openai-completions',
    models: data.map(m => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.context_window ?? 128000,
      maxTokens: m.max_tokens ?? 4096
    }))
  })
}
```

`pi.registerProvider()` can also override existing providers (e.g. redirect Anthropic through a proxy) by specifying only `baseUrl` and/or `headers` without `models`.

### Custom models via `models.json`

`~/.pi/agent/models.json` — loaded on `/model` open (hot-reloadable without restart):

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "llama3.1:8b" }]
    }
  }
}
```

Supported APIs: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`.

Provider fields: `baseUrl`, `api`, `apiKey`, `headers`, `authHeader`, `models`, `modelOverrides`, `compat`.

`compat` fields for OpenAI-compatible servers that don't support certain features:

```json
{ "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false } }
```

### RPC model commands

```json
// List all configured models
{"type": "get_available_models"}
// Response: {"data": {"models": [<Model objects>]}}

// Switch model
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}

// Cycle to next model in configured list
{"type": "cycle_model"}
// Response: {"data": {"model": {...}, "thinkingLevel": "medium", "isScoped": false}}
```

Model object shape:

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": { "input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 3.75 }
}
```

---

## Full Event Type Reference

| Event                   | Description                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- | ------------- | ------------- |
| `agent_start`           | Agent begins processing                                                           |
| `agent_end`             | Agent completes (includes `messages` array)                                       |
| `turn_start`            | New LLM turn begins                                                               |
| `turn_end`              | Turn completes (includes `message` and `toolResults`)                             |
| `message_start`         | Message generation begins                                                         |
| `message_update`        | Streaming delta (text/thinking/toolcall)                                          |
| `message_end`           | Message complete                                                                  |
| `tool_execution_start`  | Tool starts                                                                       |
| `tool_execution_update` | Tool progress (accumulated `partialResult`)                                       |
| `tool_execution_end`    | Tool done (`result`, `isError`)                                                   |
| `queue_update`          | Steering/follow-up queue changed (`steering: string[]`, `followUp: string[]`)     |
| `compaction_start`      | Compaction begins (`reason`: `"manual"`                                           | `"threshold"` | `"overflow"`) |
| `compaction_end`        | Compaction done (`result`, `aborted`, `willRetry`)                                |
| `auto_retry_start`      | Retry after transient error (`attempt`, `maxAttempts`, `delayMs`, `errorMessage`) |
| `auto_retry_end`        | Retry resolved (`success`, `attempt`, `finalError?`)                              |
| `extension_error`       | Extension threw (`extensionPath`, `event`, `error`)                               |
| `extension_ui_request`  | Extension needs UI interaction (dialog or fire-and-forget)                        |

`message_update.assistantMessageEvent.type` values: `start`, `text_start`, `text_delta`, `text_end`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`, `done`, `error`.

---

## Implications for pi-acp

**Steer vs. follow_up vs. prompt with streamingBehavior:** These are the three injection points during an active run. `steer` interrupts between tool calls (mid-turn), `follow_up` waits until idle. The `"all"` vs `"one-at-a-time"` queue modes give control over pacing — relevant if pi-acp is queuing multiple instructions.

**extension_ui_request/response:** pi-acp needs to handle both dialog (blocking, requires response) and fire-and-forget (no response needed) variants. Match on `method` field. Only send responses for `select`, `confirm`, `input`, `editor`. If you don't respond to a dialog method with a `timeout`, the agent resolves it automatically.

**Tool events carry `toolCallId`:** Use this to correlate `tool_execution_start` → `tool_execution_update` → `tool_execution_end`. The `update` events carry accumulated output (safe to replace display state, not append).

**`get_commands` doesn't include built-in TUI commands.** Only extension-registered, prompt-template, and skill commands appear. This is the complete list of things that can be invoked via `{"type": "prompt", "message": "/commandname"}`.

**`PI_CODING_AGENT_DIR` controls everything.** If pi-acp needs to isolate config from the user's normal pi setup, point this at a dedicated directory. Session dir can be further overridden independently.

**Dynamic providers via async extension factory** is the right hook for discovering local/custom LLMs at startup. The factory is awaited before `session_start`, so models appear in `--list-models` and the model picker immediately.

**`switch_session` can be cancelled by extensions.** If pi-acp calls `switch_session`, an extension's `session_before_switch` handler can block it and return `{"cancelled": true}`. pi-acp should check the `cancelled` field in the response.

---

## Sources

All from the installed package docs at `~/.pi/agent/node_modules/@earendil-works/pi-coding-agent@0.74.0/docs/`:

- `rpc.md` — full RPC protocol, commands, events, extension UI sub-protocol, message types
- `extensions.md` — extension API, all events, `registerCommand`, `registerProvider`, tool events
- `settings.md` — all settings, project override behavior
- `packages.md` — package install/discovery, `pi install`, filtering
- `providers.md` — auth, env vars, `auth.json`, cloud providers, resolution order
- `models.md` — `models.json` schema, custom providers, `compat` flags
- `sessions.md` — session storage, `--session`, `--fork`, session commands
- `usage.md` — `PI_CODING_AGENT_DIR` and other env vars
- `pi --help` — CLI flags reference (live output from installed binary)
