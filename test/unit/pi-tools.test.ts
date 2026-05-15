import test from "node:test";
import assert from "node:assert/strict";
import {
  toolResultToText,
  toToolKind,
  toToolCallLocations,
  buildArgsMap,
} from "../../src/acp/translate/pi-tools.js";

test("toolResultToText: extracts text from content blocks", () => {
  const text = toolResultToText({
    content: [
      { type: "text", text: "hello" },
      { type: "text", text: " world" },
    ],
  });
  assert.equal(text, "hello world");
});

test("toolResultToText: prefers details.diff when present", () => {
  const text = toolResultToText({ details: { diff: "--- a\n+++ b\n" } });
  assert.equal(text, "--- a\n+++ b\n");
});

test("toolResultToText: falls back to JSON", () => {
  const text = toolResultToText({ a: 1 });
  assert.match(text, /"a": 1/);
});

test("toolResultToText: extracts bash stdout/stderr from details", () => {
  const text = toolResultToText({
    details: {
      stdout: "ok\n",
      stderr: "warn\n",
      exitCode: 0,
    },
  });
  assert.match(text, /ok/);
  assert.match(text, /stderr:/);
  assert.match(text, /warn/);
  assert.match(text, /exit code: 0/);
});

test("toToolKind: maps known tool names", () => {
  assert.equal(toToolKind("read"), "read");
  assert.equal(toToolKind("write"), "edit");
  assert.equal(toToolKind("edit"), "edit");
  assert.equal(toToolKind("bash"), "execute");
  assert.equal(toToolKind("websearch"), "other");
  assert.equal(toToolKind("unknown_tool"), "other");
});

test("toToolCallLocations: returns undefined when no path", () => {
  const result = toToolCallLocations({ command: "ls" }, "/cwd");
  assert.equal(result, undefined);
});

test("toToolCallLocations: resolves relative path against cwd", () => {
  const result = toToolCallLocations({ path: "src/foo.ts" }, "/cwd");
  assert.ok(result);
  assert.equal(result![0]!.path, "/cwd/src/foo.ts");
});

test("toToolCallLocations: preserves absolute path", () => {
  const result = toToolCallLocations({ path: "/abs/path.ts" }, "/cwd");
  assert.ok(result);
  assert.equal(result![0]!.path, "/abs/path.ts");
});

test("toToolCallLocations: includes line when provided", () => {
  const result = toToolCallLocations({ path: "foo.ts" }, "/cwd", 42);
  assert.ok(result);
  assert.equal(result![0]!.line, 42);
});

test("buildArgsMap: extracts toolCall args from assistant messages", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "call_2", name: "read", arguments: { path: "src/index.ts" } },
      ],
    },
    { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [], isError: false },
    { role: "toolResult", toolCallId: "call_2", toolName: "read", content: [], isError: false },
  ];

  const map = buildArgsMap(messages);
  assert.deepEqual(map.get("call_1"), { command: "ls" });
  assert.deepEqual(map.get("call_2"), { path: "src/index.ts" });
  assert.equal(map.has("call_3"), false);
});

test("buildArgsMap: returns empty map when no assistant messages with toolCall", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ];
  const map = buildArgsMap(messages);
  assert.equal(map.size, 0);
});
