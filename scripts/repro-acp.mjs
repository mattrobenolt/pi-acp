#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const acp = resolve(root, "dist/index.js");
const cwd = process.env.REPRO_CWD ?? "/Users/matt/code/planetscale/exosphere-zig";
const defaultSessionId = "019e287c-c6dd-74cc-b75a-28627f048fbe";

const mode = process.argv[2] ?? "new";
const prompts = process.argv.slice(3);
const sessionIdArg = process.env.REPRO_SESSION_ID ?? defaultSessionId;

const child = spawn(process.execPath, [acp], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    PI_ACP_ENABLE_EMBEDDED_CONTEXT: "true",
  },
});

const pending = new Map();
let currentPromptChunks = [];

function send(method, params) {
  const id = randomUUID();
  const payload = { jsonrpc: "2.0", id, method, params };
  console.log(`SEND ${method} ${id}`);
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return waitFor(id);
}

function waitFor(id, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for ${id}`));
    }, timeoutMs);

    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timeout);
        resolve(message);
      },
      reject,
    });
  });
}

function summarizeUpdate(update) {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content ?? {};
      const text = content.text ?? "";
      currentPromptChunks.push(text);
      return `CHUNK ${content.type} ${JSON.stringify(text)}`;
    }
    case "agent_thought_chunk":
      return `THOUGHT ${JSON.stringify(update.content?.text ?? "")}`;
    case "session_info_update":
      return `INFO ${JSON.stringify(update._meta ?? {})}`;
    case "tool_call":
    case "tool_call_update":
      return `TOOL ${update.sessionUpdate} ${update.title ?? update.toolCallId} ${update.status}`;
    case "available_commands_update":
      return "COMMANDS";
    default:
      return `UPDATE ${update.sessionUpdate}`;
  }
}

createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.log(`RAW ${line}`);
    return;
  }

  if (message.method === "session/update") {
    console.log(summarizeUpdate(message.params?.update ?? {}));
    return;
  }

  console.log(`MSG ${JSON.stringify(message).slice(0, 1200)}`);

  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        new Error(`${message.error.message}: ${JSON.stringify(message.error.data ?? {})}`),
      );
    } else {
      waiter.resolve(message);
    }
  }
});

createInterface({ input: child.stderr }).on("line", (line) => {
  console.error(`ERR ${line}`);
});

child.on("exit", (code, signal) => {
  const err = new Error(`pi-acp exited code=${code} signal=${signal}`);
  for (const [, waiter] of pending) waiter.reject(err);
  pending.clear();
});

async function main() {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      auth: { terminal: true },
      _meta: { "terminal-auth": true, terminal_output: true },
    },
    clientInfo: { name: "repro", title: "local repro", version: "0" },
  });

  let sessionId;
  if (mode === "load") {
    await send("session/load", { sessionId: sessionIdArg, cwd, mcpServers: [] });
    sessionId = sessionIdArg;
  } else {
    const response = await send("session/new", { cwd, mcpServers: [] });
    sessionId = response.result.sessionId;
  }

  console.log(`SESSION ${sessionId}`);

  const testPrompts = prompts.length
    ? prompts
    : ["say one word: alpha", "say one word: beta", "thank you sir"];
  for (const prompt of testPrompts) {
    currentPromptChunks = [];
    const response = await send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    console.log(
      `PROMPT_RESULT ${JSON.stringify(response)} CHUNKS ${JSON.stringify(currentPromptChunks.join(""))}`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill("SIGTERM");
  });
