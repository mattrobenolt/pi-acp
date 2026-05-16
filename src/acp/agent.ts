import {
  RequestError,
  type Agent as ACPAgent,
  type AgentCapabilities,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type ClientCapabilities,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ModelInfo,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
  type UsageUpdate,
} from "@agentclientprotocol/sdk";
import { getAuthMethods } from "./auth.js";
import { debugLog, SessionManager } from "./session.js";
import { SessionStore } from "./session-store.js";
import { PiRpcProcess } from "../pi-rpc/process.js";
import { listPiSessions, findPiSessionFile, getPiSessionsDir } from "./pi-sessions.js";
import { normalizePiAssistantText, normalizePiMessageText } from "./translate/pi-messages.js";
import {
  toolResultToText,
  toToolContent,
  toToolKind,
  toToolTitle,
  toToolCallLocations,
  buildArgsMap,
} from "./translate/pi-tools.js";
import { promptToPiMessage } from "./translate/prompt.js";
import { loadSlashCommands, parseCommandArgs, toAvailableCommands } from "./slash-commands.js";
import {
  getAgentDir,
  getConfiguredPackages,
  getEnableExtensionCommands,
  getEnableSkillCommands,
  getEnabledModels,
  getQuietStartup,
} from "./pi-settings.js";
import { toAvailableCommandsFromPiGetCommands } from "./pi-commands.js";
import { mapPiRpcError, maybeAuthRequiredError } from "./auth-required.js";
import { isAbsolute } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SessionDocumentContext = {
  focusedDocument: {
    uri: string;
    languageId?: string | null;
    position?: { line: number; character: number } | null;
    visibleRange?: unknown;
  } | null;
  openDocuments: Map<string, { languageId?: string | null; version?: number }>;
};

export function buildDocumentContextPrefix(
  ctx: SessionDocumentContext | null,
  message: string,
  cwd: string,
): string {
  if (!ctx?.focusedDocument) return "";

  const focused = ctx.focusedDocument;
  const focusedPath = displayDocumentPath(focused.uri, cwd);
  if (message.includes(focusedPath) || message.includes(basename(focusedPath))) return "";

  const parts = [
    `Focused file: ${focusedPath}${focused.languageId ? ` (${focused.languageId})` : ""}`,
  ];
  if (typeof focused.position?.line === "number")
    parts.push(`Cursor: line ${focused.position.line + 1}`);

  if (ctx.openDocuments.size <= 8) {
    const others = [...ctx.openDocuments.keys()]
      .filter((uri) => uri !== focused.uri)
      .map((uri) => displayDocumentPath(uri, cwd));
    if (others.length) parts.push(`Other open files: ${others.join(", ")}`);
  }

  return `<context>\n${parts.join("\n")}\n</context>\n\n`;
}

function displayDocumentPath(uri: string, cwd: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    const path = fileURLToPath(uri);
    const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  } catch {
    return uri;
  }
}

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: "compact",
      description: "Manually compact the session context",
      input: { hint: "optional custom instructions" },
    },
    {
      name: "autocompact",
      description: "Toggle automatic context compaction",
      input: { hint: "on|off|toggle" },
    },
    {
      name: "export",
      description: "Export session to an HTML file in the session cwd",
    },
    {
      name: "session",
      description: "Show session stats (messages, tokens, cost, session file)",
    },
    {
      name: "name",
      description: "Set session display name",
      input: { hint: "<name>" },
    },
    {
      name: "steering",
      description:
        "Get/set pi steering message delivery mode (how queued steering messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" },
    },
    {
      name: "follow-up",
      description:
        "Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" },
    },
    {
      name: "changelog",
      description: "Show pi changelog",
    },
  ];
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = [];
  const seen = new Set<string>();

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }

  return out;
}

