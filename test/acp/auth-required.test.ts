import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RequestError } from "@agentclientprotocol/sdk";
import { mapPiRpcError, maybeAuthRequiredError } from "../../src/acp/auth-required.js";

describe("maybeAuthRequiredError", () => {
  it("returns null for non-auth errors", () => {
    assert.equal(maybeAuthRequiredError(null), null);
    assert.equal(maybeAuthRequiredError(undefined), null);
    assert.equal(maybeAuthRequiredError(new Error("model not found")), null);
  });

  for (const message of [
    "missing API key",
    "x-api-key header is invalid",
    "authentication_error",
    "not authenticated",
    "auth failed",
    "HTTP 401",
    "HTTP 403 forbidden",
  ]) {
    it(`maps ${message} to authRequired`, () => {
      const err = maybeAuthRequiredError(new Error(message));
      assert.ok(err instanceof RequestError);
      assert.match(err.message, /Configure an API key|OAuth provider/);
    });
  }
});

describe("mapPiRpcError", () => {
  it("preserves auth errors as authRequired", () => {
    const err = mapPiRpcError(new Error("not authenticated"));
    assert.ok(err instanceof RequestError);
    assert.match(err.message, /Configure an API key|OAuth provider/);
  });

  it("maps non-auth errors to internalError with context", () => {
    const err = mapPiRpcError(new Error("provider rejected model"), "Failed to set model");
    assert.ok(err instanceof RequestError);
    assert.match(err.message, /Failed to set model: provider rejected model/);
  });
});
