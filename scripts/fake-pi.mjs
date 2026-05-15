#!/usr/bin/env node
/**
 * Fake pi --mode rpc subprocess for smoke/eval testing.
 *
 * Speaks the same newline-delimited JSON protocol as the real pi binary so
 * that the pi-acp adapter can run without a real pi installation.
 *
 * Accepted env vars:
 *   FAKE_PI_SESSION_FILE  – path to use as the sessionFile in get_state
 *   FAKE_PI_PROMPT_DELAY  – ms between streaming chunks (default 0)
 */

import * as readline from "node:readline";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const SESSION_FILE =
  process.env.FAKE_PI_SESSION_FILE ?? path.join(os.tmpdir(), `fake-pi-session-${process.pid}.json`);

const PROMPT_DELAY = Number(process.env.FAKE_PI_PROMPT_DELAY ?? 0);

// Create the session file so pi-acp's existsSync check passes on session/load.
try {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  if (!fs.existsSync(SESSION_FILE)) {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ messages: [] }) + "\n", "utf-8");
  }
} catch {
  // ignore — smoke tests can proceed even if tmp write fails
}

function reply(id, command, data = {}) {
  process.stdout.write(
    JSON.stringify({ type: "response", id, command, success: true, data }) + "\n",
  );
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

/** Simulate a pi prompt turn: emit assistant chunks then done. */
async function handlePrompt(id, message) {
  reply(id, "prompt", null);

  await sleep(PROMPT_DELAY);

  // Emit a couple of assistant_message events.
  emit({ type: "assistant_message_start" });
  emit({ type: "assistant_message_chunk", text: "Hello from fake-pi! " });
  emit({ type: "assistant_message_chunk", text: `(echo: ${message.slice(0, 60)})` });
  emit({ type: "assistant_message_end" });

  // Signal turn complete.
  emit({ type: "turn_complete", stopReason: "end_turn" });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { type, id } = msg;

  switch (type) {
    case "get_state":
      reply(id, "get_state", {
        sessionFile: SESSION_FILE,
        sessionName: "fake-session",
        model: { provider: "anthropic", modelId: "claude-opus-4-5" },
        thinkingLevel: "off",
      });
      break;

    case "get_available_models":
      reply(id, "get_available_models", {
        models: [
          { provider: "anthropic", modelId: "claude-opus-4-5", displayName: "Claude Opus 4.5" },
          { provider: "anthropic", modelId: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
        ],
        currentProvider: "anthropic",
        currentModelId: "claude-opus-4-5",
      });
      break;

    case "get_commands":
      reply(id, "get_commands", {
        commands: [
          { name: "session", description: "Show session stats", source: "builtin" },
          { name: "compact", description: "Compact context", source: "builtin" },
          {
            name: "skill:test",
            description: "A test skill",
            source: "skill",
            location: "/skills/test.md",
          },
        ],
      });
      break;

    case "get_session_stats":
      reply(id, "get_session_stats", {
        messages: 4,
        tokens: { input: 1200, output: 340 },
        cost: 0.002,
        sessionFile: SESSION_FILE,
      });
      break;

    case "get_messages":
      reply(id, "get_messages", {
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hello from fake-pi!" },
        ],
      });
      break;

    case "prompt":
      await handlePrompt(id, String(msg.message ?? ""));
      break;

    case "abort":
      emit({ type: "turn_complete", stopReason: "cancelled" });
      reply(id, "abort", null);
      break;

    case "set_model":
      reply(id, "set_model", null);
      break;

    case "set_thinking_level":
      reply(id, "set_thinking_level", null);
      break;

    case "set_follow_up_mode":
      reply(id, "set_follow_up_mode", null);
      break;

    case "set_steering_mode":
      reply(id, "set_steering_mode", null);
      break;

    case "compact":
      reply(id, "compact", { compacted: true });
      break;

    case "set_auto_compaction":
      reply(id, "set_auto_compaction", null);
      break;

    case "set_session_name":
      reply(id, "set_session_name", null);
      break;

    case "export_html":
      reply(id, "export_html", { path: path.join(os.tmpdir(), "fake-export.html") });
      break;

    case "switch_session":
      reply(id, "switch_session", null);
      break;

    default:
      // Unknown command — reply with an error so the adapter doesn't hang.
      process.stdout.write(
        JSON.stringify({
          type: "response",
          id,
          command: type,
          success: false,
          error: `unknown command: ${type}`,
        }) + "\n",
      );
  }
});

rl.on("close", () => {
  process.exit(0);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
