import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session;
  }
}

test("PiAcpAgent: startup info includes project packages without fake npm entrypoints", async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-agent-dir-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-acp-project-"));
  mkdirSync(join(cwd, ".pi"));

  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:@global/pkg"] }),
    "utf-8",
  );
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ packages: ["npm:@project/pkg"] }),
    "utf-8",
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = () => 0 as any;

  try {
    let startupInfo = "";
    const session = {
      sessionId: "s1",
      cwd,
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: "test", id: "model", name: "model" }] };
        },
        async getState() {
          return { thinkingLevel: "medium", model: { provider: "test", id: "model" } };
        },
      },
      setStartupInfo(text: string) {
        startupInfo = text;
      },
      sendStartupInfoIfPending() {},
    };

    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any);
    (agent as any).sessions = new FakeSessions(session) as any;

    await agent.newSession({ cwd, mcpServers: [] } as any);

    assert.match(startupInfo, /npm:@global\/pkg/);
    assert.match(startupInfo, /npm:@project\/pkg/);
    assert.doesNotMatch(startupInfo, /index\.ts/);
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});
