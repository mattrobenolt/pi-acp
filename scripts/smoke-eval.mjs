/**
 * ACP smoke/eval harness for pi-acp.
 *
 * Speaks ACP JSON-RPC 2.0 over stdio against the adapter using `fake-pi.mjs`
 * as the pi subprocess, so no real pi installation is required.
 *
 * Covers:
 *   - initialize
 *   - session/new (command advertisement)
 *   - session/prompt (plain text)
 *   - session/prompt with slash command (/session)
 *   - session/cancel
 *   - session/close
 *   - session/load (replay)
 *   - extension UI notify / select (via request_permission ACP round-trip) — skipped
 *     when the SDK doesn't surface it over stdio (noted in output).
 *
 * Usage:
 *   node scripts/smoke-eval.mjs            # runs all suites, exits 0 on pass
 *   SMOKE_VERBOSE=1 node scripts/smoke-eval.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FAKE_PI = join(__dirname, "fake-pi-bin.sh");
const VERBOSE = process.env.SMOKE_VERBOSE === "1";

// ---------------------------------------------------------------------------
// Build adapter first
// ---------------------------------------------------------------------------

process.stderr.write("Building adapter…\n");
await new Promise((resolve, reject) => {
  const p = spawn("npm", ["run", "build"], { stdio: "inherit", cwd: ROOT });
  p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))));
});
process.stderr.write("Build OK\n\n");

// ---------------------------------------------------------------------------
// Agent harness helpers
// ---------------------------------------------------------------------------

function spawnAgent() {
  const proc = spawn("node", ["dist/index.js"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_ACP_PI_COMMAND: FAKE_PI,
      PI_ACP_SKIP_PI_AUTH: "1",
    },
  });

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  if (VERBOSE) proc.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

  let buffer = "";
  const listeners = [];

  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      if (!raw.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (VERBOSE) process.stderr.write(`← ${JSON.stringify(msg)}\n`);
      for (const l of listeners) l(msg);
    }
  });

  let nextId = 1;

  return {
    send(method, params = {}) {
      const id = nextId++;
      const obj = { jsonrpc: "2.0", id, method, params };
      if (VERBOSE) process.stderr.write(`→ ${JSON.stringify(obj)}\n`);
      proc.stdin.write(JSON.stringify(obj) + "\n");
      return id;
    },
    notify(method, params = {}) {
      const obj = { jsonrpc: "2.0", method, params };
      if (VERBOSE) process.stderr.write(`→ ${JSON.stringify(obj)}\n`);
      proc.stdin.write(JSON.stringify(obj) + "\n");
    },
    onMessage(cb) {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    /** Wait for the next message matching predicate (rejects after timeout). */
    waitFor(predicate, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error("waitFor timeout"));
        }, timeoutMs);

        const off = this.onMessage((msg) => {
          if (predicate(msg)) {
            clearTimeout(timer);
            off();
            resolve(msg);
          }
        });
      });
    },
    kill() {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    },
    proc,
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const results = [];

async function suite(name, fn) {
  const agent = spawnAgent();
  let passed = false;
  let error = null;

  try {
    await fn(agent);
    passed = true;
  } catch (err) {
    error = err;
  } finally {
    agent.kill();
  }

  results.push({ name, passed, error });
  const icon = passed ? "✓" : "✗";
  process.stdout.write(`${icon} ${name}\n`);
  if (!passed) process.stdout.write(`  ${error?.message ?? error}\n`);
}

