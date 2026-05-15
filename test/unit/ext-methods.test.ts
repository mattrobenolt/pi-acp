import test from "node:test";
import assert from "node:assert/strict";

import { PiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

test("PiAcpAgent: pi-acp/session reports session diagnostics", async () => {
  const conn = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(conn));

  (agent as any).sessions.getOrCreate("sess-1", {
    cwd: "/tmp/project",
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: { onEvent: () => () => {} },
    fileCommands: [],
  });
  (agent as any).sessionAdditionalDirectories.set("sess-1", ["/tmp/extra"]);

  const result = await agent.extMethod("pi-acp/session", { sessionId: "sess-1" });

  assert.equal(result.sessionId, "sess-1");
  assert.equal(result.cwd, "/tmp/project");
  assert.deepEqual(result.additionalDirectories, ["/tmp/extra"]);
});

test("PiAcpAgent: pi-acp/state returns live pi state", async () => {
  const conn = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(conn));

  (agent as any).sessions.getOrCreate("sess-1", {
    cwd: "/tmp/project",
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: {
      onEvent: () => () => {},
      getState: async () => ({ sessionId: "sess-1", model: { id: "m" } }),
    },
    fileCommands: [],
  });

  const result = await agent.extMethod("pi-acp/state", { sessionId: "sess-1" });

  assert.deepEqual(result.state, { sessionId: "sess-1", model: { id: "m" } });
});

test("PiAcpAgent: unsupported pi-acp ext method is invalid params", async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()));

  await assert.rejects(() => agent.extMethod("pi-acp/nope", {}), { name: "RequestError" });
});
