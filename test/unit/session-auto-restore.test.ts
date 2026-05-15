import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpAgent } from "../../src/acp/agent.js";
import { PiRpcProcess } from "../../src/pi-rpc/process.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

class FakeSessions {
  restored: any = null;
  maybeGet(_sessionId: string) {
    return undefined;
  }
  getOrCreate(sessionId: string, params: any) {
    this.restored = {
      sessionId,
      cwd: params.cwd,
      proc: params.proc,
      async prompt(message: string, _images: unknown[]) {
        this.message = message;
        return "end_turn";
      },
      wasCancelRequested() {
        return false;
      },
    };
    return this.restored;
  }
}

test("PiAcpAgent: prompt auto-restores a stored session", async () => {
  const realSpawn = PiRpcProcess.spawn;
  const sessions = new FakeSessions();
  const proc = {
    async setSessionName(_name: string) {},
  };
  const spawnCalls: any[] = [];

  (PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params);
    return proc;
  };

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any);
    (agent as any).sessions = sessions;
    (agent as any).store = {
      get(sessionId: string) {
        assert.equal(sessionId, "s1");
        return { sessionId, cwd: "/tmp/project", sessionFile: "/tmp/session.jsonl" };
      },
      upsert(entry: any) {
        assert.deepEqual(entry, {
          sessionId: "s1",
          cwd: "/tmp/project",
          sessionFile: "/tmp/session.jsonl",
        });
      },
    };

    const res = await agent.prompt({
      sessionId: "s1",
      prompt: [{ type: "text", text: "continue" }],
    } as any);

    assert.deepEqual(res, { stopReason: "end_turn" });
    assert.deepEqual(spawnCalls, [
      {
        cwd: "/tmp/project",
        sessionPath: "/tmp/session.jsonl",
        piCommand: undefined,
      },
    ]);
    assert.equal(sessions.restored.message, "continue");
  } finally {
    (PiRpcProcess as any).spawn = realSpawn;
  }
});