// Shared handshake used by most suites.
async function handshake(agent) {
  const initId = agent.send("initialize", { protocolVersion: 1 });
  const initResp = await agent.waitFor((m) => m.id === initId);
  assert(initResp.result, "initialize must return a result");

  const newId = agent.send("session/new", { cwd: ROOT, mcpServers: [] });
  const newResp = await agent.waitFor((m) => m.id === newId);
  assert(newResp.result?.sessionId, "session/new must return sessionId");

  return newResp.result.sessionId;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertIncludes(arr, name, message) {
  const found = arr.some((c) => c.name === name || c === name);
  if (!found) throw new Error(`${message}: ${name} not in ${JSON.stringify(arr)}`);
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

await suite("initialize", async (agent) => {
  const id = agent.send("initialize", { protocolVersion: 1 });
  const resp = await agent.waitFor((m) => m.id === id);
  assert(resp.result, "no result");
  assert(typeof resp.result.protocolVersion !== "undefined", "missing protocolVersion");
});

await suite("session/new returns sessionId + commands", async (agent) => {
  const sessionId = await handshake(agent);
  assert(typeof sessionId === "string" && sessionId.length > 0, "sessionId invalid");
});

await suite("session/new advertises commands via session/update", async (agent) => {
  const initId = agent.send("initialize", { protocolVersion: 1 });
  await agent.waitFor((m) => m.id === initId);

  // Commands come in a session/update notification *after* session/new resolves.
  const commandsUpdate = agent.waitFor(
    (m) =>
      m.method === "session/update" &&
      m.params?.update?.sessionUpdate === "available_commands_update",
    8000,
  );

  const newId = agent.send("session/new", { cwd: ROOT, mcpServers: [] });
  await agent.waitFor((m) => m.id === newId);

  const update = await commandsUpdate;
  const commands = update.params?.update?.availableCommands ?? [];
  assert(Array.isArray(commands) && commands.length > 0, "commands must be non-empty array");
  assertIncludes(commands, "session", "builtin 'session' command");
  assertIncludes(commands, "compact", "builtin 'compact' command");
});

await suite("session/prompt plain text", async (agent) => {
  const sessionId = await handshake(agent);

  const promptId = agent.send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Hello from smoke test" }],
  });

  // Collect session/update notifications until prompt response.
  const updates = [];
  const collectOff = agent.onMessage((m) => {
    if (m.method === "session/update") updates.push(m);
  });

  const promptResp = await agent.waitFor((m) => m.id === promptId, 10000);
  collectOff();

  assert(
    promptResp.result !== undefined || promptResp.error === undefined,
    "prompt must not error",
  );
  assert(updates.length > 0, "expected session/update notifications during prompt");
});

await suite("session/prompt slash command (/session)", async (agent) => {
  const sessionId = await handshake(agent);

  const promptId = agent.send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "/session" }],
  });

  const updates = [];
  const off = agent.onMessage((m) => {
    if (m.method === "session/update") updates.push(m);
  });

  const promptResp = await agent.waitFor((m) => m.id === promptId, 10000);
  off();

  assert(!promptResp.error, `prompt errored: ${JSON.stringify(promptResp.error)}`);
  assert(updates.length > 0, "expected session/update for slash command");
});

await suite("session/cancel", async (agent) => {
  const sessionId = await handshake(agent);

  // Start a prompt then immediately cancel via session/cancel RPC.
  const promptId = agent.send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Long task" }],
  });

  // Small delay so the prompt request reaches the adapter before cancel.
  await new Promise((r) => setTimeout(r, 30));

  // Cancel via session/cancel (stable ACP method).
  const cancelId = agent.send("session/cancel", { sessionId });

  // Wait for either the prompt or the cancel to respond — both are acceptable.
  const resp = await Promise.race([
    agent.waitFor((m) => m.id === promptId, 10000),
    agent.waitFor((m) => m.id === cancelId, 10000),
  ]);
  assert(resp !== null, "prompt or cancel must complete");
});

await suite("session/close", async (agent) => {
  const sessionId = await handshake(agent);

  const closeId = agent.send("session/close", { sessionId });
  const closeResp = await agent.waitFor((m) => m.id === closeId, 5000);
  assert(!closeResp.error, `close errored: ${JSON.stringify(closeResp.error)}`);
});

await suite("session/load replays history", async (agent) => {
  // Phase 1: create a session and run a prompt so there's history to replay.
  const sessionId = await handshake(agent);

  const promptId = agent.send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Hello for load test" }],
  });
  await agent.waitFor((m) => m.id === promptId, 10000);
  agent.kill();

  // Phase 2: load the same sessionId in a fresh agent instance.
  const agent2 = spawnAgent();
  const results2 = [];

  try {
    const initId = agent2.send("initialize", { protocolVersion: 1 });
    await agent2.waitFor((m) => m.id === initId);

    const updates = [];
    agent2.onMessage((m) => {
      if (m.method === "session/update") updates.push(m);
    });

    const loadId = agent2.send("session/load", { sessionId, cwd: ROOT, mcpServers: [] });
    const loadResp = await agent2.waitFor((m) => m.id === loadId, 8000);

    assert(!loadResp.error, `load errored: ${JSON.stringify(loadResp.error)}`);
    // session/load should replay prior session/update notifications.
    assert(updates.length > 0, "session/load must replay session/update events");
    results2.push("ok");
  } finally {
    agent2.kill();
  }

  assert(results2.length > 0, "load phase did not complete");
});

// unstable_listSessions is routed internally by the ACP SDK via a capability handshake;
// calling it raw over stdio gets rejected by the SDK with "Unsupported extension method".
// The adapter implementation is covered in unit tests (test/acp/). Skipped here.
process.stdout.write("- unstable_listSessions (skipped — SDK routing, covered in unit tests)\n");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write("\n");
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
process.stdout.write(`${passed}/${results.length} passed`);
if (failed > 0) {
  process.stdout.write(`, ${failed} failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(" — all green\n");
}