function normalizeAdditionalDirectories(
  value: unknown,
  opts: { optional?: boolean } = {},
): string[] | null {
  if (value === undefined || value === null) return opts.optional ? null : [];
  if (!Array.isArray(value))
    throw RequestError.invalidParams("additionalDirectories must be an array");

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw RequestError.invalidParams("additionalDirectories entries must be non-empty strings");
    }
    if (!isAbsolute(raw)) {
      throw RequestError.invalidParams(
        `additionalDirectories entries must be absolute paths: ${raw}`,
      );
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
import { fileURLToPath } from "node:url";

const pkg = readNearestPackageJson(import.meta.url);

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection;
  private readonly sessions = new SessionManager();
  private readonly store = new SessionStore();
  private readonly sessionAdditionalDirectories = new Map<string, string[]>();
  private readonly sessionDocCtx = new Map<string, SessionDocumentContext>();

  // Tracks whether the connected client declared support for usage_update via
  // _meta["usage-update"] in InitializeRequest. Defaults to true (opt-out model):
  // we send unless the client explicitly says it doesn't want it.
  private clientSupportsUsageUpdate = true;

  dispose(): void {
    this.sessions.disposeAll();
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null;
  private readonly titledSessions = new Set<string>();

  constructor(conn: AgentSideConnection, _config?: unknown) {
    this.conn = conn;
    void _config;
  }

  private async ensureSession(sessionId: string): Promise<ReturnType<SessionManager["get"]>> {
    const existing = (this.sessions as any).maybeGet?.(sessionId);
    if (existing) return existing;
    if (!(this.sessions as any).maybeGet) return this.sessions.get(sessionId);

    const stored = this.store.get(sessionId);
    if (!stored?.sessionFile) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`);

    const proc = await PiRpcProcess.spawn({
      cwd: stored.cwd,
      sessionPath: stored.sessionFile,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      agentDir: getAgentDir(),
    });

    const session = this.sessions.getOrCreate(sessionId, {
      cwd: stored.cwd,
      mcpServers: [],
      conn: this.conn,
      proc,
      fileCommands: loadSlashCommands(stored.cwd),
      piCommand: process.env.PI_ACP_PI_COMMAND,
      agentDir: getAgentDir(),
    });

    this.lastSessionCwd = stored.cwd;
    const additionalDirectories = stored.additionalDirectories ?? [];
    this.sessionAdditionalDirectories.set(sessionId, additionalDirectories);
    this.store.upsert({
      sessionId,
      cwd: stored.cwd,
      sessionFile: stored.sessionFile,
      ...(additionalDirectories.length ? { additionalDirectories } : {}),
    });

    return session;
  }

  /**
   * Best-effort: fetch session stats (and optionally state) from pi, build a
   * usage_update, and send it to the client. Errors are silently swallowed —
   * usage telemetry is never worth breaking a session over.
   */
  private async maybeEmitUsageUpdate(
    sessionId: string,
    proc: PiRpcProcess,
    preState?: unknown,
  ): Promise<void> {
    if (!this.clientSupportsUsageUpdate) return;
    try {
      const [stats, state] = await Promise.all([
        proc.getSessionStats(),
        preState !== undefined ? Promise.resolve(preState) : proc.getState(),
      ]);

      const update = buildUsageUpdate(stats, state);
      if (!update) return;

      await this.conn.sessionUpdate({ sessionId, update });
    } catch {
      // Best-effort only.
    }
  }

  private async emitConfigOptionUpdate(sessionId: string, proc: PiRpcProcess): Promise<void> {
    const state = await proc.getState().catch(() => null);
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: buildConfigOptions(state),
      },
    });
  }

  private async emitAvailableCommands(
    sessionId: string,
    proc: PiRpcProcess,
    cwd: string,
    fileCommands: ReturnType<typeof loadSlashCommands>,
  ): Promise<void> {
    try {
      const pi = (await proc.getCommands()) as any;
      const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
        enableSkillCommands: getEnableSkillCommands(cwd),
        includeExtensionCommands: getEnableExtensionCommands(cwd),
      });
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: mergeCommands(commands, builtinAvailableCommands()),
        },
      });
      return;
    } catch {
      // Fall back to file commands below.
    }

    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: mergeCommands(
          toAvailableCommands(fileCommands),
          builtinAvailableCommands(),
        ),
      },
    });
  }

  private async maybeSetInitialTitle(
    session: ReturnType<SessionManager["get"]>,
    message: string,
  ): Promise<void> {
    if (this.titledSessions.has(session.sessionId)) return;

    const title = titleFromPrompt(message);
    if (!title) return;

    this.titledSessions.add(session.sessionId);

    try {
      await session.proc.setSessionName(title);
    } catch {
      // Best-effort only; ACP clients can still use the session_info_update title.
    }

    await this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  private cleanupFailedNewSession(sessionId: string, state?: any | null): void {
    this.sessions.close(sessionId);

    const sessionFile =
      typeof state?.sessionFile === "string" && state.sessionFile.trim()
        ? state.sessionFile
        : this.store.get(sessionId)?.sessionFile;

    if (typeof sessionFile === "string" && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile);
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId);
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // Gate usage_update on client opt-out via _meta["usage-update"].
    // Default: send unless client explicitly sets _meta["usage-update"] = false.
    const usageUpdateMeta = (params as any)?.clientCapabilities?._meta?.["usage-update"];
    if (usageUpdateMeta === false) this.clientSupportsUsageUpdate = false;

    // We currently only support ACP protocol version 1.
    const supportedVersion = 1;
    const requested = params.protocolVersion;
    const clientCaps = params.clientCapabilities;

    const { agentCapabilities, debug } = negotiateCapabilities(clientCaps);

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? "pi-acp",
        title: "pi ACP adapter",
        version: pkg.version ?? "0.0.0",
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: clientCaps?._meta?.["terminal-auth"] === true,
      }),
      agentCapabilities,
      _meta: { piAcp: debug },
    };
  }

  async newSession(params: NewSessionRequest) {
    debugLog("agent.newSession.enter", {
      cwd: params.cwd,
      mcpServers: params.mcpServers?.length ?? 0,
    });

    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }

    const additionalDirectories =
      normalizeAdditionalDirectories(
        (params as { additionalDirectories?: unknown }).additionalDirectories,
      ) ?? [];

    this.lastSessionCwd = params.cwd;

    const fileCommands = loadSlashCommands(params.cwd);
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    const includeExtensionCommands = getEnableExtensionCommands(params.cwd);

    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      agentDir: getAgentDir(),
    });

    // Fetch state + models once (parallel) to reduce startup latency.
    let state: any = null;
    let availableModels: any = null;
    let stateErr: unknown = null;
    let availableModelsErr: unknown = null;

    await Promise.all([
      session.proc
        .getState()
        .then((s) => {
          state = s as any;
        })
        .catch((err) => {
          stateErr = err;
          state = null;
        }),
      session.proc
        .getAvailableModels()
        .then((m) => {
          availableModels = m as any;
        })
        .catch((err) => {
          availableModelsErr = err;
          availableModels = null;
        }),
    ]);

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr);

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw availableModelsAuthErr;
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError.internalError(
        {},
        String((availableModelsErr as Error)?.message ?? availableModelsErr),
      );
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models)
      ? availableModels.models.length
      : 0;

    if (rawModelsCount === 0 && process.env.PI_ACP_SKIP_PI_AUTH !== "1") {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider.",
      );
    }

    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider.",
      );
    }

    const models = await getModelState(session.proc, params.cwd, { state, availableModels });
    const thinking = await getThinkingState(session.proc, { state });

    const quietStartup = getQuietStartup(params.cwd);
    const updateNotice = buildUpdateNotice();

    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    const preludeText = quietStartup
      ? updateNotice
        ? updateNotice + "\n"
        : ""
      : buildStartupInfo({
          cwd: params.cwd,
          additionalDirectories,
          fileCommands,
          updateNotice,
        });

    if (preludeText) session.setStartupInfo(preludeText);

    // Policy: within a single ACP connection (one client window), keep only one live pi subprocess.
    // This avoids leaking subprocesses when clients start new sessions but don't explicitly close old ones.
    // It does NOT affect other client windows because they run in separate agent processes.
    //
    // (Tests sometimes stub out `this.sessions`, so guard the call.)
    (this.sessions as any).closeAllExcept?.(session.sessionId);

    this.sessionAdditionalDirectories.set(session.sessionId, additionalDirectories);
    if (typeof state?.sessionFile === "string") {
      this.store.upsert({
        sessionId: session.sessionId,
        cwd: params.cwd,
        sessionFile: state.sessionFile,
        additionalDirectories,
      });
    }

    const metadata = buildSessionMetadata({
      state,
      models,
      sessionFile: state?.sessionFile,
      additionalDirectories,
    });

    const response = {
      sessionId: session.sessionId,
      models,
      modes: thinking,
      _meta: {
        piAcp: {
          ...metadata,
          startupInfo: preludeText || null,
        },
      },
    };

    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { piAcp: metadata },
      },
    });

    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0);

    // Advertise slash commands (ACP: available_commands_update)
    // Important: some clients (e.g. Zed) will ignore notifications for an unknown sessionId.
    // So we must send this *after* the session/new response has been delivered.
    setTimeout(() => {
      void (async () => {
        try {
          const pi = (await session.proc.getCommands()) as any;
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands,
          });
          const availableCommands = mergeCommands(commands, builtinAvailableCommands());

          debugLog("agent.commands.available", {
            sessionId: session.sessionId,
            source: "pi-rpc",
            count: availableCommands.length,
            names: availableCommands.map((c) => c.name),
          });

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands,
            },
          });
          return;
        } catch (error) {
          debugLog("agent.commands.pi_failed", {
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        const availableCommands = mergeCommands(
          toAvailableCommands(fileCommands),
          builtinAvailableCommands(),
        );
        debugLog("agent.commands.available", {
          sessionId: session.sessionId,
          source: "file-fallback",
          count: availableCommands.length,
          names: availableCommands.map((c) => c.name),
        });

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands,
          },
        });
      })();
    }, 50);

    debugLog("agent.newSession.return", {
      sessionId: session.sessionId,
      cwd: params.cwd,
      hasStartupInfo: Boolean(preludeText),
      metadata,
    });

    return response;
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    return;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    debugLog("agent.prompt.enter", {
      sessionId: params.sessionId,
      prompt: params.prompt,
    });

    const session = await this.ensureSession(params.sessionId);

    const { message: rawMessage, images } = promptToPiMessage(params.prompt);
    const contextPrefix = buildDocumentContextPrefix(
      this.sessionDocCtx.get(params.sessionId) ?? null,
      rawMessage,
      session.cwd,
    );
    const message = contextPrefix ? `${contextPrefix}${rawMessage}` : rawMessage;

    await this.maybeSetInitialTitle(session, rawMessage);

    debugLog("agent.prompt.normalized", {
      sessionId: params.sessionId,
      message,
      imageCount: images.length,
    });

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith("/")) {
      const trimmed = message.trim();
      const space = trimmed.indexOf(" ");
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      const argsString = space === -1 ? "" : trimmed.slice(space + 1);
      const args = parseCommandArgs(argsString);

      if (cmd === "compact") {
        const customInstructions = args.join(" ").trim() || undefined;
        const res = await session.proc.compact(customInstructions);

        const r: any = res && typeof res === "object" ? (res as any) : null;
        const tokensBefore = typeof r?.tokensBefore === "number" ? r.tokensBefore : null;
        const summary = typeof r?.summary === "string" ? r.summary : null;

        const headerLines = [
          `Compaction completed.${customInstructions ? " (custom instructions applied)" : ""}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null,
        ].filter(Boolean);

        const text = headerLines.join("\n") + (summary ? `\n\n${summary}` : "");

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "session") {
        const stats = (await session.proc.getSessionStats()) as any;

        const lines: string[] = [];
        if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`);
        if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`);
        if (typeof stats?.totalMessages === "number")
          lines.push(`Messages: ${stats.totalMessages}`);

        if (typeof stats?.cost === "number") lines.push(`Cost: ${stats.cost}`);

        const t = stats?.tokens;
        if (t && typeof t === "object") {
          const parts: string[] = [];
          if (typeof t.input === "number") parts.push(`in ${t.input}`);
          if (typeof t.output === "number") parts.push(`out ${t.output}`);
          if (typeof t.cacheRead === "number") parts.push(`cache read ${t.cacheRead}`);
          if (typeof t.cacheWrite === "number") parts.push(`cache write ${t.cacheWrite}`);
          if (typeof t.total === "number") parts.push(`total ${t.total}`);
          if (parts.length) lines.push(`Tokens: ${parts.join(", ")}`);
        }

        // Fallback if stats shape changes.
        const text = lines.length
          ? lines.join("\n")
          : `Session stats:\n${JSON.stringify(stats, null, 2)}`;

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "name") {
        const name = args.join(" ").trim();
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Usage: /name <name>" },
            },
          });
          return { stopReason: "end_turn" };
        }

        try {
          await session.proc.setSessionName(name);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          const hint = /set_session_name/i.test(msg)
            ? " This requires a newer pi version that supports `set_session_name` in RPC mode."
            : "";

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Failed to set session name: ${msg}${hint}` },
            },
          });
          return { stopReason: "end_turn" };
        }

        this.titledSessions.add(session.sessionId);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: name,
            updatedAt: new Date().toISOString(),
          },
        });

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Session name set: ${name}` },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "steering") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const state = (await session.proc.getState()) as any;
        const current = String(state?.steeringMode ?? "");

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Steering mode: ${current || "unknown"}`,
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /steering all | /steering one-at-a-time",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        await session.proc.setSteeringMode(modeRaw as "all" | "one-at-a-time");

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Steering mode set to: ${modeRaw}` },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "follow-up") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const state = (await session.proc.getState()) as any;
        const current = String(state?.followUpMode ?? "");

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Follow-up mode: ${current || "unknown"}`,
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /follow-up all | /follow-up one-at-a-time",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        await session.proc.setFollowUpMode(modeRaw as "all" | "one-at-a-time");

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Follow-up mode set to: ${modeRaw}` },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "changelog") {
        // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
        const findChangelog = (): string | null => {
          // 1) Locate the installed pi package by resolving the `pi` executable.
          // On Node installs, `pi` typically resolves to .../@earendil-works/pi-coding-agent/dist/cli.js
          try {
            const whichCmd = process.platform === "win32" ? "where" : "which";
            const which = spawnSync(whichCmd, ["pi"], { encoding: "utf-8" });
            const piPath = String(which.stdout ?? "")
              .split(/\r?\n/)[0]
              ?.trim();

            if (piPath) {
              const resolved = realpathSync(piPath);
              const pkgRoot = dirname(dirname(resolved));
              const p = join(pkgRoot, "CHANGELOG.md");
              if (existsSync(p)) return p;
            }
          } catch {
            // ignore
          }

          // 2) Fallback: ask npm where global modules live.
          try {
            const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
            const root = String(npmRoot.stdout ?? "").trim();
            if (root) {
              const p = join(root, "@earendil-works", "pi-coding-agent", "CHANGELOG.md");
              if (existsSync(p)) return p;
            }
          } catch {
            // ignore
          }

          return null;
        };

        const changelogPath = findChangelog();
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Changelog not found (couldn't locate pi installation).",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        let text = "";
        try {
          text = readFileSync(changelogPath, "utf-8");
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Failed to read changelog: ${String(e?.message ?? e)}`,
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000;
        if (text.length > maxChars) text = text.slice(0, maxChars) + "\n\n...(truncated)...";

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "export") {
        // For now we always export into the session cwd and do not accept a user-provided path.
        // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
        // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
        // (no id), which would otherwise hang our request. So we guard here.
        const state = (await session.proc.getState()) as any;
        const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
        const messageCount = typeof state?.messageCount === "number" ? state.messageCount : 0;

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Nothing to export yet (no session messages). Send a prompt first.",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        try {
          const raw = readFileSync(sessionFile, "utf-8");
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "Nothing to export yet (empty session file). Send a prompt first.",
                },
              },
            });
            return { stopReason: "end_turn" };
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Couldn't read session file for export. Try sending a prompt first.",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`);

        let resultPath = "";
        try {
          const result = await session.proc.exportHtml(outputPath);
          resultPath = result.path;
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Export failed: ${String(e?.message ?? e)}`,
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Export failed: no output path returned by pi.",
              },
            },
          });
          return { stopReason: "end_turn" };
        }

        const uri = `file://${resultPath}`;

        // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
        // assistant message, so this avoids the "link + duplicate plain text" look.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Session exported: ",
            },
          },
        });

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "resource_link",
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: "text/html",
              title: "Session exported",
            },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "autocompact") {
        const mode = (args[0] ?? "toggle").toLowerCase();
        let enabled: boolean | null = null;
        if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled")
          enabled = true;
        else if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled")
          enabled = false;

        if (enabled === null) {
          // toggle: read current state and invert.
          const state = (await session.proc.getState()) as any;
          const current = Boolean(state?.autoCompactionEnabled);
          enabled = !current;
        }

        await session.proc.setAutoCompaction(enabled);

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`,
            },
          },
        });

        return { stopReason: "end_turn" };
      }
    }

    const result = await session.prompt(message, images);

    debugLog("agent.prompt.session_result", {
      sessionId: params.sessionId,
      result,
    });

    // ACP StopReason does not include "error"; if pi fails we map to end_turn for now,
    // unless we know this was a cancellation.
    const stopReason: StopReason =
      result === "error" ? (session.wasCancelRequested() ? "cancelled" : "end_turn") : result;

    debugLog("agent.prompt.return", {
      sessionId: params.sessionId,
      stopReason,
      rawResult: result,
    });

    // Emit usage telemetry after each prompt turn (best-effort, non-blocking).
    void this.maybeEmitUsageUpdate(params.sessionId, session.proc);

    return { stopReason };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = await this.ensureSession(params.sessionId);
    await session.cancel();
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    await session.cancel();
    this.sessions.close(params.sessionId);
    this.titledSessions.delete(params.sessionId);
    this.sessionAdditionalDirectories.delete(params.sessionId);
    this.sessionDocCtx.delete(params.sessionId);
    return {};
  }

  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP: filter by cwd if provided.
    // Zed currently sends `{}` (no cwd), so we default to the last session cwd to
    // emulate pi's `/resume` picker (project-scoped).
    const storedBySession = new Map(this.store.list().map((s) => [s.sessionId, s]));
    const all = listPiSessions().map((session) => ({
      ...session,
      additionalDirectories: storedBySession.get(session.sessionId)?.additionalDirectories ?? [],
    }));

    const effectiveCwd = (params as any).cwd ?? this.lastSessionCwd;
    const requestedAdditionalDirectories = normalizeAdditionalDirectories(
      (params as { additionalDirectories?: unknown }).additionalDirectories,
      { optional: true },
    );
    const filtered = all.filter((s) => {
      if (effectiveCwd && s.cwd !== effectiveCwd) return false;
      if (requestedAdditionalDirectories === null) return true;
      return sameStringArray(s.additionalDirectories, requestedAdditionalDirectories);
    });

    // Cursor-based pagination (opaque cursor). For MVP, we use a simple numeric offset.
    // If cursor is invalid, treat as 0.
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;

    const PAGE_SIZE = 50;
    const page = filtered.slice(start, start + PAGE_SIZE);

    const sessions: SessionInfo[] = page.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt,
      ...(s.additionalDirectories.length ? { additionalDirectories: s.additionalDirectories } : {}),
    }));

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null;

    return { sessions, nextCursor, _meta: {} };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }

    this.sessions.close(params.sessionId);
    const additionalDirectories =
      normalizeAdditionalDirectories(
        (params as { additionalDirectories?: unknown }).additionalDirectories,
      ) ?? [];
    this.lastSessionCwd = params.cwd;

    const stored = this.store.get(params.sessionId);
    const storedSessionFile = stored?.sessionFile;
    const storedExists = typeof storedSessionFile === "string" && existsSync(storedSessionFile);
    const sessionFile = storedExists ? storedSessionFile : findPiSessionFile(params.sessionId);
    if (!sessionFile) throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);

    const proc = await PiRpcProcess.spawn({
      cwd: params.cwd,
      sessionPath: sessionFile,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      agentDir: getAgentDir(),
    });

    const fileCommands = loadSlashCommands(params.cwd);
    const session = this.sessions.getOrCreate(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      conn: this.conn,
      proc,
      fileCommands,
    });
    (this.sessions as any).closeAllExcept?.(session.sessionId);

    this.sessionAdditionalDirectories.set(params.sessionId, additionalDirectories);
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile,
      additionalDirectories,
    });

    const state = await proc.getState().catch(() => null);
    const models = await getModelState(proc, params.cwd, { state });
    const thinking = await getThinkingState(proc, { state });
    const metadata = buildSessionMetadata({ state, models, sessionFile, additionalDirectories });

    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: { sessionUpdate: "session_info_update", _meta: { piAcp: metadata } },
    });
    void this.maybeEmitUsageUpdate(session.sessionId, proc, state);

    setTimeout(() => {
      void this.emitAvailableCommands(session.sessionId, proc, params.cwd, fileCommands);
    }, 50);

    return {
      models,
      modes: thinking,
      _meta: { piAcp: { ...metadata, startupInfo: null } },
    };
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }

    const additionalDirectories =
      normalizeAdditionalDirectories(
        (params as { additionalDirectories?: unknown }).additionalDirectories,
      ) ?? [];
    const stored = this.store.get(params.sessionId);
    const sourceFile =
      typeof stored?.sessionFile === "string" && existsSync(stored.sessionFile)
        ? stored.sessionFile
        : findPiSessionFile(params.sessionId);
    if (!sourceFile) throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);

    const raw = readFileSync(sourceFile, "utf8");
    const firstNewline = raw.indexOf("\n");
    const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
    const rest = firstNewline === -1 ? "" : raw.slice(firstNewline + 1);
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(firstLine) as Record<string, unknown>;
    } catch {
      throw RequestError.internalError({}, `Invalid pi session header: ${sourceFile}`);
    }

    const sessionId = randomUUID();
    const forkDir = join(getPiSessionsDir(), "forked");
    mkdirSync(forkDir, { recursive: true });
    const forkFile = join(forkDir, `${sessionId}.jsonl`);
    writeFileSync(
      forkFile,
      JSON.stringify({ ...header, id: sessionId, cwd: params.cwd }) + "\n" + rest,
      "utf8",
    );

    const proc = await PiRpcProcess.spawn({
      cwd: params.cwd,
      sessionPath: forkFile,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      agentDir: getAgentDir(),
    });
    const fileCommands = loadSlashCommands(params.cwd);
    const session = this.sessions.getOrCreate(sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      conn: this.conn,
      proc,
      fileCommands,
    });
    (this.sessions as any).closeAllExcept?.(session.sessionId);

    this.lastSessionCwd = params.cwd;
    this.sessionAdditionalDirectories.set(sessionId, additionalDirectories);
    this.store.upsert({ sessionId, cwd: params.cwd, sessionFile: forkFile, additionalDirectories });

    const state = await proc.getState().catch(() => null);
    const models = await getModelState(proc, params.cwd, { state });
    const thinking = await getThinkingState(proc, { state });
    const metadata = buildSessionMetadata({
      state,
      models,
      sessionFile: forkFile,
      additionalDirectories,
    });

    void this.conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "session_info_update", _meta: { piAcp: metadata } },
    });
    setTimeout(() => {
      void this.emitAvailableCommands(sessionId, proc, params.cwd, fileCommands);
    }, 50);

    return {
      sessionId,
      models,
      modes: thinking,
      _meta: { piAcp: { ...metadata, startupInfo: null } },
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    debugLog("agent.loadSession.enter", {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers?.length ?? 0,
    });

    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }

    // If the client is re-loading a session that is already active, tear down the existing
    // pi subprocess so we can start fresh and re-advertise commands reliably.
    // (Some clients may call session/load when restoring from history.)
    this.sessions.close(params.sessionId);

    const additionalDirectories =
      normalizeAdditionalDirectories(
        (params as { additionalDirectories?: unknown }).additionalDirectories,
      ) ?? [];

    this.lastSessionCwd = params.cwd;

    // MVP: ignore mcpServers.
    // Prefer ACP-created mapping first (fast path), otherwise scan pi sessions dir.
    const stored = this.store.get(params.sessionId);
    const storedSessionFile = stored?.sessionFile;
    const storedExists = typeof storedSessionFile === "string" && existsSync(storedSessionFile);
    const scannedSessionFile = storedExists ? null : findPiSessionFile(params.sessionId);
    const sessionFile = storedExists ? storedSessionFile : scannedSessionFile;

    debugLog("agent.loadSession.session_file", {
      sessionId: params.sessionId,
      storedSessionFile: storedSessionFile ?? null,
      storedExists,
      scannedSessionFile: scannedSessionFile ?? null,
      resolvedSessionFile: sessionFile ?? null,
      usedStored: storedExists,
    });

    if (!sessionFile) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
    }

    // Spawn pi and point it directly at the session file.
    let proc: PiRpcProcess;
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
        agentDir: getAgentDir(),
      });
    } catch (e: any) {
      if (e?.name === "PiRpcSpawnError") {
        throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e));
      }
      throw e;
    }

    const fileCommands = loadSlashCommands(params.cwd);
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    const includeExtensionCommands = getEnableExtensionCommands(params.cwd);

    const session = this.sessions.getOrCreate(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      proc,
      fileCommands,
    });

    // Policy: within a single ACP connection (one Zed window), keep only one live pi subprocess.
    // (Tests sometimes stub out `this.sessions`, so guard the call.)
    (this.sessions as any).closeAllExcept?.(session.sessionId);

    // (Optional) ensure mapping stays fresh.
    this.sessionAdditionalDirectories.set(params.sessionId, additionalDirectories);
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile,
      additionalDirectories,
    });

    // Replay full conversation history.
    const data = (await proc.getMessages()) as any;
    const messages = Array.isArray(data?.messages) ? data.messages : [];

    debugLog("agent.loadSession.replay.begin", {
      sessionId: params.sessionId,
      messageCount: messages.length,
    });

    const argsByToolCallId = buildArgsMap(messages);

    for (const m of messages) {
      const role = String(m?.role ?? "");

      if (role === "user") {
        const text = normalizePiMessageText(m?.content);
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text },
            },
          });
        }
      }

      if (role === "assistant") {
        const text = normalizePiAssistantText(m?.content);
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          });
        }
      }

      if (role === "toolResult") {
        const toolName = String((m as any)?.toolName ?? "tool");
        const toolCallId = String((m as any)?.toolCallId ?? randomUUID());
        const isError = Boolean((m as any)?.isError);
        const args = argsByToolCallId.get(toolCallId);
        const locations = toToolCallLocations(args, params.cwd, undefined, toolName);

        // Create a synthetic ACP tool call to render historic tool usage.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: toToolTitle(toolName, args, params.cwd),
            kind: toToolKind(toolName),
            status: "completed",
            content: toToolContent(toolName, args),
            rawInput: args ?? null,
            rawOutput: m,
            locations,
          },
        });

        const text = toolResultToText(m);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: isError ? "failed" : "completed",
            content: text ? [{ type: "content", content: { type: "text", text } }] : null,
            rawOutput: m,
          },
        });
      }
    }

    const loadState = await proc.getState().catch(() => null);
    const models = await getModelState(proc, params.cwd, { state: loadState });
    const thinking = await getThinkingState(proc, { state: loadState });

    const metadata = buildSessionMetadata({
      state: loadState,
      models,
      sessionFile,
      additionalDirectories,
    });

    const response = {
      models,
      modes: thinking,
      _meta: {
        piAcp: {
          ...metadata,
          startupInfo: null,
        },
      },
    };

    debugLog("agent.loadSession.return", {
      sessionId: params.sessionId,
      messageCount: messages.length,
      hasModels: Boolean(models),
      currentModeId: thinking.currentModeId,
      metadata,
    });

    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { piAcp: metadata },
      },
    });

    // Emit usage telemetry for the loaded session (best-effort, non-blocking).
    // Pass the already-fetched state to avoid an extra RPC round-trip.
    void this.maybeEmitUsageUpdate(session.sessionId, proc, loadState);

    // Advertise slash commands after the response so the client knows the session exists.
    setTimeout(() => {
      void (async () => {
        try {
          const pi = (await proc.getCommands()) as any;
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands,
          });
          const availableCommands = mergeCommands(commands, builtinAvailableCommands());

          debugLog("agent.commands.available", {
            sessionId: session.sessionId,
            source: "pi-rpc",
            count: availableCommands.length,
            names: availableCommands.map((c) => c.name),
          });

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands,
            },
          });
          return;
        } catch (error) {
          debugLog("agent.commands.pi_failed", {
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        const availableCommands = mergeCommands(
          toAvailableCommands(fileCommands),
          builtinAvailableCommands(),
        );
        debugLog("agent.commands.available", {
          sessionId: session.sessionId,
          source: "file-fallback",
          count: availableCommands.length,
          names: availableCommands.map((c) => c.name),
        });

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands,
          },
        });
      })();
    }, 50);

    return response;
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!method.startsWith("pi-acp/")) {
      throw RequestError.invalidParams(`Unsupported extension method: ${method}`);
    }

    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    const session = sessionId ? await this.ensureSession(sessionId) : null;

    if (method === "pi-acp/session") {
      if (!session) throw RequestError.invalidParams("pi-acp/session requires sessionId");
      const stored = this.store.get(session.sessionId);
      return {
        sessionId: session.sessionId,
        cwd: session.cwd,
        additionalDirectories: this.sessionAdditionalDirectories.get(session.sessionId) ?? [],
        sessionFile: stored?.sessionFile ?? null,
      };
    }

    if (method === "pi-acp/state") {
      if (!session) throw RequestError.invalidParams("pi-acp/state requires sessionId");
      try {
        const state = (await session.proc.getState()) as Record<string, unknown>;
        return { state };
      } catch (err) {
        throw mapPiRpcError(err, "Failed to fetch pi state");
      }
    }

    if (method === "pi-acp/commands" || method === "pi-acp/reloadCommands") {
      if (!session) throw RequestError.invalidParams(`${method} requires sessionId`);
      try {
        const pi = (await session.proc.getCommands()) as any;
        const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
          enableSkillCommands: getEnableSkillCommands(session.cwd),
          includeExtensionCommands: getEnableExtensionCommands(session.cwd),
        });
        const availableCommands = mergeCommands(commands, builtinAvailableCommands());
        if (method === "pi-acp/reloadCommands") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands,
            },
          });
        }
        return {
          source: "pi-rpc",
          count: availableCommands.length,
          availableCommands,
        };
      } catch (err) {
        throw mapPiRpcError(err, "Failed to fetch pi commands");
      }
    }

    throw RequestError.invalidParams(`Unsupported extension method: ${method}`);
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (method !== "pi-acp/reloadCommands") return;
    await this.extMethod(method, params);
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = await this.ensureSession(params.sessionId);

    if (params.configId === "auto_compaction") {
      if (typeof params.value !== "boolean") {
        throw RequestError.invalidParams("auto_compaction requires a boolean value");
      }
      await session.proc.setAutoCompaction(params.value);
    } else if (params.configId === "steering_mode") {
      if (params.value !== "all" && params.value !== "one-at-a-time") {
        throw RequestError.invalidParams(`Invalid steering_mode value: ${String(params.value)}`);
      }
      await session.proc.setSteeringMode(params.value);
    } else if (params.configId === "follow_up_mode") {
      if (params.value !== "all" && params.value !== "one-at-a-time") {
        throw RequestError.invalidParams(`Invalid follow_up_mode value: ${String(params.value)}`);
      }
      await session.proc.setFollowUpMode(params.value);
    } else {
      throw RequestError.invalidParams(`Unknown configId: ${params.configId}`);
    }

    const state = await session.proc.getState().catch(() => null);
    const configOptions = buildConfigOptions(state);
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions },
    });
    return { configOptions };
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const session = await this.ensureSession(params.sessionId);

    // Accept either:
    //  - "provider/model" (preferred, matches how we advertise)
    //  - "model" (fallback, we try to resolve via available models)
    let provider: string | null = null;
    let modelId: string | null = null;

    const requestedModelId = params.modelId.trim();
    if (!requestedModelId) throw RequestError.invalidParams("modelId must not be empty");

    if (requestedModelId.includes("/")) {
      const [p, ...rest] = requestedModelId.split("/");
      provider = p.trim();
      modelId = rest.join("/").trim();
    } else {
      modelId = requestedModelId;
    }

    if (!provider) {
      const data = (await session.proc.getAvailableModels()) as any;
      const models: any[] = Array.isArray(data?.models) ? data.models : [];
      const found = models.find((m) => String(m?.id) === modelId);
      if (found) {
        provider = String(found.provider);
        modelId = String(found.id);
      }
    }

    if (!provider || !modelId) {
      throw RequestError.invalidParams(
        `Unknown modelId: ${params.modelId} — use provider/modelId format (e.g. anthropic/claude-sonnet-4)`,
      );
    }

    try {
      await session.proc.setModel(provider, modelId);
    } catch (err) {
      throw mapPiRpcError(err, "Failed to set model");
    }

    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { model: `${provider}/${modelId}` } },
      },
    });
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = await this.ensureSession(params.sessionId);

    const mode = String(params.modeId);
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`);
    }

    try {
      await session.proc.setThinkingLevel(mode);
    } catch (err) {
      throw mapPiRpcError(err, "Failed to set thinking level");
    }

    // Let the client know the current mode changed (keeps the dropdown in sync).
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: mode,
      },
    });

    return {};
  }
}

