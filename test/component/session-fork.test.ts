import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAcpAgent, negotiateCapabilities } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";
import { PiRpcProcess } from "../../src/pi-rpc/process.js";
import { SessionStore } from "../../src/acp/session-store.js";

function makeFakeProc() {
  return {
    onEvent: () => () => {},
    getMessages: async () => ({ messages: [] }),
    getAvailableModels: async () => ({ models: [{ provider: "test", id: "m", name: "m" }] }),
    getState: async () => ({ thinkingLevel: "off" }),
    getCommands: async () => ({ commands: [] }),
  } as any;
}

test("negotiateCapabilities advertises session fork capability", () => {
  const { agentCapabilities } = negotiateCapabilities(undefined);
  assert.ok(
    agentCapabilities.sessionCapabilities?.fork,
    "sessionCapabilities.fork should be advertised",
  );
});

test("PiAcpAgent: unstable_forkSession creates independent session from source", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-fork-test-"));
  const sessionsDir = join(root, "sessions", "project");
  mkdirSync(sessionsDir, { recursive: true });

  const sourceSessionId = "source-session-id-1234";
  const sessionFile = join(sessionsDir, "source.jsonl");

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sourceSessionId,
        cwd: "/tmp/project",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        role: "user",
        message: { role: "user", content: "Hello from source" },
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    ].join("\n") + "\n",
    { encoding: "utf8" },
  );

  const storeDir = mkdtempSync(join(tmpdir(), "pi-acp-store-"));
  const oldPiDir = process.env.PI_CODING_AGENT_DIR;
  const oldAcpDir = process.env.PI_ACP_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_ACP_DIR = storeDir;

  const originalSpawn = PiRpcProcess.spawn;
  const spawnedPaths: string[] = [];

  (PiRpcProcess as any).spawn = async (params: any) => {
    spawnedPaths.push(params.sessionPath);
    return makeFakeProc();
  };

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new PiAcpAgent(asAgentConn(conn));

    // Register the source session in the store so forkSession can find it.
    const store = new SessionStore(join(storeDir, "session-map.json"));
    store.upsert({
      sessionId: sourceSessionId,
      cwd: "/tmp/project",
      sessionFile,
    });

    const result = await agent.unstable_forkSession({
      sessionId: sourceSessionId,
      cwd: "/tmp/project",
      _meta: null,
    } as any);

    // 1) Should return a new session ID distinct from the source.
    assert.ok(typeof result.sessionId === "string", "should return a sessionId");
    assert.notEqual(result.sessionId, sourceSessionId, "fork sessionId must differ from source");

    // 2) pi was spawned with a new session file (not the original).
    assert.equal(spawnedPaths.length, 1);
    assert.notEqual(spawnedPaths[0], sessionFile, "fork should spawn with a new file path");

    // 3) The forked file exists.
    assert.ok(existsSync(spawnedPaths[0]), "forked session file should exist");

    // 4) The forked file has the new session ID in its header, not the source ID.
    const forkedRaw = readFileSync(spawnedPaths[0], "utf-8");
    const firstLine = forkedRaw.split("\n")[0];
    const header = JSON.parse(firstLine) as Record<string, unknown>;
    assert.equal(header["id"], result.sessionId, "forked file header should have new session ID");
    assert.notEqual(header["id"], sourceSessionId, "forked file must not reuse source session ID");

    // 5) Forked file should preserve the history lines from the source.
    const lines = forkedRaw.split("\n").filter((l) => l.trim());
    assert.ok(lines.length >= 2, "forked file should include source history");

    // 6) Store should know about the new session.
    const stored = store.get(result.sessionId);
    assert.ok(stored, "new session should be in the store");
    assert.equal(stored?.sessionFile, spawnedPaths[0]);

    // 7) session_info_update should have been emitted for the new sessionId.
    const infoUpdates = conn.updates.filter(
      (u) =>
        (u as any).sessionId === result.sessionId &&
        (u as any).update?.sessionUpdate === "session_info_update",
    );
    assert.ok(infoUpdates.length >= 1, "should emit session_info_update for new session");
  } finally {
    PiRpcProcess.spawn = originalSpawn;
    if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldPiDir;
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR;
    else process.env.PI_ACP_DIR = oldAcpDir;
  }
});

