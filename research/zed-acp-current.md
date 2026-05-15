# Zed ACP Behavior — Current Source Research

_Sourced from zed-industries/zed main branch, May 2025. File paths relative to repo root._

---

## Thread Titles

**How titles flow:** Titles originate from the agent via `SessionUpdate::SessionInfoUpdate { title }` (a `MaybeUndefined<String>`). The `AcpThread` stores both `title` (authoritative, from server) and `provisional_title` (optimistic/temporary). When either changes, `AcpThreadEvent::TitleUpdated` is emitted.

**Persistence layer:** `ThreadMetadata` in `ThreadMetadataStore` (SQLite-backed) carries two title fields:

- `title` — the agent-supplied title, updated whenever the thread is saved
- `title_override` — user-supplied rename that takes precedence over `title` in all display paths; set via `ThreadMetadataStore::set_title_override()`

When `SessionInfoUpdate` arrives, if the thread already has a `provisional_title`, dropping it also emits `TitleUpdated` so UI can react. Title displayed to user goes through `ThreadMetadata::display_title()` which picks `title_override || title || DEFAULT_THREAD_TITLE`.

**Adapter implication:** Your server should send `SessionInfoUpdate` with a title as early as possible (e.g., after the first user turn). If your adapter synthesizes titles client-side, it needs to push them through `SessionInfoUpdate`, not a separate channel. The `title_override` field is never touched by ACP — it's purely user-driven on the Zed side.

Sources: `crates/acp_thread/src/acp_thread.rs` (handle_session_update), `crates/agent_ui/src/thread_metadata_store.rs`

---

## Session Restoration After Agent Server Restart

**Serialization:** `AgentPanel` writes a `SerializedAgentPanel` struct to the KVP store (scoped `agent_panel/{workspace_id}`) on every meaningful state change. The active thread is captured as `SerializedActiveThread`:

```rust
struct SerializedActiveThread {
    session_id: Option<String>,   // None for drafts
    thread_id: Option<ThreadId>,  // stable UUID, added for back-compat
    agent_type: Agent,
    title: Option<String>,
    work_dirs: Option<SerializedPathList>,
}
```

Draft threads get `session_id: None`. There's a fallback path: if the thread is in a `Loading`/`LoadError` state during serialization, it pulls `session_id` and metadata from `ThreadMetadataStore` instead of the live thread, avoiding the bug where a mid-load serialize would wipe the session.

**Restoration:** On `AgentPanel::load`, it:

1. Reads serialized panel from KVP
2. Looks up by `thread_id` in `ThreadMetadataStore`, falls back to `session_id`
3. Skips if the thread is archived or missing
4. Calls `panel.load_agent_thread(...)` which calls `connection.load_session(session_id, ...)` if `supports_load_session()`, or `connection.resume_session(...)` if `supports_resume_session()`; errors if neither

**Auto-reconnect on restart:** `ConversationView::handle_agent_servers_updated` is subscribed to `AgentServerStore`. When agent servers update (e.g., extension re-registers after crash), it checks if the view is in `LoadError` state or has a thread error, and if so, calls `self.reset()` to re-attempt loading. This is the hook for transparent reconnection.

**Idle thread retention:** `MaxIdleRetainedThreads` defaults to 5. Threads beyond this are evicted from the retained set (but still persisted in the metadata DB).

**Adapter implication:** You must implement either `session/load` (replay full history) or `session/resume` (reattach without history). The panel will not attempt to reconnect without one of these. If your server crashes and restarts cleanly, the auto-retry via `handle_agent_servers_updated` will fire — but only if your agent server re-registers through the extension mechanism. For `pi-acp`, if the external process restarts, you need to ensure the `AgentServerStore` emits `AgentServersUpdated` after the new process is ready.

Sources: `crates/agent_ui/src/agent_panel.rs` (serialize, load, SerializedActiveThread), `crates/agent_ui/src/conversation_view.rs` (handle_agent_servers_updated, initial_state)

---

## Terminal Auth UX

**Protocol:** During `initialize`, Zed sends `AuthCapabilities::new().terminal(true)` and a `meta` with `{"terminal-auth": true, "terminal_output": true}`. The agent response's `auth_methods` field carries `AuthMethod::Terminal`, `AuthMethod::EnvVar`, or `AuthMethod::Agent`.

**Terminal-spawn auth:** When an auth method has a `terminal-auth` key in its `meta`, Zed calls `meta_terminal_auth_task()` which builds a `SpawnInTerminal` task. This opens a terminal pane running the agent CLI's auth subcommand. The agent server store's `no_browser()` flag injects `NO_BROWSER=1` into the environment.

