import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

class FakeSessions {
  closed: string[] = [];
  constructor(private readonly session: any) {}
  get(sessionId: string) {
    assert.equal(sessionId, this.session.sessionId);
    return this.session;
  }
  close(sessionId: string) {
    this.closed.push(sessionId);
  }
}

test("PiAcpAgent: prompt emits an initial session title", async () => {
  const conn = new FakeAgentSideConnection();
  let sessionName = "";
  const session = {
    sessionId: "s1",
    proc: {
      async setSessionName(name: string) {
        sessionName = name;
      },
    },
    async prompt(_message: string, _images: unknown[]) {
      return "end_turn";
    },
    wasCancelRequested() {
      return false;
    },
  };

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any);
  (agent as any).sessions = new FakeSessions(session) as any;

  await agent.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "Fix the frobnicator\n\nplease" }],
  } as any);

  assert.equal(sessionName, "Fix the frobnicator");
  const titleUpdate = conn.updates.find((u) => u.update.sessionUpdate === "session_info_update");
  assert.ok(titleUpdate);
  assert.equal((titleUpdate.update as any).title, "Fix the frobnicator");
});

test("PiAcpAgent: closeSession cancels and releases the session", async () => {
  let cancelled = false;
  const session = {
    sessionId: "s1",
    async cancel() {
      cancelled = true;
    },
  };

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any);
  const sessions = new FakeSessions(session);
  (agent as any).sessions = sessions as any;

  assert.deepEqual(await agent.closeSession({ sessionId: "s1" } as any), {});
  assert.equal(cancelled, true);
  assert.deepEqual(sessions.closed, ["s1"]);
});
