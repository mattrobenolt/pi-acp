import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { getPiAcpDir, getPiAcpSessionMapPath } from "../../src/acp/paths.js";

test("getPiAcpDir defaults to ~/.pi/pi-acp", () => {
  const prev = process.env.PI_ACP_DIR;
  delete process.env.PI_ACP_DIR;
  try {
    assert.equal(getPiAcpDir(), join(process.env.HOME ?? "", ".pi", "pi-acp"));
  } finally {
    if (prev == null) delete process.env.PI_ACP_DIR;
    else process.env.PI_ACP_DIR = prev;
  }
});

test("getPiAcpDir respects PI_ACP_DIR", () => {
  const prev = process.env.PI_ACP_DIR;
  process.env.PI_ACP_DIR = "relative-pi-acp-dir";
  try {
    assert.equal(getPiAcpDir(), resolve("relative-pi-acp-dir"));
    assert.equal(
      getPiAcpSessionMapPath(),
      join(resolve("relative-pi-acp-dir"), "session-map.json"),
    );
  } finally {
    if (prev == null) delete process.env.PI_ACP_DIR;
    else process.env.PI_ACP_DIR = prev;
  }
});
