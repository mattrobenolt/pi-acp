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

test("PiAcpAgent: newSession filters advertised models using enabledModels", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-enabled-models-"));
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      quietStartup: true,
      enabledModels: ["anthropic/claude-sonnet-4-6", "openai-codex/gpt-5.*"],
    }),
    "utf-8",
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = () => 0 as any;

  try {
    const session = {
      sessionId: "s1",
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return {
            models: [
              { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
              { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
              { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
              { provider: "llamacpp", id: "qwen3-8b-balanced", name: "Qwen" },
            ],
          };
        },
        async getState() {
          return {
            thinkingLevel: "medium",
            model: { provider: "anthropic", id: "claude-sonnet-4-6" },
          };
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
    assert.deepEqual(
      res.models?.availableModels.map((model: any) => model.modelId),
      ["anthropic/claude-sonnet-4-6", "openai-codex/gpt-5.5"],
    );
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});