/**
 * Negotiate agent capabilities based on what the client advertises.
 *
 * This is the single place where we decide what to advertise in `InitializeResponse`.
 * We only claim capabilities this adapter actually implements. Features the client
 * doesn't support (terminal, fs, NES, providers) are omitted even if the adapter
 * had them, to keep the handshake honest.
 */
export function negotiateCapabilities(clientCaps: ClientCapabilities | undefined): {
  agentCapabilities: AgentCapabilities;
  debug: Record<string, unknown>;
} {
  const embeddedContext = process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === "true";

  // Capabilities we actually implement. Nothing is claimed here unless there is a
  // real handler for it in this file.
  //
  // Intentionally NOT advertised:
  //   - NES: pi is a turn/session agent, not a next-edit/autocomplete engine.
  //   - audio: ACP has AudioContent, but pi RPC has no audio input/output path.
  //   - providers/auth.logout: no pi RPC provider-management or safe auth-reset surface.
  //   - terminal/fs delegation: pi executes locally; don't claim client-side delegation.
  const agentCapabilities: AgentCapabilities = {
    loadSession: true,
    mcpCapabilities: { http: false, sse: false },
    promptCapabilities: {
      image: true,
      audio: false,
      embeddedContext,
    },
    sessionCapabilities: {
      additionalDirectories: {},
      // **UNSTABLE** ACP capabilities used by Zed's session picker.
      // Both closeSession and unstable_listSessions are implemented.
      close: {},
      list: {},
      fork: {},
      // session/resume is implemented: attach to an existing session without replaying history.
      resume: {},
    },
  };

  // Summary of what the client told us it supports — handy for debugging handshake issues.
  const debug: Record<string, unknown> = {
    negotiated: {
      loadSession: true,
      additionalDirectories: true,
      sessionClose: true,
      sessionList: true,
      sessionFork: true,
      sessionResume: true,
      image: true,
      audio: false,
      embeddedContext,
    },
    clientAdvertised: {
      terminal: clientCaps?.terminal ?? false,
      fs: !!clientCaps?.fs,
      nes: !!clientCaps?.nes,
      elicitation: !!clientCaps?.elicitation,
      auth: !!clientCaps?.auth,
    },
  };

  return { agentCapabilities, debug };
}

