import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, getConfiguredPackages } from "../../src/acp/pi-settings.js";

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

function withProfileEnv<T>(fn: (baseDir: string) => T): T {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevAcpProfile = process.env.PI_ACP_PROFILE;
  const prevBaseDir = process.env.PI_PROFILE_BASE_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-acp-profile-"));
  const baseDir = join(root, "agent");
  mkdirSync(baseDir);

  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_ACP_PROFILE;
  process.env.PI_PROFILE_BASE_DIR = baseDir;

  try {
    return fn(baseDir);
  } finally {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevAcpProfile == null) delete process.env.PI_ACP_PROFILE;
    else process.env.PI_ACP_PROFILE = prevAcpProfile;
    if (prevBaseDir == null) delete process.env.PI_PROFILE_BASE_DIR;
    else process.env.PI_PROFILE_BASE_DIR = prevBaseDir;
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

test("getAgentDir honors explicit PI_CODING_AGENT_DIR", () => {
  withProfileEnv((baseDir) => {
    process.env.PI_CODING_AGENT_DIR = join(baseDir, "explicit");
    assert.equal(getAgentDir(), join(baseDir, "explicit"));
  });
});

test("getAgentDir resolves configured default profile", () => {
  withProfileEnv((baseDir) => {
    writeFileSync(
      join(baseDir, "..", "pi-profile.json"),
      JSON.stringify({ defaultProfile: "work" }),
    );
    assert.equal(getAgentDir(), join(baseDir, "..", "agent-work"));
  });
});

test("getAgentDir honors PI_ACP_PROFILE overrides", () => {
  withProfileEnv((baseDir) => {
    writeFileSync(
      join(baseDir, "..", "pi-profile.json"),
      JSON.stringify({ defaultProfile: "work" }),
    );

    process.env.PI_ACP_PROFILE = "personal";
    assert.equal(getAgentDir(), join(baseDir, "..", "agent-personal"));

    process.env.PI_ACP_PROFILE = "base";
    assert.equal(getAgentDir(), baseDir);
  });
});
