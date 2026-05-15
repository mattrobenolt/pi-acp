/**
 * Documents the decision NOT to emit ACP `plan` session updates from pi tool events.
 *
 * Pi has no todo/planning tool. Its built-in tools are bash, read, write, and edit.
 * None of them carry structured task-list state that could be translated to ACP PlanEntry[].
 *
 * If pi gains a todo tool in a future release, the mapping would be:
 *   tool_execution_end where toolName === "todo_write" (or equivalent)
 *     → parse args.todos[] → map to PlanEntry[]
 *     → emit { sessionUpdate: "plan", entries: [...] }
 *
 * Until that surface exists, plan updates are not emitted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { toToolKind } from "../../src/acp/translate/pi-tools.js";

test("toToolKind: known pi built-in tools do not map to a plan-triggering kind", () => {
  // pi built-ins: bash, read, write, edit — none of these carry plan/todo state
  assert.equal(toToolKind("bash"), "execute");
  assert.equal(toToolKind("read"), "read");
  assert.equal(toToolKind("write"), "edit");
  assert.equal(toToolKind("edit"), "edit");
});

test("toToolKind: hypothetical todo tool names fall through to other", () => {
  // Pi does not have these tools. If it did, the mapping would need explicit handling
  // before plan updates could be emitted. "other" here means: no plan update path.
  assert.equal(toToolKind("todo_write"), "other");
  assert.equal(toToolKind("todo_read"), "other");
  assert.equal(toToolKind("TodoWrite"), "other");
  assert.equal(toToolKind("create_plan"), "other");
});