export function buildConfigOptions(state: unknown): SessionConfigOption[] {
  const s = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
  const steeringMode = s["steeringMode"] === "one-at-a-time" ? "one-at-a-time" : "all";
  const followUpMode = s["followUpMode"] === "one-at-a-time" ? "one-at-a-time" : "all";
  const deliveryOptions = [
    { value: "all", name: "All messages", description: "Send all queued messages together." },
    {
      value: "one-at-a-time",
      name: "One at a time",
      description: "Send queued messages one at a time.",
    },
  ];

  return [
    {
      id: "auto_compaction",
      name: "Auto-compaction",
      description: "Automatically compact long pi sessions when context gets full.",
      category: "_pi",
      type: "boolean",
      currentValue: s["autoCompactionEnabled"] === false ? false : true,
    },
    {
      id: "steering_mode",
      name: "Steering mode",
      description: "How pi should deliver steering prompts sent while a turn is running.",
      category: "_pi",
      type: "select",
      currentValue: steeringMode,
      options: deliveryOptions,
    },
    {
      id: "follow_up_mode",
      name: "Follow-up mode",
      description: "How pi should deliver follow-up prompts sent while a turn is running.",
      category: "_pi",
      type: "select",
      currentValue: followUpMode,
      options: deliveryOptions,
    },
  ];
}

