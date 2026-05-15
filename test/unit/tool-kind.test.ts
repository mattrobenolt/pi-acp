import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpSession } from "../../src/acp/session.js";
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from "../helpers/fakes.js";

test("PiAcpSession: renders bash tools as execute kind", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "echo hi" },
  });

  await new Promise((r) => setTimeout(r, 0));

  const start = conn.updates.find(
    (u) => (u.update as any).toolCallId === "t1" && u.update.sessionUpdate === "tool_call",
  );
  assert.ok(start, "expected bash tool call");
  assert.equal((start.update as any).kind, "execute");
});

test("PiAcpSession: renders find tools as search without file navigation", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "find",
    args: { pattern: "*.json", path: ".", limit: 10 },
  });

  await new Promise((r) => setTimeout(r, 0));

  const start = conn.updates.find(
    (u) => (u.update as any).toolCallId === "t1" && u.update.sessionUpdate === "tool_call",
  );
  assert.ok(start, "expected find tool call");
  assert.equal((start.update as any).kind, "search");
  assert.equal((start.update as any).title, "Find `.` `*.json`");
  assert.equal((start.update as any).locations, undefined);
});

test("PiAcpSession: renders web tools with search/fetch kinds", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
  });

  proc.emit({
    type: "tool_execution_start",
    toolCallId: "search1",
    toolName: "websearch",
    args: { query: "agent client protocol" },
  });
  proc.emit({
    type: "tool_execution_start",
    toolCallId: "fetch1",
    toolName: "webfetch",
    args: { url: "https://agentclientprotocol.com" },
  });

  await new Promise((r) => setTimeout(r, 0));

  const search = conn.updates.find((u) => (u.update as any).toolCallId === "search1");
  assert.ok(search, "expected websearch tool call");
  assert.equal((search.update as any).kind, "fetch");
  assert.equal((search.update as any).title, '"agent client protocol"');

  const fetch = conn.updates.find((u) => (u.update as any).toolCallId === "fetch1");
  assert.ok(fetch, "expected webfetch tool call");
  assert.equal((fetch.update as any).kind, "fetch");
  assert.equal((fetch.update as any).title, "Fetch https://agentclientprotocol.com");
});
