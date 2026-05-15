import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from "../helpers/fakes.js";

class FakeSessions {
  constructor(private readonly session: any) {}
  get(_id: string) {
    return this.session;
  }
}

function makeAgent(proc: FakePiRpcProcess) {
  const conn = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(conn));
  (agent as any).sessions = new FakeSessions({ sessionId: "s1", proc }) as any;
  return { conn, agent };
}

test("setSessionConfigOption: auto_compaction (boolean true)", async () => {
  const proc = new FakePiRpcProcess() as any;
  let capturedEnabled: boolean | null = null;
  proc.setAutoCompaction = async (v: boolean) => {
    capturedEnabled = v;
  };
  proc.getState = async () => ({
    autoCompactionEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
  });

  const { conn, agent } = makeAgent(proc);

  const res = await agent.setSessionConfigOption({
    sessionId: "s1",
    configId: "auto_compaction",
    type: "boolean",
    value: true,
  } as any);

  assert.equal(capturedEnabled, true);
  assert.equal(res.configOptions.length, 3);
  const ac = res.configOptions.find((o) => o.id === "auto_compaction")!;
  assert.equal((ac as any).currentValue, true);

  const update = conn.updates.find(
    (u) => (u as any).update?.sessionUpdate === "config_option_update",
  );
  assert.ok(update, "should emit config_option_update");
});

test("setSessionConfigOption: steering_mode", async () => {
  const proc = new FakePiRpcProcess() as any;
  let capturedMode: string | null = null;
  proc.setSteeringMode = async (m: string) => {
    capturedMode = m;
  };
  proc.getState = async () => ({
    autoCompactionEnabled: true,
    steeringMode: "one-at-a-time",
    followUpMode: "all",
  });

  const { conn, agent } = makeAgent(proc);

  const res = await agent.setSessionConfigOption({
    sessionId: "s1",
    configId: "steering_mode",
    value: "one-at-a-time",
  } as any);

  assert.equal(capturedMode, "one-at-a-time");
  const sm = res.configOptions.find((o) => o.id === "steering_mode")!;
  assert.equal((sm as any).currentValue, "one-at-a-time");

  const update = conn.updates.find(
    (u) => (u as any).update?.sessionUpdate === "config_option_update",
  );
  assert.ok(update, "should emit config_option_update");
});

test("setSessionConfigOption: follow_up_mode", async () => {
  const proc = new FakePiRpcProcess() as any;
  let capturedMode: string | null = null;
  proc.setFollowUpMode = async (m: string) => {
    capturedMode = m;
  };
  proc.getState = async () => ({
    autoCompactionEnabled: true,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
  });

  const { agent } = makeAgent(proc);

  const res = await agent.setSessionConfigOption({
    sessionId: "s1",
    configId: "follow_up_mode",
    value: "one-at-a-time",
  } as any);

  assert.equal(capturedMode, "one-at-a-time");
  const fm = res.configOptions.find((o) => o.id === "follow_up_mode")!;
  assert.equal((fm as any).currentValue, "one-at-a-time");
});

test("setSessionConfigOption: rejects unknown configId", async () => {
  const proc = new FakePiRpcProcess() as any;
  const { agent } = makeAgent(proc);

  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: "s1", configId: "nope", value: "x" } as any),
    /invalid params/i,
  );
});

test("setSessionConfigOption: rejects invalid steering_mode value", async () => {
  const proc = new FakePiRpcProcess() as any;
  const { agent } = makeAgent(proc);

  await assert.rejects(
    () =>
      agent.setSessionConfigOption({
        sessionId: "s1",
        configId: "steering_mode",
        value: "bad",
      } as any),
    /invalid params/i,
  );
});
