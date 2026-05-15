import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAcpAgent, negotiateCapabilities } from "../../src/acp/agent.js";
import { SessionStore } from "../../src/acp/session-store.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

test("negotiateCapabilities advertises additionalDirectories support", () => {
  const { agentCapabilities } = negotiateCapabilities(undefined);
  assert.deepEqual(agentCapabilities.sessionCapabilities?.additionalDirectories, {});
});

test("SessionStore preserves additionalDirectories", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-store-"));
  const store = new SessionStore(join(root, "session-map.json"));

  store.upsert({
    sessionId: "sess-1",
    cwd: "/tmp/project",
    sessionFile: "/tmp/session.jsonl",
    additionalDirectories: ["/tmp/extra"],
  });

  assert.deepEqual(store.get("sess-1")?.additionalDirectories, ["/tmp/extra"]);
  assert.deepEqual(store.list()[0]?.additionalDirectories, ["/tmp/extra"]);
});

test("PiAcpAgent rejects relative additionalDirectories", async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()));

  await assert.rejects(
    () =>
      agent.newSession({
        cwd: "/tmp/project",
        mcpServers: [],
        additionalDirectories: ["relative/path"],
      } as any),
    { name: "RequestError" },
  );
});
