import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session;
  }
  closeAllExcept() {}
}

test("PiAcpAgent: PI_ACP_SKIP_PI_AUTH allows startup with zero discovered models", async () => {
  const prev = process.env.PI_ACP_SKIP_PI_AUTH;
  process.env.PI_ACP_SKIP_PI_AUTH = "1";
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = () => 0 as any;

  try {
    const session = {
      sessionId: "s1",
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [] };
        },
        async getState() {
          return { thinkingLevel: "medium" };
        },
        async getCommands() {
          return { commands: [] };
        },
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {},
    };

    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any);
    (agent as any).sessions = new FakeSessions(session) as any;

    const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any);
    assert.equal(res.sessionId, "s1");
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
    if (prev == null) delete process.env.PI_ACP_SKIP_PI_AUTH;
    else process.env.PI_ACP_SKIP_PI_AUTH = prev;
  }
});
