import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

class FakeSessions {
  constructor(private readonly session: unknown) {}
  async create(_params: unknown) {
    return this.session;
  }
  closeAllExcept() {}
}

async function newSessionAndGetModes(thinkingLevel: string) {
  const conn = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(conn), {} as never);

  const session = {
    sessionId: "s1",
    cwd: "/tmp",
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: "test", id: "model", name: "model" }] };
      },
      async getState() {
        return { thinkingLevel, model: { provider: "test", id: "model" } };
      },
    },
    setStartupInfo(_text: string) {},
    sendStartupInfoIfPending() {},
  };

  (agent as never as { sessions: unknown }).sessions = new FakeSessions(session);
  process.env.PI_ACP_SKIP_PI_AUTH = "1";

  try {
    const response = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    return (
      response as never as {
        modes: {
          availableModes: Array<{ id: string; name: string; description?: string | null }>;
          currentModeId: string;
        };
      }
    ).modes;
  } finally {
    delete process.env.PI_ACP_SKIP_PI_AUTH;
  }
}

test("thinking mode labels: all six levels have human-readable names", async () => {
  const modes = await newSessionAndGetModes("medium");

  const names = Object.fromEntries(modes.availableModes.map((m) => [m.id, m.name]));
  assert.equal(names["off"], "No thinking");
  assert.equal(names["minimal"], "Minimal thinking");
  assert.equal(names["low"], "Low thinking");
  assert.equal(names["medium"], "Medium thinking");
  assert.equal(names["high"], "High thinking");
  assert.equal(names["xhigh"], "Extended thinking");
});

test("thinking mode labels: all six levels have non-null descriptions", async () => {
  const modes = await newSessionAndGetModes("medium");

  for (const m of modes.availableModes) {
    assert.ok(
      typeof m.description === "string" && m.description.length > 0,
      `mode ${m.id} should have a non-empty description`,
    );
  }
});

test("thinking mode labels: names do not contain raw level ids like 'Thinking: off'", async () => {
  const modes = await newSessionAndGetModes("off");

  for (const m of modes.availableModes) {
    assert.doesNotMatch(
      m.name,
      /^Thinking: /,
      `mode ${m.id} name should not use old 'Thinking: X' pattern`,
    );
  }
});

test("thinking mode labels: currentModeId reflects pi state", async () => {
  const modes = await newSessionAndGetModes("high");
  assert.equal(modes.currentModeId, "high");
});
