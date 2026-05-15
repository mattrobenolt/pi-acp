import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { maybeAuthRequiredError } from "./auth-required.js";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import {
  PiRpcProcess,
  PiRpcSpawnError,
  type PiRpcEvent,
  type ExtensionUiResponsePayload,
} from "../pi-rpc/process.js";
import { SessionStore } from "./session-store.js";
import {
  toolResultToText,
  toToolContent,
  toToolKind,
  toToolTitle,
  toToolCallLocations as sharedToToolCallLocations,
} from "./translate/pi-tools.js";
import { expandSlashCommand, type FileSlashCommand } from "./slash-commands.js";

type SessionCreateParams = {
  cwd: string;
  mcpServers: McpServer[];
  conn: AgentSideConnection;
  fileCommands?: import("./slash-commands.js").FileSlashCommand[];
  piCommand?: string;
};

export type StopReason = "end_turn" | "cancelled" | "error";

type PendingTurn = {
  resolve: (reason: StopReason) => void;
  reject: (err: unknown) => void;
};

type QueuedTurn = {
  message: string;
  images: unknown[];
  resolve: (reason: StopReason) => void;
  reject: (err: unknown) => void;
};

function getEditNeedle(args: any): string {
  if (typeof args?.oldText === "string") return args.oldText;
  const firstEdit = Array.isArray(args?.edits) ? args.edits[0] : undefined;
  return typeof firstEdit?.oldText === "string" ? firstEdit.oldText : "";
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined;

  const first = text.indexOf(needle);
  if (first < 0) return undefined;

  const second = text.indexOf(needle, first + needle.length);
  if (second >= 0) return undefined;

  let line = 1;
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function toToolCallLocations(
  args: unknown,
  cwd: string,
  line?: number,
  toolName?: string,
): ToolCallLocation[] | undefined {
  return sharedToToolCallLocations(args, cwd, line, toolName);
}

const debugLogPath = process.env.PI_ACP_DEBUG_LOG?.trim() || null;

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…<${value.length} chars>` : value;
  }

  if (Array.isArray(value)) return value.map(redact);

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redact(child);
    }
    return out;
  }

  return value;
}

export function debugLog(event: string, data: Record<string, unknown> = {}): void {
  if (!debugLogPath) return;

  try {
    mkdirSync(dirname(debugLogPath), { recursive: true });
    appendFileSync(
      debugLogPath,
      `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...(redact(data) as Record<string, unknown>) })}\n`,
    );
  } catch {
    // ignore debug logging failures
  }
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>();
  private readonly store = new SessionStore();

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id);
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      s.proc.dispose?.();
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId);
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue;
      this.close(id);
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess;
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
      });
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message);
      }
      throw e;
    }

    let state: any = null;
    try {
      state = (await proc.getState()) as any;
    } catch {
      state = null;
    }

    const sessionId = typeof state?.sessionId === "string" ? state.sessionId : randomUUID();
    const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile });
    }

    debugLog("session_manager.create", {
      sessionId,
      cwd: params.cwd,
      sessionFile,
    });

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`);
    return s;
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(
    sessionId: string,
    params: SessionCreateParams & { proc: PiRpcProcess },
  ): PiAcpSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
    });

    this.sessions.set(sessionId, session);
    return session;
  }
}

