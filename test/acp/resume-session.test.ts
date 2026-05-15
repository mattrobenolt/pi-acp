import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { negotiateCapabilities } from "../../src/acp/agent.js";

describe("session/resume capability", () => {
  it("negotiateCapabilities advertises resume", () => {
    const { agentCapabilities } = negotiateCapabilities(undefined);
    assert.ok(
      agentCapabilities.sessionCapabilities?.resume,
      "sessionCapabilities.resume should be advertised",
    );
  });

  it("resume capability is a plain object (satisfies SessionResumeCapabilities: {})", () => {
    const { agentCapabilities } = negotiateCapabilities(undefined);
    const resume = agentCapabilities.sessionCapabilities?.resume;
    assert.equal(typeof resume, "object");
    assert.notEqual(resume, null);
  });

  it("debug.negotiated reflects session resume", () => {
    const { debug } = negotiateCapabilities(undefined);
    const n = debug["negotiated"] as Record<string, unknown>;
    assert.equal(n["sessionResume"], true);
  });
});