/**
 * Build an ACP UsageUpdate from pi session stats and state.
 * Returns null if there's not enough data to emit a meaningful update.
 */
export function buildUsageUpdate(
  stats: unknown,
  state: unknown,
): (UsageUpdate & { sessionUpdate: "usage_update" }) | null {
  const s = stats && typeof stats === "object" ? (stats as Record<string, unknown>) : null;
  const st = state && typeof state === "object" ? (state as Record<string, unknown>) : null;

  if (!s) return null;

  const tokens =
    s["tokens"] && typeof s["tokens"] === "object"
      ? (s["tokens"] as Record<string, unknown>)
      : null;

  // "used" = tokens currently filling the context window.
  // Best proxy: input tokens (what's in the context window on the input side).
  // Fall back to total if input is unavailable.
  const inputTokens = typeof tokens?.["input"] === "number" ? (tokens["input"] as number) : null;
  const totalTokens = typeof tokens?.["total"] === "number" ? (tokens["total"] as number) : null;
  const used = inputTokens ?? totalTokens ?? null;

  if (used === null) return null;

  // "size" = model context window limit.
  const model =
    st?.["model"] && typeof st["model"] === "object"
      ? (st["model"] as Record<string, unknown>)
      : null;
  const contextWindow =
    typeof model?.["contextWindow"] === "number" ? (model["contextWindow"] as number) : 0;

  // Don't emit when the context window size is unknown (0). Clients that render a
  // context-bar would show nonsense (0/0 or divide-by-zero) without a real limit.
  if (contextWindow <= 0) return null;

  // Cost (optional). Pi reports cost as a plain number (USD).
  const rawCost = typeof s["cost"] === "number" ? (s["cost"] as number) : null;
  const cost = rawCost !== null ? { amount: rawCost, currency: "USD" } : null;

  const update: UsageUpdate & { sessionUpdate: "usage_update" } = {
    sessionUpdate: "usage_update",
    size: contextWindow,
    used,
    ...(cost !== null ? { cost } : {}),
  };

  return update;
}

