import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpSession } from "../../src/acp/session.js";
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from "../helpers/fakes.js";

test("PiAcpSession: concurrent prompts are sent to pi as steering", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  const first = session.prompt("one");
  const second = session.prompt("two");
  const third = session.prompt("three");

  assert.equal(proc.prompts.length, 3);
  assert.deepEqual(proc.prompts[1]!.opts, { streamingBehavior: "steer" });
  assert.deepEqual(proc.prompts[2]!.opts, { streamingBehavior: "steer" });

  assert.equal(await second, "end_turn");
  assert.equal(await third, "end_turn");

  await session.cancel();
  assert.equal(proc.abortCount, 1);

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  assert.equal(await first, "cancelled");
});
