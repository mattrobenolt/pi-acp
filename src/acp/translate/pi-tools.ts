import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

export function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const resolvedCwd = resolvePath(cwd);
  const resolvedFile = resolvePath(cwd, filePath);
  const rel = relative(resolvedCwd, resolvedFile);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : filePath;
}

export function toToolTitle(toolName: string, args: unknown, cwd?: string): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (toolName) {
    case "bash": {
      const command =
        typeof a?.command === "string" ? a.command : typeof a?.cmd === "string" ? a.cmd : undefined;
      return command ?? "Terminal";
    }
    case "read": {
      const path = typeof a?.path === "string" ? toDisplayPath(a.path, cwd) : undefined;
      const offset = typeof a?.offset === "number" ? a.offset : undefined;
      const limit = typeof a?.limit === "number" ? a.limit : undefined;
      let range = "";
      if (limit && limit > 0) range = ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`;
      else if (offset) range = ` (from line ${offset})`;
      return path ? `Read ${path}${range}` : "Read";
    }
    case "find": {
      let label = "Find";
      if (typeof a?.path === "string" && a.path) label += ` \`${toDisplayPath(a.path, cwd)}\``;
      if (typeof a?.pattern === "string" && a.pattern) label += ` \`${a.pattern}\``;
      return label;
    }
    case "grep": {
      let label = "grep";
      if (a?.ignoreCase === true || a?.["-i"] === true) label += " -i";
      if (a?.lineNumbers === true || a?.["-n"] === true) label += " -n";
      const context = numberArg(a, "context") ?? numberArg(a, "-C");
      const before = numberArg(a, "before") ?? numberArg(a, "-B");
      const after = numberArg(a, "after") ?? numberArg(a, "-A");
      if (context !== undefined) label += ` -C ${context}`;
      if (before !== undefined) label += ` -B ${before}`;
      if (after !== undefined) label += ` -A ${after}`;
      const outputMode = typeof a?.output_mode === "string" ? a.output_mode : undefined;
      if (outputMode === "files_with_matches") label += " -l";
      else if (outputMode === "count") label += " -c";
      const head = numberArg(a, "head_limit") ?? numberArg(a, "limit");
      if (head !== undefined) label += ` | head -${head}`;
      if (typeof a?.glob === "string") label += ` --include=\"${a.glob}\"`;
      if (typeof a?.type === "string") label += ` --type=${a.type}`;
      if (a?.multiline === true) label += " -P";
      if (typeof a?.pattern === "string") label += ` \"${a.pattern}\"`;
      if (typeof a?.path === "string" && a.path && a.path !== ".")
        label += ` ${toDisplayPath(a.path, cwd)}`;
      return label;
    }
    case "ls": {
      const path = typeof a?.path === "string" ? toDisplayPath(a.path, cwd) : undefined;
      return path ? `List ${path}` : "List files";
    }
    case "webfetch": {
      const url = typeof a?.url === "string" ? a.url : undefined;
      return url ? `Fetch ${url}` : "Fetch";
    }
    case "websearch": {
      const query = typeof a?.query === "string" ? a.query : undefined;
      return query ? `\"${query}\"` : "Web search";
    }
    case "mcp": {
      const tool = typeof a?.tool === "string" ? a.tool : undefined;
      const server = typeof a?.server === "string" ? a.server : undefined;
      return tool ? `MCP ${server ? `${server}/` : ""}${tool}` : "MCP";
    }
    case "subagent": {
      const agent = typeof a?.agent === "string" ? a.agent : undefined;
      return agent ? `Subagent ${agent}` : "Subagent";
    }
    case "todo": {
      const action = typeof a?.action === "string" ? a.action : undefined;
      return action ? `Todo ${action}` : "Todo";
    }
    case "term": {
      const action = typeof a?.action === "string" ? a.action : undefined;
      const name = typeof a?.name === "string" ? a.name : undefined;
      return action ? `${action}${name ? ` ${name}` : ""}` : "Terminal";
    }
    case "memory_read":
      return "Read memory";
    case "memory_search":
      return "Search memory";
    case "memory_write":
      return "Write memory";
    case "scratchpad": {
      const action = typeof a?.action === "string" ? a.action : undefined;
      return action ? `Scratchpad ${action}` : "Scratchpad";
    }
    case "write": {
      const path = typeof a?.path === "string" ? toDisplayPath(a.path, cwd) : undefined;
      return path ? `Write ${path}` : "Write";
    }
    case "edit": {
      const path = typeof a?.path === "string" ? toDisplayPath(a.path, cwd) : undefined;
      return path ? `Edit ${path}` : "Edit";
    }
    default:
      return toolName || "Unknown Tool";
  }
}

export function toToolContent(toolName: string, args: unknown): ToolCallContent[] | undefined {
  const a = args as Record<string, unknown> | null | undefined;
  let text: string | null = null;

  switch (toolName) {
    case "webfetch":
      text = typeof a?.objective === "string" ? a.objective : null;
      break;
    case "websearch":
      text = typeof a?.query === "string" ? a.query : null;
      break;
    case "subagent":
      text = typeof a?.task === "string" ? a.task : null;
      break;
    case "mcp":
      text = stringifyJson(a?.args ?? a);
      break;
    default:
      return undefined;
  }

  return text
    ? [{ type: "content", content: { type: "text", text: truncate(text, 4000) } }]
    : undefined;
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
      return "read";
    case "find":
    case "grep":
      return "search";
    case "websearch":
    case "webfetch":
      return "fetch";
    case "term":
      return "execute";
    case "subagent":
    case "todo":
      return "think";
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
  if (toolName === "find" || toolName === "grep" || toolName === "websearch" || toolName === "ls")
    return undefined;

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
    if (Object.keys(result as Record<string, unknown>).length === 1) return "";
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

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  return typeof args[key] === "number" ? args[key] : undefined;
}

function stringifyJson(value: unknown): string | null {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…truncated ${text.length - max} chars` : text;
}