function buildSessionMetadata(opts: {
  state?: any | null;
  models?: { currentModelId?: string } | null;
  sessionFile?: string | null;
  additionalDirectories?: string[];
}): Record<string, unknown> {
  const model = opts.state?.model;
  const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;

  return Object.fromEntries(
    Object.entries({
      version: pkg.version ?? "0.0.0",
      model: opts.models?.currentModelId,
      contextWindow,
      agentDir: getAgentDir(),
      piCodingAgentDir: getAgentDir(),
      inheritedPiCodingAgentDir: process.env.PI_CODING_AGENT_DIR || undefined,
      sessionFile: opts.sessionFile || undefined,
      additionalDirectories: opts.additionalDirectories?.length
        ? opts.additionalDirectories
        : undefined,
    }).filter(([, value]) => value !== undefined),
  );
}

function titleFromPrompt(message: string): string | null {
  const firstLine = message.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim();

  if (!firstLine || firstLine.startsWith("/")) return null;

  const max = 60;
  return firstLine.length <= max ? firstLine : `${firstLine.slice(0, max - 1).trimEnd()}…`;
}

function isThinkingLevel(x: string): x is ThinkingLevel {
  return (
    x === "off" || x === "minimal" || x === "low" || x === "medium" || x === "high" || x === "xhigh"
  );
}