export class PiAcpSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly mcpServers: McpServer[];

  private startupInfo: string | null = null;
  private startupInfoSentOutOfTurn = false;
  private startupInfoSentInPrompt = false;

  readonly proc: PiRpcProcess;
  private readonly conn: AgentSideConnection;
  private readonly fileCommands: FileSlashCommand[];

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false;

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null;
  private readonly turnQueue: QueuedTurn[] = [];
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, "pending" | "in_progress">();
  private currentToolNames = new Map<string, string>();
  private terminalOutputSent = new Set<string>();

  // pi can emit multiple `turn_end` events for a single user prompt (e.g. after tool_use).
  // The overall agent loop completes when `agent_end` is emitted.
  private inAgentLoop = false;

  // Pending extension_ui_request bridges: keyed by pi requestId.
  // Each entry is a function that resolves the pending ACP requestPermission with "cancelled".
  // We call these on session.cancel() so pi doesn't hang waiting.
  private readonly pendingUiRequests = new Map<string, () => void>();
  private readonly pendingSelectValues = new Map<string, string[]>();

  // For ACP diff support: capture file contents before edits, then emit ToolCallContent {type:"diff"}.
  // This is due to pi sending diff as a string as opposed to ACP expected diff format.
  // Compatible format may need to be implemented in pi in the future.
  private editSnapshots = new Map<string, { path: string; oldText: string | null }>();

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve();

  constructor(opts: {
    sessionId: string;
    cwd: string;
    mcpServers: McpServer[];
    proc: PiRpcProcess;
    conn: AgentSideConnection;
    fileCommands?: FileSlashCommand[];
  }) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.mcpServers = opts.mcpServers;
    this.proc = opts.proc;
    this.conn = opts.conn;
    this.fileCommands = opts.fileCommands ?? [];

    debugLog("session.construct", {
      sessionId: this.sessionId,
      cwd: this.cwd,
      fileCommands: this.fileCommands.length,
    });

    this.proc.onEvent((ev) => this.handlePiEvent(ev));
  }

  setStartupInfo(text: string) {
    this.startupInfo = text;
    this.startupInfoSentOutOfTurn = false;
    this.startupInfoSentInPrompt = false;
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSentOutOfTurn || !this.startupInfo) return;
    this.startupInfoSentOutOfTurn = true;

    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: this.startupInfo },
    });
  }

  private sendStartupInfoOnFirstPromptIfPending(): void {
    if (this.startupInfoSentInPrompt || !this.startupInfo) return;
    this.startupInfoSentInPrompt = true;

    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: this.startupInfo },
    });
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    debugLog("session.prompt.called", {
      sessionId: this.sessionId,
      message,
      imageCount: images.length,
      pendingTurn: Boolean(this.pendingTurn),
      queueDepth: this.turnQueue.length,
      inAgentLoop: this.inAgentLoop,
    });

    // Keep a prompt-path fallback because some clients may ignore the best-effort
    // pre-prompt notification sent right after session/new.
    this.sendStartupInfoOnFirstPromptIfPending();

    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands);

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject };

      if (this.pendingTurn) {
        this.sendStreamingPrompt(queued, "steer");
        return;
      }

      // No turn is running; start immediately.
      this.startTurn(queued);
    });

    return turnPromise;
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true;

    // Cancel any in-flight extension_ui_request bridges so pi doesn't hang.
    for (const [, cancelFn] of this.pendingUiRequests) {
      try {
        cancelFn();
      } catch {
        // ignore
      }
    }
    this.pendingUiRequests.clear();
    this.pendingSelectValues.clear();

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length);
      for (const t of queued) t.resolve("cancelled");

      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Cleared queued prompts." },
      });
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } },
      });
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort();
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested;
  }

  private emit(update: SessionUpdate): void {
    debugLog("session.emit.queued", {
      sessionId: this.sessionId,
      update: update.sessionUpdate,
      status: (update as any).status,
      toolCallId: (update as any).toolCallId,
      meta: (update as any)._meta,
      content: (update as any).content,
    });

    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update,
        }),
      )
      .then(() => {
        debugLog("session.emit.sent", {
          sessionId: this.sessionId,
          update: update.sessionUpdate,
          status: (update as any).status,
          toolCallId: (update as any).toolCallId,
        });
      })
      .catch((error) => {
        debugLog("session.emit.failed", {
          sessionId: this.sessionId,
          update: update.sessionUpdate,
          error: String((error as Error)?.message ?? error),
        });
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      });
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit;
  }

  private sendStreamingPrompt(t: QueuedTurn, streamingBehavior: "steer" | "followUp"): void {
    debugLog("session.streaming_prompt.call", {
      sessionId: this.sessionId,
      message: t.message,
      streamingBehavior,
    });

    this.proc
      .prompt(t.message, t.images, { streamingBehavior })
      .then(() => t.resolve("end_turn"))
      .catch((err) => t.reject(maybeAuthRequiredError(err) ?? err));
  }

  private startTurn(t: QueuedTurn): void {
    debugLog("session.startTurn.enter", {
      sessionId: this.sessionId,
      message: t.message,
      pendingTurn: Boolean(this.pendingTurn),
      queueDepth: this.turnQueue.length,
      inAgentLoop: this.inAgentLoop,
      cancelRequested: this.cancelRequested,
    });

    this.cancelRequested = false;
    this.inAgentLoop = false;

    this.pendingTurn = { resolve: t.resolve, reject: t.reject };

    debugLog("session.startTurn.pending_set", {
      sessionId: this.sessionId,
      queueDepth: this.turnQueue.length,
      inAgentLoop: this.inAgentLoop,
    });

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } },
    });

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // Important: pi may emit multiple `turn_end` events (e.g. when the model requests tools).
    // The full prompt is finished when we see `agent_end`.
    debugLog("session.startTurn.proc_prompt.call", {
      sessionId: this.sessionId,
      message: t.message,
      imageCount: t.images.length,
    });

    this.proc
      .prompt(t.message, t.images)
      .then(() => {
        debugLog("session.startTurn.proc_prompt.resolved", {
          sessionId: this.sessionId,
          pendingTurn: Boolean(this.pendingTurn),
          inAgentLoop: this.inAgentLoop,
        });
        // The RPC response only means pi accepted the prompt. Turn completion is signaled by
        // `agent_end`; resolving here races with the event stream and makes clients think the
        // turn is done immediately. Keep a short fallback for older/fake pi event streams that
        // never emit agent_start/agent_end.
        setTimeout(() => {
          if (this.inAgentLoop || !this.pendingTurn) return;
          void this.flushEmits().finally(() => {
            this.pendingTurn?.resolve(this.cancelRequested ? "cancelled" : "end_turn");
            this.pendingTurn = null;
            this.emit({
              sessionUpdate: "session_info_update",
              _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } },
            });
          });
        }, 100);
      })
      .catch((err) => {
        debugLog("session.startTurn.proc_prompt.rejected", {
          sessionId: this.sessionId,
          pendingTurn: Boolean(this.pendingTurn),
          inAgentLoop: this.inAgentLoop,
          cancelRequested: this.cancelRequested,
          error: String((err as Error)?.message ?? err),
        });
        // If the subprocess errors before we get an `agent_end`, treat as error unless cancelled.
        // Also ensure we flush any already-enqueued updates first.
        void this.flushEmits().finally(() => {
          // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
          const authErr = maybeAuthRequiredError(err);
          if (authErr) {
            this.pendingTurn?.reject(authErr);
          } else {
            const reason: StopReason = this.cancelRequested ? "cancelled" : "error";
            this.pendingTurn?.resolve(reason);
          }

          debugLog("session.startTurn.proc_prompt.reject_resolve", {
            sessionId: this.sessionId,
            reason: this.cancelRequested ? "cancelled" : "error",
            pendingTurn: Boolean(this.pendingTurn),
            inAgentLoop: this.inAgentLoop,
          });

          this.pendingTurn = null;
          this.inAgentLoop = false;

          // If the prompt failed, do not automatically proceed—pi may be unhealthy.
          // But we still clear the queueDepth metadata.
          this.emit({
            sessionUpdate: "session_info_update",
            _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } },
          });
        });
        void err;
      });
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? "");
    const uiType = extensionUiType(ev);

    if (!isNoisyExtensionUiRequest(type, uiType)) {
      debugLog("pi.event", {
        sessionId: this.sessionId,
        type,
        uiType: uiType || undefined,
        pendingTurn: Boolean(this.pendingTurn),
        queueDepth: this.turnQueue.length,
        inAgentLoop: this.inAgentLoop,
        cancelRequested: this.cancelRequested,
        assistantEventType: (ev as any).assistantMessageEvent?.type,
        toolCallId: (ev as any).toolCallId,
        toolName: (ev as any).toolName,
        isError: (ev as any).isError,
      });
    }

    switch (type) {
      case "message_update": {
        const ame = (ev as any).assistantMessageEvent;

        // Stream assistant text.
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: ame.delta } satisfies ContentBlock,
          });
          break;
        }

        if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: ame.delta } satisfies ContentBlock,
          });
          break;
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (
          ame?.type === "toolcall_start" ||
          ame?.type === "toolcall_delta" ||
          ame?.type === "toolcall_end"
        ) {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0];

          const toolCallId = String((toolCall as any)?.id ?? "");
          const toolName = String((toolCall as any)?.name ?? "tool");

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === "object"
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? "");
                    if (!s) return undefined;
                    try {
                      return JSON.parse(s);
                    } catch {
                      return { partialArgs: s };
                    }
                  })();

            const locations = toToolCallLocations(rawInput, this.cwd, undefined, toolName);
            const existingStatus = this.currentToolCalls.get(toolCallId);
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? "pending";

            if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, "pending");
              this.currentToolNames.set(toolCallId, toolName);
              this.emit({
                sessionUpdate: "tool_call",
                toolCallId,
                title: toToolTitle(toolName, rawInput, this.cwd),
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput,
                content: toToolContent(toolName, rawInput),
                ...terminalStart(toolName, toolCallId),
              });
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: "tool_call_update",
                toolCallId,
                title: toToolTitle(toolName, rawInput, this.cwd),
                status,
                locations,
                rawInput,
                content: toToolContent(toolName, rawInput),
              });
            }
          }

          break;
        }

        // Ignore other delta/event types for now.
        break;
      }

      case "tool_execution_start": {
        const toolCallId = String((ev as any).toolCallId ?? randomUUID());
        const toolName = String((ev as any).toolName ?? "tool");
        const args = toolArgsFromEvent(ev);
        const argsObj = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
        let line: number | undefined;

        // Capture pre-edit file contents so we can emit a structured ACP diff on completion.
        if (toolName === "edit" || toolName === "write") {
          const p = typeof argsObj?.path === "string" ? argsObj.path : undefined;
          if (p) {
            const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p);
            try {
              const oldText = readFileSync(abs, "utf8");
              this.editSnapshots.set(toolCallId, { path: p, oldText });

              const needle = getEditNeedle(args);
              line = findUniqueLineNumber(oldText, needle);
            } catch {
              if (toolName === "write")
                this.editSnapshots.set(toolCallId, { path: p, oldText: null });
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line, toolName);

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.currentToolNames.set(toolCallId, toolName);
          this.emit({
            sessionUpdate: "tool_call",
            toolCallId,
            title: toToolTitle(toolName, args, this.cwd),
            kind: toToolKind(toolName),
            status: "in_progress",
            locations,
            rawInput: args,
            content: toToolContent(toolName, args),
            ...terminalStart(toolName, toolCallId),
          });
        } else {
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.currentToolNames.set(toolCallId, toolName);
          this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: toToolTitle(toolName, args, this.cwd),
            status: "in_progress",
            locations,
            rawInput: args,
            content: toToolContent(toolName, args),
          });
        }

        break;
      }

      case "tool_execution_update": {
        const toolCallId = String((ev as any).toolCallId ?? "");
        if (!toolCallId) break;

        const partial = (ev as any).partialResult;
        const text = toolResultToText(partial);

        const toolName = this.currentToolNames.get(toolCallId);
        const terminal = terminalOutput(toolName, toolCallId, text);
        if (toolName === "bash" && text) this.terminalOutputSent.add(toolCallId);

        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          content:
            terminal.content ??
            (text
              ? ([{ type: "content", content: { type: "text", text } }] satisfies ToolCallContent[])
              : undefined),
          rawOutput: partial,
          ...terminal,
        });
        break;
      }

      case "tool_execution_end": {
        const toolCallId = String((ev as any).toolCallId ?? "");
        if (!toolCallId) break;

        const result = (ev as any).result;
        const isError = Boolean((ev as any).isError);
        const text = toolResultToText(result);

        // If this was an edit and we captured a snapshot, emit a structured ACP diff.
        // This enables clients like Zed to render an actual diff UI.
        const snapshot = this.editSnapshots.get(toolCallId);
        let content: ToolCallContent[] | undefined;

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path)
              ? snapshot.path
              : resolvePath(this.cwd, snapshot.path);
            const newText = readFileSync(abs, "utf8");
            if (newText !== snapshot.oldText) {
              content = [
                {
                  type: "diff",
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText,
                },
                ...(text
                  ? ([{ type: "content", content: { type: "text", text } }] as ToolCallContent[])
                  : []),
              ];
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        // Fallback: just text content.
        if (!content && text) {
          content = [
            { type: "content", content: { type: "text", text } },
          ] satisfies ToolCallContent[];
        }

        const toolName = this.currentToolNames.get(toolCallId);
        const alreadySentTerminalOutput = this.terminalOutputSent.has(toolCallId);
        const terminal = terminalOutput(
          toolName,
          toolCallId,
          alreadySentTerminalOutput ? "" : text,
          {
            exitCode: isError ? 1 : 0,
          },
        );

        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content: terminal.content ?? content,
          rawOutput: result,
          ...terminal,
        });

        this.currentToolCalls.delete(toolCallId);
        this.currentToolNames.delete(toolCallId);
        this.terminalOutputSent.delete(toolCallId);
        this.editSnapshots.delete(toolCallId);
        break;
      }

      case "auto_retry_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: formatAutoRetryMessage(ev) } satisfies ContentBlock,
        });
        break;
      }

      case "auto_retry_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Retry finished, resuming." } satisfies ContentBlock,
        });
        break;
      }

      case "auto_compaction_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Context nearing limit, running automatic compaction...",
          } satisfies ContentBlock,
        });
        break;
      }

      case "auto_compaction_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Automatic compaction finished; context was summarized to continue the session.",
          } satisfies ContentBlock,
        });
        break;
      }

      case "agent_start": {
        debugLog("pi.agent_start", {
          sessionId: this.sessionId,
          pendingTurn: Boolean(this.pendingTurn),
          queueDepth: this.turnQueue.length,
          inAgentLoop: this.inAgentLoop,
        });
        this.inAgentLoop = true;
        break;
      }

      case "turn_end": {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_end`.
        break;
      }

      case "agent_end": {
        debugLog("pi.agent_end.enter", {
          sessionId: this.sessionId,
          pendingTurn: Boolean(this.pendingTurn),
          queueDepth: this.turnQueue.length,
          inAgentLoop: this.inAgentLoop,
          cancelRequested: this.cancelRequested,
        });

        // Ensure all updates derived from pi events are delivered before we resolve
        // the ACP `session/prompt` request.
        void this.flushEmits().finally(() => {
          const reason: StopReason = this.cancelRequested ? "cancelled" : "end_turn";
          debugLog("pi.agent_end.resolve", {
            sessionId: this.sessionId,
            reason,
            pendingTurn: Boolean(this.pendingTurn),
            queueDepth: this.turnQueue.length,
            inAgentLoop: this.inAgentLoop,
          });
          this.pendingTurn?.resolve(reason);
          this.pendingTurn = null;
          this.inAgentLoop = false;

          // Start next queued prompt, if any.
          const next = this.turnQueue.shift();
          if (next) {
            this.emit({
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Starting queued message. (${this.turnQueue.length} remaining)`,
              },
            });
            this.startTurn(next);
          } else {
            this.emit({
              sessionUpdate: "session_info_update",
              _meta: { piAcp: { queueDepth: 0, running: false } },
            });
          }
        });
        break;
      }

      case "extension_ui_request": {
        this.handleExtensionUiRequest(ev);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Return the toolCallId of the single in-progress tool call, if there is
   * exactly one. Used to associate extension_ui_request dialogs with the
   * tool that triggered them so ACP clients can render them in context.
   */
  private activeToolCallId(): string | null {
    const inProgress = [...this.currentToolCalls.entries()].filter(
      ([, status]) => status === "in_progress",
    );
    return inProgress.length === 1 ? inProgress[0][0] : null;
  }

  private handleExtensionUiRequest(ev: PiRpcEvent): void {
    const requestId = String((ev as any).id ?? (ev as any).requestId ?? "");
    if (!requestId) return;

    const ui = (ev as any).ui ?? ev;
    const uiType = String((ev as any).method ?? ui?.type ?? "");

    if (uiType === "notify") {
      const message = typeof (ev as any).message === "string" ? (ev as any).message : "";
      if (message) {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: message } satisfies ContentBlock,
        });
      }
      return;
    }

    if (
      uiType === "setStatus" ||
      uiType === "setWidget" ||
      uiType === "setTitle" ||
      uiType === "set_editor_text"
    ) {
      return;
    }

    if (uiType === "input") {
      this.handleInputElicitation(requestId, ev);
      return;
    }

    // editor: ACP elicitation string formats don't cover multiline text, so we auto-cancel.
    // Dialog types we cannot represent in ACP yet: unblock pi with the default cancelled value.
    if (uiType !== "select" && uiType !== "confirm") {
      this.proc.sendExtensionUiResponse(requestId, { cancelled: true });
      return;
    }

    // Build ACP permission options based on the ui type.
    let options: Array<{ optionId: string; name: string; kind: "allow_once" | "reject_once" }>;

    if (uiType === "select") {
      const rawOptions: unknown[] = Array.isArray(ui.options) ? ui.options : [];
      const values = rawOptions.map((o) =>
        typeof o === "string"
          ? o
          : String((o as any)?.value ?? (o as any)?.id ?? (o as any)?.label ?? ""),
      );
      if (rawOptions.length === 0) {
        // Nothing to select from — auto-cancel.
        this.proc.sendExtensionUiResponse(requestId, { cancelled: true });
        return;
      }
      options = rawOptions.map((o: any, index) => ({
        optionId: String(index),
        name: String(typeof o === "string" ? o : (o?.label ?? o?.name ?? o?.id ?? "Option")),
        kind: "allow_once" as const,
      }));
      this.pendingSelectValues.set(requestId, values);
    } else {
      // confirm
      const confirmText = typeof ui.confirmText === "string" ? ui.confirmText : "Yes";
      const rejectText = typeof ui.rejectText === "string" ? ui.rejectText : "No";
      options = [
        { optionId: "confirm", name: confirmText, kind: "allow_once" as const },
        { optionId: "reject", name: rejectText, kind: "reject_once" as const },
      ];
    }

    const title =
      typeof ui.title === "string" && ui.title
        ? ui.title
        : typeof ui.message === "string" && ui.message
          ? ui.message
          : "Extension request";

    // Create a cancellable promise so session.cancel() can resolve it early.
    let cancelFn: (() => void) | null = null;
    const cancelPromise = new Promise<void>((resolve) => {
      cancelFn = resolve;
    });

    // Register the cancel hook.
    this.pendingUiRequests.set(requestId, cancelFn!);

    // Associate the permission dialog with the active tool call when possible
    // so ACP clients (e.g. Zed) can render it in the tool's context.
    // Fall back to the UI request id for commands that run outside tool context.
    const associatedToolCallId = this.activeToolCallId() ?? requestId;

    void Promise.race([
      this.conn.requestPermission({
        sessionId: this.sessionId,
        options: options.map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
        toolCall: {
          toolCallId: associatedToolCallId,
          title,
          status: "pending",
        },
      }),
      cancelPromise.then((): { outcome: "cancelled" } => ({ outcome: "cancelled" })),
    ])
      .then((result) => {
        this.pendingUiRequests.delete(requestId);

        const outcome = (result as any)?.outcome;
        let payload: ExtensionUiResponsePayload;

        if (outcome === "cancelled") {
          payload = { cancelled: true };
        } else if (outcome === "selected") {
          const optionId = String((result as any).optionId ?? "");
          if (uiType === "confirm") {
            payload = { confirmed: optionId === "confirm" };
          } else {
            const values = this.pendingSelectValues.get(requestId) ?? [];
            payload = { value: values[Number(optionId)] ?? optionId };
          }
        } else {
          payload = { cancelled: true };
        }

        this.pendingSelectValues.delete(requestId);
        this.proc.sendExtensionUiResponse(requestId, payload);
      })
      .catch(() => {
        this.pendingUiRequests.delete(requestId);
        this.pendingSelectValues.delete(requestId);
        this.proc.sendExtensionUiResponse(requestId, { cancelled: true });
      });
  }

  /**
   * Bridge a pi `input` extension_ui_request to ACP `unstable_createElicitation` (form mode).
   *
   * The pi input prompt maps naturally to a single-field form schema. If the client doesn't
   * support elicitation the SDK throws; we catch and fall back to auto-cancel.
   */
  private handleInputElicitation(requestId: string, ev: PiRpcEvent): void {
    const ui = (ev as any).ui ?? ev;
    const message =
      typeof (ev as any).message === "string" && (ev as any).message
        ? (ev as any).message
        : typeof ui.message === "string" && ui.message
          ? ui.message
          : typeof ui.title === "string" && ui.title
            ? ui.title
            : "Enter a value";

    const placeholder = typeof ui.placeholder === "string" ? ui.placeholder : undefined;
    const defaultValue = typeof ui.default === "string" ? ui.default : undefined;

    let cancelFn: (() => void) | null = null;
    const cancelPromise = new Promise<void>((resolve) => {
      cancelFn = resolve;
    });

    this.pendingUiRequests.set(requestId, cancelFn!);

    const toolCallId = this.activeToolCallId() ?? requestId;

    void Promise.race([
      this.conn.unstable_createElicitation({
        sessionId: this.sessionId,
        toolCallId,
        mode: "form",
        message,
        requestedSchema: {
          type: "object",
          properties: {
            value: {
              type: "string",
              ...(placeholder ? { description: placeholder } : {}),
              ...(defaultValue ? { default: defaultValue } : {}),
            },
          },
          required: ["value"],
        },
      }),
      cancelPromise.then(() => ({ action: "cancel" as const })),
    ])
      .then((result) => {
        this.pendingUiRequests.delete(requestId);
        const action = (result as any)?.action;
        if (action === "accept") {
          const value = String((result as any).content?.value ?? "");
          this.proc.sendExtensionUiResponse(requestId, { value });
        } else {
          this.proc.sendExtensionUiResponse(requestId, { cancelled: true });
        }
      })
      .catch((err) => {
        this.pendingUiRequests.delete(requestId);
        debugLog("session.input_elicitation.failed", {
          sessionId: this.sessionId,
          requestId,
          error: String((err as Error)?.message ?? err),
        });
        this.proc.sendExtensionUiResponse(requestId, { cancelled: true });
      });
  }
}