**Gemini special-case:** Because Google hadn't stabilized their auth method format, Zed hard-codes a Gemini override in `AcpConnection::stdio()`:

```rust
// GEMINI_TERMINAL_AUTH_METHOD_ID = "spawn-gemini-cli"
let meta = acp::Meta::from_iter([("terminal-auth", json!({
    "label": "gemini /auth",
    "command": original_command.path,
    "args": gemini_args_without_acp_flags,
    "env": env,
}))]);
```

This constructs an `AuthMethod::Agent` with `GEMINI_TERMINAL_AUTH_METHOD_ID`. The `ReauthenticateAgent` action re-triggers this flow.

**Auth state in UI:** `AuthState::Unauthenticated { description, configuration_view, pending_auth_method, _subscription }`. The `configuration_view` is populated if the `AuthRequired` error carries a `provider_id` — Zed will show that provider's configuration view (e.g., "Enter API key"). The subscription watches for `ProviderStateChanged` and auto-retries the connection when the provider becomes authenticated.

**Adapter implication:** For `pi-acp`, if your agent requires an API key, either:

- Return `AuthRequired` with a `provider_id` matching a Zed language model provider (cleanest UX — uses provider's built-in config view), or
- Return `auth_methods` with a `Terminal` method that runs the CLI auth flow, or
- Return `auth_methods` with an `EnvVar` method and the env var name; Zed will surface that in the auth UI

The `"terminal-auth"` meta key path is semi-stable — it's the path for pre-stabilization agents. Once you control both sides, prefer the typed `AuthMethod::Terminal` variant.

Sources: `crates/agent_servers/src/acp.rs` (stdio, auth handling, GEMINI_TERMINAL_AUTH_METHOD_ID), `crates/agent_ui/src/conversation_view.rs` (handle_auth_required, AuthState)

---

## Tool Rendering: diff / edit / write / bash / execute

**ToolCall fields relevant to rendering:**

```rust
pub struct ToolCall {
    pub id: acp::ToolCallId,
    pub label: Entity<Markdown>,   // title, rendered per kind
    pub kind: acp::ToolKind,       // Edit | Execute | (other)
    pub content: Vec<ToolCallContent>,
    pub status: ToolCallStatus,
    pub raw_input: Option<serde_json::Value>,
    pub raw_output: Option<serde_json::Value>,
    pub tool_name: Option<SharedString>,   // from meta["tool_name"]
    ...
}
```

**Title rendering by kind:**

- `ToolKind::Execute` — title rendered as **plain text** (not markdown); terminal cards use this for command labels
- `ToolKind::Edit` — title rendered as **markdown-escaped** text
- Other — title truncated at first newline with "…" appended, then rendered as markdown

**Content variants:**

- `ToolCallContent::ContentBlock(ContentBlock)` — markdown/text, resource links, images
- `ToolCallContent::Diff(Entity<Diff>)` — constructed from `acp::ToolCallContent::Diff { path, old_text, new_text }` via `Diff::finalized()`
- `ToolCallContent::Terminal(Entity<Terminal>)` — constructed from `acp::ToolCallContent::Terminal { terminal_id }` by looking up the terminal in the session's terminal map

**Update behavior:** `ToolCall::update_fields()` is called on `ToolCallUpdate` messages. For Execute kind, title updates are forwarded to the terminal entity's `update_command_label()`. Diff content checks `needs_update()` to avoid unnecessary re-renders.

**Raw input/output:** If the server provides `raw_input` / `raw_output` on the tool call, and content is empty when `raw_output` arrives, Zed auto-generates a markdown ContentBlock from the raw JSON. The `raw_input_markdown` is also rendered as a Markdown entity. The `tool_name` is pulled from `meta["tool_name"]` — this is the canonical way to communicate the programmatic tool name through ACP (since `ToolCall` doesn't have a dedicated name field).

**Subagent detection:** `ToolCall::is_subagent()` is true if `tool_name == "spawn_agent"` or `subagent_session_info` is present in meta. The `SUBAGENT_SESSION_INFO_META_KEY = "subagent_session_info"` key in meta carries `{ session_id, message_start_index, message_end_index? }`.

**Adapter implication for pi-acp:**

- Set `ToolKind::Execute` for bash/terminal invocations, `ToolKind::Edit` for file edits
- Always set `meta["tool_name"]` so Zed can display the tool name correctly
- For file edits, provide `Diff` content (with `old_text` + `new_text`) rather than text content — Zed renders a proper diff card
- For bash, provide `Terminal` content and create the terminal via the `create_terminal` request first
- `raw_input` on the initial ToolCall lets users inspect the raw args; set it for better debugging UX

Sources: `crates/acp_thread/src/acp_thread.rs` (ToolCall, ToolCallContent, from_acp, update_fields, TOOL_NAME_META_KEY)

---

## Permission Prompts

**Decision engine:** `ToolPermissionDecision::from_input(tool_name, inputs, permissions, shell_kind)` implements strict precedence:

1. **Hardcoded security** — `rm -rf /`, `rm -rf ~`, `rm -rf .`, `rm -rf ..` etc. are blocked unconditionally via `HARDCODED_SECURITY_RULES`. Cannot be overridden. Multi-path and path-traversal variants are normalized and checked.
2. **Invalid regex patterns** — if the user's `tool_permissions` settings contain invalid regexes, the tool is denied entirely
3. **Shell substitution check** — for terminal tool, commands with `$VAR`, `$(...)`, backticks, `<(...)`, `>(...)` are denied unless global default is `Allow` (unconditional allow-all)
4. **`always_deny`** — user-configured deny patterns; any match → Deny immediately
5. **`always_confirm`** — any match → Confirm (even if allow also matches)
6. **`always_allow`** — all sub-commands must match; if any sub-command misses → falls through to default
7. **Tool-specific `default`** → global `default`

**Shell injection prevention:** For POSIX shells, `extract_commands()` (brush-parser) splits chained commands (`&&`, `;`, `|`, `||`, `&`, newline). If ANY sub-command matches a deny pattern, the whole invocation is denied. If parse fails, `always_allow` is disabled for safety (result: Deny or falls through to default).

**PermissionOptions shape:**

```rust
pub enum PermissionOptions {
    Dropdown(Vec<PermissionOptionChoice>),
    DropdownWithPatterns { choices: Vec<PermissionOptionChoice>, patterns: Vec<PermissionPattern> },
    Flat(Vec<PermissionOptionChoice>),
}
```

`Flat` maps to simple Allow/Reject buttons. `Dropdown` lets the user pick granularity ("Always allow for `cargo build`" vs "Only this time"). `DropdownWithPatterns` lets the user check specific patterns to permanently allow.

**Authorization kinds:**

- `PermissionGrant` — standard tool approval; Reject → `ToolCallStatus::Rejected`
- `ActionChoice` — choice between actions (e.g., "Save" vs "Discard"); always transitions to `InProgress`

**"Always Allow" button:** `extract_terminal_pattern(command)` extracts a safe regex pattern from the command (e.g., `cargo build --release` → `^cargo\s+build(\s|$)`). This is stored in `always_allow` in settings.

**MCP tool naming:** MCP tool names use the format `"mcp:{server}:{tool}"`, which is key-isolated from built-in tool names in `tool_permissions.tools`. The string equality is exact — `"terminal"` in settings doesn't match the `"mcp:srv:terminal"` MCP tool.

**Adapter implication:** For `pi-acp`, you construct the `PermissionRequest` that Zed shows. Use `ToolKind::Execute` + a `WaitingForConfirmation` status with appropriate `PermissionOptions`. Use `Dropdown` variant for better UX. The `allow_option_id` referenced in e2e tests is literally `"allow"` — when writing tests with `FakeAcpAgentServer`, the response channel expects that string.

Sources: `crates/agent/src/tool_permissions.rs` (full file), `crates/acp_thread/src/acp_thread.rs` (ToolCallStatus, AuthorizationKind, PermissionOptions, SelectedPermissionOutcome)

---

## Usage/Context Ring Rendering

**Token usage struct:**

```rust
pub struct TokenUsage {
    pub max_tokens: u64,
    pub used_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub max_output_tokens: Option<u64>,
}
```

**Ratio thresholds:**

```rust
pub const TOKEN_USAGE_WARNING_THRESHOLD: f32 = 0.8;

pub enum TokenUsageRatio {
    Normal,   // used/max < 0.8 (or max == 0)
    Warning,  // used/max >= 0.8
    Exceeded, // used_tokens >= max_tokens
}
```

The 80% threshold is overridable in debug builds via `ZED_THREAD_WARNING_THRESHOLD` env var.

**Cost tracking:** `SessionCost { amount: f64, currency: SharedString }` is tracked separately. Both come from `UsageUpdate` notification. Important: `UsageUpdate` is only processed when `AcpBetaFeatureFlag` is active. If you're testing against a non-beta Zed build, usage ring won't render even if you send the right data.

**Minimum threshold:** `TOKEN_THRESHOLD = 250` — usage below this isn't shown in the conversation view (constant in `conversation_view.rs`).

**What the ring shows:** `used_tokens` vs `max_tokens`. The `input_tokens` and `output_tokens` breakdown is available but used for stats display separately (controlled by `show_turn_stats` setting). The ring itself just shows the ratio.

**Adapter implication:** For `pi-acp`, send `UsageUpdate` notifications with both `size` (max context) and `used` (tokens consumed so far). Include `cost` if you can compute it — Zed will display it. Remember that `used_tokens` should be the running context window usage, not just the last turn's tokens.

Sources: `crates/acp_thread/src/acp_thread.rs` (TokenUsage, TokenUsageRatio, SessionCost, TOKEN_USAGE_WARNING_THRESHOLD, handle_session_update UsageUpdate), `crates/agent_ui/src/conversation_view.rs` (TOKEN_THRESHOLD)

---

## Slash Command Palette

**Protocol flow:**

1. Agent sends `AvailableCommandsUpdate { available_commands: Vec<acp::AvailableCommand> }`
2. `AcpThread` stores them in `available_commands` field and emits `AcpThreadEvent::AvailableCommandsUpdated(commands)`
3. `SessionCapabilities` (an `Arc<RwLock<...>>`) is updated with these commands
4. The message editor reads `SessionCapabilities` to populate the command palette

**PromptCapabilities:** Separate from slash commands; these govern what kinds of context the user can attach (files, URLs, etc). They flow via a `watch::Receiver<acp::PromptCapabilities>` that's passed into `AcpThread::new()`. Capabilities are observed and re-emitted as `AcpThreadEvent::PromptCapabilitiesUpdated`.

**Native agent skills:** For native agent connections, `native_available_skills()` runs at thread-view creation time to populate the skills list. External ACP agents don't have this — their capabilities come purely from `AvailableCommandsUpdate`.

**Adapter implication:** Send `AvailableCommandsUpdate` early in the session (ideally after `session/new` response) to populate the palette before the user types. You can re-send it any time capabilities change. The `PromptCapabilities` in the `InitializeResponse` determine the persistent prompt-level features (like whether `@file` mentions are supported).

Sources: `crates/acp_thread/src/acp_thread.rs` (AcpThread.available_commands, handle_session_update AvailableCommandsUpdate), `crates/agent_ui/src/conversation_view.rs` (SessionCapabilities, native_available_skills)

---

## Embedded Context

**Content block types in ACP:**

- `ContentBlock::Text(TextContent)` — plain text
- `ContentBlock::Resource(EmbeddedResource)` — inline resource with content (used for actual file/diff content)
- `ContentBlock::ResourceLink(ResourceLink)` — reference to a resource (used for clickable mentions)
- `ContentBlock::Image(ImageContent)` — base64 image data

**MentionUri scheme:** Zed uses a custom URI scheme for resource references:

- `File { abs_path }` → `file:///path/to/file`
- `GitDiff { base_ref }` → git diff URI
- `MergeConflict { file_path }` → merge conflict URI

When content blocks arrive, `ContentBlock::block_string_contents()` converts `ResourceLink` to `MentionUri::as_link()` (a clickable inline mention). Resources are de-serialized similarly.

**How Zed builds initial content for agent actions:**

```rust
// Branch diff review example:
vec![
    ContentBlock::Text(TextContent::new("Please review...")),
    ContentBlock::Resource(EmbeddedResource::new(
        EmbeddedResourceResource::TextResourceContents(
            TextResourceContents::new(diff_text, diff_uri)
        )
    )),
]
```

This gets submitted with `auto_submit: true` — the panel creates a new thread and immediately sends without user intervention.

**ContentBlock rendering:** `ContentBlock::new_combined()` folds multiple ACP content blocks into a single Zed `ContentBlock` entity. `ContentBlock::Markdown` is the common case (text + resource links get merged into a single markdown string). Images decode via base64 → `gpui::Image`.

**Adapter implication:** For pi-acp, when you want to send back file content or external resources in a tool result, use `EmbeddedResource` with `TextResourceContents`. For clickable mentions that the user can navigate to, use `ResourceLink`. For simple text, use `TextContent`. Don't mix resource types in the same content sequence expecting them to stay separate — Zed folds them into one markdown string unless the first block is a `ResourceLink` or `Image`.

Sources: `crates/acp_thread/src/acp_thread.rs` (ContentBlock, MentionUri), `crates/agent_ui/src/agent_panel.rs` (ReviewBranchDiff, ResolveConflictsWithAgent)

---

## Custom Agent Server Args

**Settings schema:** Agent servers are configured in `agent_servers` settings as one of three variants:

```rust
enum CustomAgentServerSettings {
    Custom { default_model, default_mode, env, favorite_models, default_config_options, favorite_config_option_values },
    Extension { ... same fields ... },
    Registry { ... same fields ... },
}
```

`Custom` = user-defined, `Extension` = installed via Zed extension, `Registry` = from Zed's agent registry (claude-acp, codex-acp, gemini).

**Command construction:** `agent.get_command(vec![], extra_env, &mut cx.to_async())` builds `AgentServerCommand { path, args, env }`. The `extra_env` is pre-populated by `CustomAgentServer::connect()` with:

- HTTP/HTTPS proxy vars from Zed's proxy settings
- `NO_PROXY=localhost,127.0.0.1` if a proxy is configured
- `NO_BROWSER=1` if `store.no_browser()` is true
- Registry-specific env: `ANTHROPIC_API_KEY=""` for claude-acp, `GEMINI_API_KEY` for gemini, `CODEX_API_KEY`/`OPEN_AI_API_KEY` for codex

**Default mode/model:** `CustomAgentServer` reads `default_mode` and `default_model` from settings and passes them to `connect()`. After `session/new`, if the session supports the default mode, Zed fires `SetSessionModeRequest` to apply it. Same for model. This means the user can pin a mode/model in settings without the agent needing to track it.

**Default config options:** `default_config_options: HashMap<String, String>` in settings. After session/new, `apply_default_config_options()` validates each default value against the session's config options (must be a valid select option ID) and fires `SetSessionConfigOptionRequest` for each valid one. Invalid values are logged and skipped.

**Remote projects:** When Zed is connected to a remote SSH project, the command is re-wrapped through `client.build_command_with_options()` to run on the remote host. The `root_dir` (first worktree path) becomes the cwd on the remote.

**Adapter implication for pi-acp:**

- Your server binary path and args go in the `Custom` settings variant under `agent_servers`
- Additional env vars you need (API keys, config paths) go in the `env` field of that settings entry
- If you want users to be able to pin a mode, implement `session/modes` response in `session/new`; Zed will automatically apply the user's `default_mode` preference
- The `default_config_options` flow is useful for persisting user preferences like model selection — implement `session/config_options` to expose configurable options and Zed will manage persistence in settings

Sources: `crates/agent_servers/src/custom.rs` (CustomAgentServer::connect, apply_default_config_options), `crates/agent_servers/src/agent_servers.rs` (AgentServer trait, load_proxy_env), `crates/agent_servers/src/acp.rs` (stdio, initialize request construction)

---

## Protocol Init Sequence (Summary)

For reference, the full sequence Zed follows when connecting to an external ACP agent:

1. Spawn subprocess (stdio transport)
2. Send `initialize` with `ProtocolVersion::V1`, `ClientCapabilities` (fs read/write, terminal, auth.terminal, meta), `ClientInfo` (name="zed", version)
3. Expect `InitializeResponse` with `protocol_version >= V1`, `agent_capabilities`, `auth_methods`, optional `session_capabilities.list`
4. If `session_capabilities.list` is set, create `AcpSessionList` for the thread history sidebar
5. Call `session/new` (or `session/load` / `session/resume` for restored threads) with `cwd` and optional `mcp_servers`
6. Parse `SessionConfigResponse` for `modes`, `models`, `config_options`
7. Apply `default_mode` / `default_model` / `default_config_options` via separate requests
8. Subscribe to `session/update` notifications for message streaming, tool calls, plan updates, etc.

---

## Sources

- `crates/agent_ui/src/agent_panel.rs` — panel serialization, session restoration
- `crates/agent_ui/src/conversation_view.rs` — server state, auth flow, thread views
- `crates/agent_ui/src/thread_metadata_store.rs` — thread metadata persistence, title handling
- `crates/acp_thread/src/acp_thread.rs` — AcpThread, ToolCall, ContentBlock, TokenUsage, session updates
- `crates/agent/src/native_agent_server.rs` — NativeAgentServer implementation
- `crates/agent/src/tools.rs` — full list of built-in tools
- `crates/agent/src/tool_permissions.rs` — permission decision engine, hardcoded security rules
- `crates/agent_servers/src/acp.rs` — AcpConnection, stdio transport, auth methods, session management
- `crates/agent_servers/src/custom.rs` — CustomAgentServer, settings-driven config
- `crates/agent_servers/src/agent_servers.rs` — AgentServer trait, proxy env loading
- `crates/agent/src/thread_store.rs` — ThreadStore, native thread DB
