/**
 * Tests for the extension_ui_request → ACP requestPermission bridge.
 *
 * Uses fakes for both PiRpcProcess and AgentSideConnection so no real
 * subprocess or network is needed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PiAcpSession } from "../src/acp/session.js";
import type { ExtensionUiResponsePayload } from "../src/pi-rpc/process.js";

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

type EventHandler = (ev: Record<string, unknown>) => void;

/** Fake proc that captures extension_ui_response calls and lets us fire events. */
function makeFakeProc() {
  const handlers: EventHandler[] = [];
  const uiResponses: Array<{ requestId: string; response: ExtensionUiResponsePayload }> = [];

  return {
    onEvent(handler: EventHandler) {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    sendExtensionUiResponse(requestId: string, response: ExtensionUiResponsePayload) {
      uiResponses.push({ requestId, response });
    },
    // Emit a pi event to all registered handlers
    emit(ev: Record<string, unknown>) {
      for (const h of handlers) h(ev);
    },
    async abort() {},
    dispose() {},
    uiResponses,
  };
}

type FakeProc = ReturnType<typeof makeFakeProc>;

/** Fake conn that records requestPermission calls and returns a controlled response. */
function makeFakeConn(permissionResponse: () => Promise<{ outcome: string; optionId?: string }>) {
  const permissionCalls: unknown[] = [];
  const sessionUpdates: unknown[] = [];

  return {
    async requestPermission(params: unknown) {
      permissionCalls.push(params);
      return permissionResponse();
    },
    async sessionUpdate(params: unknown) {
      sessionUpdates.push(params);
    },
    permissionCalls,
    sessionUpdates,
  };
}

type FakeConn = ReturnType<typeof makeFakeConn>;

function makeSession(proc: FakeProc, conn: FakeConn) {
  return new PiAcpSession({
    sessionId: "test-session",
    cwd: "/tmp",
    mcpServers: [],
    proc: proc as any,
    conn: conn as any,
    fileCommands: [],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extension_ui_request bridge", () => {
  it("select: maps options to requestPermission and returns value", async () => {
    let resolvePermission!: (v: { outcome: string; optionId?: string }) => void;
    const permissionPromise = new Promise<{ outcome: string; optionId?: string }>((resolve) => {
      resolvePermission = resolve;
    });

    const proc = makeFakeProc();
    const conn = makeFakeConn(() => permissionPromise);
    makeSession(proc, conn);

    proc.emit({
      type: "extension_ui_request",
      id: "req-1",
      method: "select",
      ui: {
        type: "select",
        title: "Pick one",
        options: [
          { id: "a", label: "Option A" },
          { id: "b", label: "Option B" },
        ],
      },
    });

    // requestPermission should have been called
    assert.equal(conn.permissionCalls.length, 1);
    const call = conn.permissionCalls[0] as any;
    assert.equal(call.sessionId, "test-session");
    assert.equal(call.options.length, 2);
    assert.equal(call.options[0].optionId, "0");
    assert.equal(call.options[0].name, "Option A");
    assert.equal(call.options[0].kind, "allow_once");
    assert.equal(call.options[1].optionId, "1");
    assert.equal(call.toolCall.toolCallId, "req-1");
    assert.equal(call.toolCall.title, "Pick one");

    // User selects option A
    resolvePermission({ outcome: "selected", optionId: "0" });

    // Wait for async bridge to complete
    await new Promise((r) => setImmediate(r));

    assert.equal(proc.uiResponses.length, 1);
    assert.deepEqual(proc.uiResponses[0], {
      requestId: "req-1",
      response: { value: "a" },
    });
  });

  it("select: cancelled outcome maps to cancelled response", async () => {
    const proc = makeFakeProc();
    const conn = makeFakeConn(() => Promise.resolve({ outcome: "cancelled" }));
    makeSession(proc, conn);

    proc.emit({
      type: "extension_ui_request",
      id: "req-2",
      method: "select",
      ui: {
        type: "select",
        title: "Pick one",
        options: [{ id: "x", label: "X" }],
      },
    });

    await new Promise((r) => setImmediate(r));

    assert.equal(proc.uiResponses.length, 1);
    assert.deepEqual(proc.uiResponses[0], {
      requestId: "req-2",
      response: { cancelled: true },
    });
  });

  it("confirm: selected 'confirm' maps to confirmed=true", async () => {
    const proc = makeFakeProc();
    const conn = makeFakeConn(() => Promise.resolve({ outcome: "selected", optionId: "confirm" }));
    makeSession(proc, conn);

    proc.emit({
      type: "extension_ui_request",
      id: "req-3",
      method: "confirm",
      message: "Are you sure?",
      ui: {
        type: "confirm",
        confirmText: "Proceed",
        rejectText: "Abort",
      },
    });

    await new Promise((r) => setImmediate(r));

    // Check that options were mapped correctly
    assert.equal(conn.permissionCalls.length, 1);
    const call = conn.permissionCalls[0] as any;
    assert.equal(call.options[0].optionId, "confirm");
    assert.equal(call.options[0].name, "Proceed");
    assert.equal(call.options[0].kind, "allow_once");
    assert.equal(call.options[1].optionId, "reject");
    assert.equal(call.options[1].name, "Abort");
    assert.equal(call.options[1].kind, "reject_once");

    assert.deepEqual(proc.uiResponses[0], {
      requestId: "req-3",
      response: { confirmed: true },
    });
  });

  it("confirm: selected 'reject' maps to confirmed=false", async () => {
    const proc = makeFakeProc();
    const conn = makeFakeConn(() => Promise.resolve({ outcome: "selected", optionId: "reject" }));
    makeSession(proc, conn);

    proc.emit({
      type: "extension_ui_request",
      id: "req-4",
      method: "confirm",
      ui: { type: "confirm", message: "Continue?" },
    });

    await new Promise((r) => setImmediate(r));

    assert.deepEqual(proc.uiResponses[0], {
      requestId: "req-4",
      response: { confirmed: false },
    });
  });

  it("confirm: uses default yes/no labels when not specified", async () => {
    const proc = makeFakeProc();
    const conn = makeFakeConn(() => Promise.resolve({ outcome: "cancelled" }));
    makeSession(proc, conn);

    proc.emit({
      type: "extension_ui_request",
      id: "req-5",
      method: "confirm",
      ui: { type: "confirm", message: "Continue?" },
    });

    await new Promise((r) => setImmediate(r));

    const call = conn.permissionCalls[0] as any;
    assert.equal(call.options[0].name, "Yes");
    assert.equal(call.options[1].name, "No");
  });

  it("input: auto-cancelled immediately (not blocked)", async () => {
    let permissionCalled = false;
    const proc = makeFakeProc();
    const conn = makeFakeConn(async () => {
      permissionCalled = true;
      return { outcome: "cancelled" };
    });
    makeSession(proc, conn);

    proc.emit({
      type: "extension_ui_request",
      id: "req-6",
      method: "input",
      ui: { type: "input", message: "Enter value" },
    });

    // Auto-cancel happens synchronously (no permission call)
    assert.equal(permissionCalled, false);
    assert.equal(proc.uiResponses.length, 1);
    assert.deepEqual(proc.uiResponses[0], {
      requestId: "req-6",
      response: { cancelled: true },
    });
  });

  it("editor: auto-cancelled immediately", () => {
    const proc = makeFakeProc();
    const conn = makeFakeConn(() => Promise.resolve({ outcome: "selected" }));
    makeSession(proc, conn);

    proc.emit({
      type: "extension_ui_request",
      id: "req-7",
      method: "editor",
      ui: { type: "editor", message: "Edit content" },
    });

    assert.equal(proc.uiResponses.length, 1);
    assert.deepEqual(proc.uiResponses[0], {
      requestId: "req-7",
      response: { cancelled: true },
    });
    // No permission call for unsupported types
    assert.equal(conn.permissionCalls.length, 0);
  });

  it("select with empty options: auto-cancelled", () => {
    const proc = makeFakeProc();
    const conn = makeFakeConn(() => Promise.resolve({ outcome: "selected" }));
    makeSession(proc, conn);

    proc.emit({
      type: "extension_ui_request",
      id: "req-8",
      method: "select",
      ui: { type: "select", options: [] },
    });

    assert.equal(proc.uiResponses.length, 1);
    assert.deepEqual(proc.uiResponses[0].response, { cancelled: true });
    assert.equal(conn.permissionCalls.length, 0);
  });

  it("session cancel resolves pending UI requests as cancelled", async () => {
    // requestPermission never resolves on its own — session cancel should unblock it
    let permissionCalled = false;
    const proc = makeFakeProc();
    const conn = makeFakeConn(
      () =>
        new Promise((resolve) => {
          permissionCalled = true;
          // Never resolves on its own — only via cancel
          void resolve;
        }),
    );
    const session = makeSession(proc, conn);

    proc.emit({
      type: "extension_ui_request",
      id: "req-9",
      method: "select",
      ui: {
        type: "select",
        title: "Pick",
        options: [{ id: "x", label: "X" }],
      },
    });

    // Wait for requestPermission to be called
    await new Promise((r) => setImmediate(r));
    assert.equal(permissionCalled, true);

    // Now cancel the session
    await session.cancel();
    await new Promise((r) => setImmediate(r));

    // Should have received a cancelled response
    assert.equal(proc.uiResponses.length, 1);
    assert.deepEqual(proc.uiResponses[0], {
      requestId: "req-9",
      response: { cancelled: true },
    });
  });

  it("toolCallId is taken from the single in-progress tool call when available", async () => {
    const proc = makeFakeProc();
    const conn = makeFakeConn(() => Promise.resolve({ outcome: "selected", optionId: "confirm" }));
    makeSession(proc, conn);

    // Simulate a tool_execution_start so currentToolCalls has an in-progress entry
    proc.emit({
      type: "tool_execution_start",
      toolCallId: "tool-abc",
      toolName: "bash",
      args: { command: "ls" },
    });

    proc.emit({
      type: "extension_ui_request",
      id: "req-ext-1",
      method: "confirm",
      message: "Run dangerous thing?",
      ui: { type: "confirm", confirmText: "Yes", rejectText: "No" },
    });

    await new Promise((r) => setImmediate(r));

    const call = conn.permissionCalls[0] as any;
    // Should use the active tool's id, not the UI request id
    assert.equal(call.toolCall.toolCallId, "tool-abc");
  });

  it("toolCallId falls back to requestId when no tool is in progress", async () => {
    const proc = makeFakeProc();
    const conn = makeFakeConn(() => Promise.resolve({ outcome: "cancelled" }));
    makeSession(proc, conn);

    proc.emit({
      type: "extension_ui_request",
      id: "req-ext-2",
      method: "confirm",
      message: "Allow?",
      ui: { type: "confirm" },
    });

    await new Promise((r) => setImmediate(r));

    const call = conn.permissionCalls[0] as any;
    assert.equal(call.toolCall.toolCallId, "req-ext-2");
  });

  it("toolCallId falls back to requestId when multiple tools are in progress", async () => {
    const proc = makeFakeProc();
    const conn = makeFakeConn(() => Promise.resolve({ outcome: "cancelled" }));
    makeSession(proc, conn);

    // Start two tools simultaneously
    proc.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: {},
    });
    proc.emit({
      type: "tool_execution_start",
      toolCallId: "tool-2",
      toolName: "read",
      args: {},
    });

    proc.emit({
      type: "extension_ui_request",
      id: "req-ext-3",
      method: "confirm",
      ui: { type: "confirm" },
    });

    await new Promise((r) => setImmediate(r));

    const call = conn.permissionCalls[0] as any;
    // Ambiguous — fall back to request id
    assert.equal(call.toolCall.toolCallId, "req-ext-3");
  });

  it("missing requestId: silently ignored", () => {
    const proc = makeFakeProc();
    const conn = makeFakeConn(() => Promise.resolve({ outcome: "selected" }));
    makeSession(proc, conn);

    proc.emit({
      type: "extension_ui_request",
      // no requestId
      ui: { type: "confirm", message: "?" },
    });

    // No response and no crash
    assert.equal(proc.uiResponses.length, 0);
    assert.equal(conn.permissionCalls.length, 0);
  });
});
