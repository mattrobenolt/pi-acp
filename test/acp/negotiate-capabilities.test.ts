import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { negotiateCapabilities } from "../../src/acp/agent.js";

describe("negotiateCapabilities", () => {
  it("returns correct agent capabilities when called with no client caps", () => {
    const { agentCapabilities } = negotiateCapabilities(undefined);

    assert.equal(agentCapabilities.loadSession, true);
    assert.deepEqual(agentCapabilities.mcpCapabilities, { http: false, sse: false });
    assert.equal(agentCapabilities.promptCapabilities?.image, true);
    assert.equal(agentCapabilities.promptCapabilities?.audio, false);
    assert.ok(agentCapabilities.sessionCapabilities?.close);
    assert.ok(agentCapabilities.sessionCapabilities?.list);

    // Conservative: do not claim features we haven't implemented.
    assert.equal(agentCapabilities.nes ?? null, null);
    assert.equal(agentCapabilities.providers ?? null, null);
    assert.equal((agentCapabilities.auth as any) ?? null, null);
  });

  it("debug.clientAdvertised reflects what the client sent", () => {
    const { debug } = negotiateCapabilities({
      terminal: true,
      fs: { readTextFile: true, writeTextFile: false },
    });

    const ca = debug["clientAdvertised"] as Record<string, unknown>;
    assert.equal(ca["terminal"], true);
    assert.equal(ca["fs"], true);
    assert.equal(ca["nes"], false);
  });

  it("debug.clientAdvertised is all-false when client sends empty caps", () => {
    const { debug } = negotiateCapabilities({});

    const ca = debug["clientAdvertised"] as Record<string, unknown>;
    assert.equal(ca["terminal"], false);
    assert.equal(ca["fs"], false);
    assert.equal(ca["nes"], false);
    assert.equal(ca["elicitation"], false);
    assert.equal(ca["auth"], false);
  });

  it("debug.negotiated reflects embeddedContext env var (false by default)", () => {
    delete process.env["PI_ACP_ENABLE_EMBEDDED_CONTEXT"];
    const { debug } = negotiateCapabilities(undefined);
    const n = debug["negotiated"] as Record<string, unknown>;
    assert.equal(n["embeddedContext"], false);
  });

  it("embeddedContext is true when env var is set", () => {
    process.env["PI_ACP_ENABLE_EMBEDDED_CONTEXT"] = "true";
    try {
      const { agentCapabilities, debug } = negotiateCapabilities(undefined);
      assert.equal(agentCapabilities.promptCapabilities?.embeddedContext, true);
      const n = debug["negotiated"] as Record<string, unknown>;
      assert.equal(n["embeddedContext"], true);
    } finally {
      delete process.env["PI_ACP_ENABLE_EMBEDDED_CONTEXT"];
    }
  });
});