test("PiAcpAgent: unstable_forkSession rejects unknown source sessionId", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-fork-unknown-"));
  const storeDir = mkdtempSync(join(tmpdir(), "pi-acp-store-"));
  const oldPiDir = process.env.PI_CODING_AGENT_DIR;
  const oldAcpDir = process.env.PI_ACP_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_ACP_DIR = storeDir;

  // Ensure sessions dir exists but is empty.
  mkdirSync(join(root, "sessions"), { recursive: true });

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new PiAcpAgent(asAgentConn(conn));

    await assert.rejects(
      () =>
        agent.unstable_forkSession({
          sessionId: "does-not-exist",
          cwd: "/tmp/project",
          _meta: null,
        } as any),
      (err: any) => {
        assert.ok(
          err?.message === "Invalid params" || err?.message?.includes("Unknown sessionId"),
          `expected invalidParams error, got: ${String(err?.message)}`,
        );
        return true;
      },
    );
  } finally {
    if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldPiDir;
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR;
    else process.env.PI_ACP_DIR = oldAcpDir;
  }
});

test("PiAcpAgent: unstable_forkSession rejects relative cwd", async () => {
  const conn = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(conn));

  await assert.rejects(
    () =>
      agent.unstable_forkSession({
        sessionId: "any-id",
        cwd: "relative/path",
        _meta: null,
      } as any),
    (err: any) => {
      assert.ok(
        err?.message === "Invalid params" || err?.message?.includes("absolute"),
        `expected absolute path error, got: ${String(err?.message)}`,
      );
      return true;
    },
  );
});

test("PiAcpAgent: unstable_forkSession preserves cwd in forked header", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-fork-cwd-"));
  const sessionsDir = join(root, "sessions", "p");
  mkdirSync(sessionsDir, { recursive: true });

  const sourceId = "cwd-test-source";
  const sessionFile = join(sessionsDir, "cwd-source.jsonl");

  writeFileSync(
    sessionFile,
    JSON.stringify({ type: "session", id: sourceId, cwd: "/old/cwd" }) + "\n",
    { encoding: "utf8" },
  );

  const storeDir = mkdtempSync(join(tmpdir(), "pi-acp-store-cwd-"));
  const oldPiDir = process.env.PI_CODING_AGENT_DIR;
  const oldAcpDir = process.env.PI_ACP_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_ACP_DIR = storeDir;

  const originalSpawn = PiRpcProcess.spawn;
  let capturedPath = "";

  (PiRpcProcess as any).spawn = async (params: any) => {
    capturedPath = params.sessionPath;
    return makeFakeProc();
  };

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new PiAcpAgent(asAgentConn(conn));

    const store = new SessionStore(join(storeDir, "session-map.json"));
    store.upsert({ sessionId: sourceId, cwd: "/old/cwd", sessionFile });

    const result = await agent.unstable_forkSession({
      sessionId: sourceId,
      cwd: "/new/cwd",
      _meta: null,
    } as any);

    const forkedRaw = readFileSync(capturedPath, "utf-8");
    const header = JSON.parse(forkedRaw.split("\n")[0]) as Record<string, unknown>;

    // Fork should use the requested cwd, not the source's old cwd.
    assert.equal(header["cwd"], "/new/cwd");
    assert.equal(result.sessionId, header["id"]);
  } finally {
    PiRpcProcess.spawn = originalSpawn;
    if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldPiDir;
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR;
    else process.env.PI_ACP_DIR = oldAcpDir;
  }
});
