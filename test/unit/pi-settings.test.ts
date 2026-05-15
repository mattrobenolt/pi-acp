import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfiguredPackages } from "../../src/acp/pi-settings.js";

function withAgentDir<T>(fn: (agentDir: string) => T): T {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-settings-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return fn(agentDir);
  } finally {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
}

test("getConfiguredPackages includes global and project packages", () => {
  withAgentDir((agentDir) => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-acp-project-"));
    mkdirSync(join(cwd, ".pi"));

    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:@global/one", "npm:@shared/pkg"] }),
      "utf-8",
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: ["npm:@project/two", "npm:@shared/pkg"] }),
      "utf-8",
    );

    assert.deepEqual(getConfiguredPackages(cwd), [
      "npm:@global/one",
      "npm:@shared/pkg",
      "npm:@project/two",
    ]);
  });
});
