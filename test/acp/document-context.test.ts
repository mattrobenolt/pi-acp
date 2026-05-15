import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDocumentContextPrefix, type SessionDocumentContext } from "../../src/acp/agent.js";

const CWD = "/home/user/project";

function makeCtx(overrides?: Partial<SessionDocumentContext>): SessionDocumentContext {
  return {
    focusedDocument: null,
    openDocuments: new Map(),
    ...overrides,
  };
}

describe("buildDocumentContextPrefix", () => {
  it("returns empty string when ctx is null", () => {
    assert.equal(buildDocumentContextPrefix(null, "fix the bug", CWD), "");
  });

  it("returns empty string when no focused document", () => {
    assert.equal(buildDocumentContextPrefix(makeCtx(), "fix the bug", CWD), "");
  });

  it("includes focused file path and line", () => {
    const ctx = makeCtx({
      focusedDocument: {
        uri: `file://${CWD}/src/index.ts`,
        languageId: "typescript",
        position: { line: 9, character: 0 },
        visibleRange: {
          start: { line: 0, character: 0 },
          end: { line: 30, character: 0 },
        },
      },
    });

    const prefix = buildDocumentContextPrefix(ctx, "what is wrong here?", CWD);
    assert.ok(prefix.includes("src/index.ts"), "should contain relative path");
    assert.ok(prefix.includes("(typescript)"), "should contain languageId");
    assert.ok(prefix.includes("line 10"), "should show 1-based line number");
  });

  it("shows full path when outside cwd", () => {
    const ctx = makeCtx({
      focusedDocument: {
        uri: "file:///other/path/file.go",
        languageId: "go",
        position: { line: 0, character: 0 },
        visibleRange: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
      },
    });

    const prefix = buildDocumentContextPrefix(ctx, "help", CWD);
    assert.ok(prefix.includes("/other/path/file.go"));
  });

  it("skips injection when file already mentioned in message", () => {
    const ctx = makeCtx({
      focusedDocument: {
        uri: `file://${CWD}/src/index.ts`,
        languageId: "typescript",
        position: { line: 0, character: 0 },
        visibleRange: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
      },
    });

    const prefix = buildDocumentContextPrefix(ctx, "look at src/index.ts and fix it", CWD);
    assert.equal(prefix, "");
  });

  it("includes other open files when count is small", () => {
    const ctx = makeCtx({
      focusedDocument: {
        uri: `file://${CWD}/src/main.ts`,
        languageId: "typescript",
        position: { line: 0, character: 0 },
        visibleRange: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
      },
      openDocuments: new Map([
        [`file://${CWD}/src/main.ts`, { languageId: "typescript", version: 1 }],
        [`file://${CWD}/src/utils.ts`, { languageId: "typescript", version: 1 }],
      ]),
    });

    const prefix = buildDocumentContextPrefix(ctx, "refactor this", CWD);
    assert.ok(prefix.includes("utils.ts"), "should list other open file");
    assert.ok(!prefix.match(/main\.ts.*main\.ts/), "focused file should not appear twice");
  });

  it("omits other open files when count exceeds 8", () => {
    const openDocuments = new Map<string, { languageId: string; version: number }>();
    for (let i = 0; i < 10; i++) {
      openDocuments.set(`file://${CWD}/src/file${i}.ts`, { languageId: "typescript", version: 1 });
    }
    const ctx = makeCtx({
      focusedDocument: {
        uri: `file://${CWD}/src/file0.ts`,
        languageId: "typescript",
        position: { line: 0, character: 0 },
        visibleRange: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
      },
      openDocuments,
    });

    const prefix = buildDocumentContextPrefix(ctx, "help", CWD);
    assert.ok(!prefix.includes("Other open files"), "should omit other files when too many");
  });

  it("handles non-file URIs gracefully", () => {
    const ctx = makeCtx({
      focusedDocument: {
        uri: "untitled:Untitled-1",
        languageId: "plaintext",
        position: { line: 0, character: 0 },
        visibleRange: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
      },
    });

    const prefix = buildDocumentContextPrefix(ctx, "what is this?", CWD);
    assert.ok(prefix.includes("untitled:Untitled-1"));
  });
});
