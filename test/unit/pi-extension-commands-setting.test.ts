import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEnableExtensionCommands } from "../../src/acp/pi-settings.js";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS;
  if (value == null) delete process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS;
  else process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS = value;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS;
    else process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS = prev;
  }
}

test("getEnableExtensionCommands defaults to true", () => {
  withEnv(undefined, () => {
    assert.equal(getEnableExtensionCommands(process.cwd()), true);
  });
});

test("getEnableExtensionCommands honors env override", () => {
  withEnv("0", () => {
    assert.equal(getEnableExtensionCommands(process.cwd()), false);
  });
  withEnv("true", () => {
    assert.equal(getEnableExtensionCommands(process.cwd()), true);
  });
});

test("getEnableExtensionCommands honors project settings", () => {
  withEnv(undefined, () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-acp-extension-commands-"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ enableExtensionCommands: false }),
      "utf-8",
    );
    assert.equal(getEnableExtensionCommands(cwd), false);
  });
});