async function getThinkingState(
  proc: PiRpcProcess,
  pre?: { state?: any | null },
): Promise<{
  availableModes: Array<{
    id: string;
    name: string;
    description?: string | null;
  }>;
  currentModeId: string;
}> {
  // Ask pi for current thinking level.
  let current: ThinkingLevel = "medium";

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any;
      } catch {
        return null;
      }
    })());

  const tl = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null;
  if (tl && isThinkingLevel(tl)) current = tl;

  const available: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

  return {
    currentModeId: current,
    availableModes: available.map((id) => ({
      id,
      name: thinkingLevelName(id),
      description: thinkingLevelDescription(id),
    })),
  };
}

function thinkingLevelName(level: ThinkingLevel): string {
  switch (level) {
    case "off":
      return "No thinking";
    case "minimal":
      return "Minimal thinking";
    case "low":
      return "Low thinking";
    case "medium":
      return "Medium thinking";
    case "high":
      return "High thinking";
    case "xhigh":
      return "Extended thinking";
  }
}

function thinkingLevelDescription(level: ThinkingLevel): string {
  switch (level) {
    case "off":
      return "Disables extended thinking; the model responds directly without reasoning.";
    case "minimal":
      return "Very brief reasoning pass before responding.";
    case "low":
      return "Light reasoning; faster responses with modest accuracy gains.";
    case "medium":
      return "Balanced reasoning; recommended for most tasks.";
    case "high":
      return "Deep reasoning; better for complex, multi-step problems.";
    case "xhigh":
      return "Maximum reasoning budget; slowest but most thorough.";
  }
}