function terminalStart(
  toolName: string,
  toolCallId: string,
): { content?: ToolCallContent[]; _meta?: Record<string, unknown> } {
  if (toolName !== "bash") return {};
  return {
    content: [{ type: "terminal", terminalId: toolCallId }],
    _meta: { terminal_info: { terminal_id: toolCallId } },
  };
}

function terminalOutput(
  toolName: string | undefined,
  toolCallId: string,
  data: string,
  exit?: { exitCode: number; signal?: string | null },
): { content?: ToolCallContent[]; _meta?: Record<string, unknown> } {
  if (toolName !== "bash" || (!data && !exit)) return {};
  return {
    content: [{ type: "terminal", terminalId: toolCallId }],
    _meta: {
      terminal_info: { terminal_id: toolCallId },
      ...(data ? { terminal_output: { terminal_id: toolCallId, data } } : {}),
      ...(exit
        ? {
            terminal_exit: {
              terminal_id: toolCallId,
              exit_code: exit.exitCode,
              signal: exit.signal ?? null,
            },
          }
        : {}),
    },
  };
}

function toolArgsFromEvent(ev: PiRpcEvent): unknown {
  const e = ev as Record<string, unknown>;
  return e.args ?? e.input ?? e.rawInput ?? e.parameters;
}

function extensionUiType(ev: PiRpcEvent): string {
  const ui = (ev as any).ui ?? ev;
  return String((ev as any).method ?? ui?.type ?? "");
}

function isNoisyExtensionUiRequest(type: string, uiType: string): boolean {
  return (
    type === "extension_ui_request" &&
    (uiType === "setStatus" ||
      uiType === "setWidget" ||
      uiType === "setTitle" ||
      uiType === "set_editor_text")
  );
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt);
  const maxAttempts = Number((ev as any).maxAttempts);
  const delayMs = Number((ev as any).delayMs);

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return "Retrying...";
  }

  let delaySeconds = Math.round(delayMs / 1000);
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1;

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`;
}
