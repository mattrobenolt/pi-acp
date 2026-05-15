import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

export function toToolTitle(toolName: string, args: unknown): string {
  const a = args as Record<string, unknown> | null | undefined;
  switch (toolName) {
    case "bash": {
      const command =
        typeof a?.command === "string" ? a.command : typeof a?.cmd === "string" ? a.cmd : undefined;
      return command ?? "bash";
    }
    case "read": {
      const path = typeof a?.path === "string" ? a.path : undefined;
      return path ? `read: ${path}` : "read";
    }
    case "find": {
      const pattern = typeof a?.pattern === "string" ? a.pattern : undefined;
      const path = typeof a?.path === "string" && a.path !== "." ? ` ${a.path}` : "";
      return pattern ? `find ${pattern}${path}` : "find";
    }
    case "grep": {
      const pattern = typeof a?.pattern === "string" ? a.pattern : undefined;
      return pattern ? `grep ${pattern}` : "grep";
    }
    case "ls": {
      const path = typeof a?.path === "string" ? a.path : undefined;
      return path ? `ls: ${path}` : "ls";
    }
    case "webfetch": {
      const url = typeof a?.url === "string" ? a.url : undefined;
      return url ? `fetch: ${url}` : "webfetch";
    }
    case "websearch": {
      const query = typeof a?.query === "string" ? a.query : undefined;
      return query ? `search web: ${query}` : "websearch";
    }
    case "mcp": {
      const tool = typeof a?.tool === "string" ? a.tool : undefined;
      const server = typeof a?.server === "string" ? a.server : undefined;
      return tool ? `mcp: ${server ? `${server}/` : ""}${tool}` : "mcp";
    }
    case "subagent": {
      const agent = typeof a?.agent === "string" ? a.agent : undefined;
      return agent ? `subagent: ${agent}` : "subagent";
    }
    case "todo": {
      const action = typeof a?.action === "string" ? a.action : undefined;
      return action ? `todo: ${action}` : "todo";
    }
    case "term": {
      const action = typeof a?.action === "string" ? a.action : undefined;
      const name = typeof a?.name === "string" ? a.name : undefined;
      return action ? `${action}${name ? ` ${name}` : ""}` : "term";
    }
    case "memory_read":
    case "memory_search":
    case "memory_write":
      return toolName.replace(/_/g, " ");
    case "scratchpad": {
      const action = typeof a?.action === "string" ? a.action : undefined;
      return action ? `scratchpad: ${action}` : "scratchpad";
    }
    case "write": {
      const path = typeof a?.path === "string" ? a.path : undefined;
      return path ? `write: ${path}` : "write";
    }
    case "edit": {
      const path = typeof a?.path === "string" ? a.path : undefined;
      return path ? `edit: ${path}` : "edit";
    }
    default:
      return toolName;
  }
}

export function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "execute";
    case "ls":
    case "find":
    case "grep":
    case "websearch":
      return "search";
    case "webfetch":
      return "fetch";
    case "term":
      return "execute";
    default:
      return "other";
  }
}

export function toToolCallLocations(
  args: unknown,
  cwd: string,
  line?: number,
  toolName?: string,
): ToolCallLocation[] | undefined {
  if (toolName === "find" || toolName === "grep" || toolName === "websearch") return undefined;

  const path =
    typeof (args as { path?: unknown } | null | undefined)?.path === "string"
      ? (args as { path: string }).path
      : undefined;
  if (!path) return undefined;

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path);
  return [{ path: resolvedPath, ...(typeof line === "number" ? { line } : {}) }];
}

/**
 * Build a map of toolCallId -> args by scanning assistant messages for toolCall content blocks.
 * Used during session replay to populate rawInput and locations for tool_call events.
 */
export function buildArgsMap(messages: unknown[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const m of messages) {
    const role = String((m as any)?.role ?? "");
    if (role !== "assistant") continue;
    const content = (m as any)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if ((block as any)?.type !== "toolCall") continue;
      const id = String((block as any)?.id ?? "");
      const args = (block as any)?.arguments;
      if (id && args !== undefined) {
        map.set(id, args);
      }
    }
  }
  return map;
}

export function toolResultToText(result: unknown): string {
  if (!result) return "";

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content;
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
      .filter(Boolean);
    if (texts.length) return texts.join("");
  }

  const details = (result as any)?.details;

  // Some pi tools return a unified diff in `details.diff`.
  const diff = details?.diff;
  if (typeof diff === "string" && diff.trim()) {
    return diff;
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === "string" ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === "string" ? (result as any).stdout : undefined) ??
    (typeof details?.output === "string" ? details.output : undefined) ??
    (typeof (result as any)?.output === "string" ? (result as any).output : undefined);

  const stderr =
    (typeof details?.stderr === "string" ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === "string" ? (result as any).stderr : undefined);

  const exitCode =
    (typeof details?.exitCode === "number" ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === "number" ? (result as any).exitCode : undefined) ??
    (typeof details?.code === "number" ? details.code : undefined) ??
    (typeof (result as any)?.code === "number" ? (result as any).code : undefined);

  if (
    (typeof stdout === "string" && stdout.trim()) ||
    (typeof stderr === "string" && stderr.trim())
  ) {
    const parts: string[] = [];
    if (typeof stdout === "string" && stdout.trim()) parts.push(stdout);
    if (typeof stderr === "string" && stderr.trim()) parts.push(`stderr:\n${stderr}`);
    if (typeof exitCode === "number") parts.push(`exit code: ${exitCode}`);
    return parts.join("\n\n").trimEnd();
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