function stripThinkingSuffix(pattern: string): string {
  const colon = pattern.lastIndexOf(":");
  if (colon === -1) return pattern;

  const suffix = pattern.slice(colon + 1);
  return isThinkingLevel(suffix) ? pattern.slice(0, colon) : pattern;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

function matchesEnabledModel(
  model: { provider: string; id: string; name?: string },
  pattern: string,
): boolean {
  const normalized = stripThinkingSuffix(pattern).trim();
  if (!normalized) return false;

  const fullId = `${model.provider}/${model.id}`;
  const candidates = [fullId, model.id, model.name ?? ""];

  if (normalized.includes("*") || normalized.includes("?")) {
    const re = globToRegExp(normalized);
    return candidates.some((candidate) => re.test(candidate));
  }

  return candidates.some((candidate) => candidate.toLowerCase() === normalized.toLowerCase());
}

function filterEnabledModels(models: any[], cwd: string): any[] {
  const enabledModels = getEnabledModels(cwd);
  if (!enabledModels) return models;

  const filtered = models.filter((model) =>
    enabledModels.some((pattern) =>
      matchesEnabledModel(
        {
          provider: String(model?.provider ?? "").trim(),
          id: String(model?.id ?? "").trim(),
          name: typeof model?.name === "string" ? model.name : undefined,
        },
        pattern,
      ),
    ),
  );

  return filtered.length ? filtered : models;
}

async function getModelState(
  proc: PiRpcProcess,
  cwd: string,
  pre?: { state?: any | null; availableModels?: any | null },
): Promise<{
  availableModels: ModelInfo[];
  currentModelId: string;
} | null> {
  // Ask pi for available models.
  let availableModels: ModelInfo[] = [];

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        return (await proc.getAvailableModels()) as any;
      } catch {
        return null;
      }
    })());

  const models: any[] = filterEnabledModels(Array.isArray(data?.models) ? data.models : [], cwd);
  availableModels = models
    .map((m) => {
      const provider = String(m?.provider ?? "").trim();
      const id = String(m?.id ?? "").trim();
      if (!provider || !id) return null;

      const name = String(m?.name ?? id);
      return {
        modelId: `${provider}/${id}`,
        name,
        description: null,
        _meta: { provider },
      } satisfies ModelInfo;
    })
    .filter(Boolean) as ModelInfo[];

  // Ask pi what model is currently active.
  let currentModelId: string | null = null;

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any;
      } catch {
        return null;
      }
    })());

  const model = state?.model;
  if (model && typeof model === "object") {
    const provider = String((model as any).provider ?? "").trim();
    const id = String((model as any).id ?? "").trim();
    if (provider && id) currentModelId = `${provider}/${id}`;
  }

  if (!availableModels.length && !currentModelId) return null;

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? "default";

  return {
    availableModels,
    currentModelId,
  };
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v);
}

function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number(n));
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function buildUpdateNotice(): string | null {
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8" });
    const installed = (
      String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()
    ).replace(/^v/i, "");

    if (!installed || !isSemver(installed)) return null;

    const latestRes = spawnSync("npm", ["view", "@earendil-works/pi-coding-agent", "version"], {
      encoding: "utf-8",
      timeout: 800,
    });
    const latest = String(latestRes.stdout ?? "")
      .trim()
      .replace(/^v/i, "");

    if (!latest || !isSemver(latest)) return null;
    if (compareSemver(latest, installed) <= 0) return null;

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``;
  } catch {
    return null;
  }
}

function buildStartupInfo(opts: {
  cwd: string;
  additionalDirectories?: string[];
  fileCommands: ReturnType<typeof loadSlashCommands>;
  updateNotice: string | null;
}): string {
  void opts.fileCommands;

  const md: string[] = [];

  // pi version header
  try {
    const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8" });
    const installed = (
      String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()
    ).replace(/^v/i, "");
    if (installed) {
      md.push(`pi v${installed}`);
      md.push("---");
      md.push("");
    }
  } catch {
    // ignore
  }

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map((s) => s.trim()).filter(Boolean);
    if (!cleaned.length) return;

    md.push(`## ${title}`);
    for (const item of cleaned) md.push(`- ${item}`);
    md.push("");
  };

  addSection("Pi environment", [
    `Agent dir: ${getAgentDir()}`,
    `PI_CODING_AGENT_DIR: ${getAgentDir()}`,
    `Inherited PI_CODING_AGENT_DIR: ${process.env.PI_CODING_AGENT_DIR || "<unset>"}`,
  ]);

  // Context
  const contextItems: string[] = [];
  const contextPath = join(opts.cwd, "AGENTS.md");
  if (existsSync(contextPath)) contextItems.push(contextPath);
  addSection("Context", contextItems);
  addSection("Additional directories", opts.additionalDirectories ?? []);

  // Skills
  const skillsItems: string[] = [];

  const pushSkillFromRoot = (root: string) => {
    try {
      // Direct .md files in root
      for (const e of readdirSync(root)) {
        const p = join(root, e);
        try {
          const st = statSync(p);
          if (st.isFile() && e.toLowerCase().endsWith(".md")) {
            skillsItems.push(p);
          }
        } catch {
          // ignore
        }
      }

      // Recursive SKILL.md under subdirectories
      const stack: string[] = [root];
      while (stack.length) {
        const dir = stack.pop()!;
        let entries: string[] = [];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }

        for (const name of entries) {
          // Skip obvious noise
          if (name === "node_modules" || name === ".git") continue;
          const p = join(dir, name);
          let st;
          try {
            st = statSync(p);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            stack.push(p);
          } else if (st.isFile() && name === "SKILL.md") {
            skillsItems.push(p);
          }
        }
      }
    } catch {
      // ignore
    }
  };

  // Global skills
  // Use getAgentDir() so this respects PI_CODING_AGENT_DIR overrides.
  const globalSkillsDir = join(getAgentDir(), "skills");
  pushSkillFromRoot(globalSkillsDir);

  // Also support ~/.agents/skills (pi skill discovery)
  const legacyAgentsSkillsDir = join(process.env.HOME ?? "", ".agents", "skills");
  pushSkillFromRoot(legacyAgentsSkillsDir);

  // Project skills (.pi/skills)
  const projectSkillsDir = join(opts.cwd, ".pi", "skills");
  pushSkillFromRoot(projectSkillsDir);

  addSection("Skills", skillsItems);

  // Prompts
  const promptsItems: string[] = [];
  const promptsDir = join(getAgentDir(), "prompts");
  try {
    const prompts = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
    for (const f of prompts) promptsItems.push(`/${basename(f, ".md")}`);
  } catch {
    // ignore
  }
  addSection("Prompts", promptsItems);

  // Extensions
  const extItems: string[] = [];
  const extDir = join(getAgentDir(), "extensions");
  try {
    const exts = readdirSync(extDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    for (const f of exts) extItems.push(join(extDir, f));
  } catch {
    // ignore
  }

  for (const pkg of getConfiguredPackages(opts.cwd)) extItems.push(pkg);

  addSection("Extensions", extItems);

  if (opts.updateNotice) {
    md.push("---");
    md.push(opts.updateNotice);
    md.push("");
  }

  // Do NOT include themes (per request).
  return md.join("\n").trim() + "\n";
}

function readNearestPackageJson(metaUrl: string): {
  name?: string;
  version?: string;
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl));

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, "package.json");
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, "utf-8")) as any;
        return { name: json?.name, version: json?.version };
      }
      dir = dirname(dir);
    }
  } catch {
    // ignore
  }
  return { name: "pi-acp", version: "0.0.0" };
}
