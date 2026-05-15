# Upstream Triage — svkozak/pi-acp open PRs and Issues

**Baseline:** upstream 0.0.27 (`138edb0`). Our fork is at `fa5ac74` (one commit ahead: "add debug logging and safer session loading"). All items below are still open on upstream as of 2026-05-14.

---

## Open PRs

### PR #37 — fix: include project-level packages in startup info

**Author:** ricardoraposo | **Filed:** 2026-05-14 | **Fixes:** #36

`buildStartupInfo()` in `src/acp/agent.ts` only read packages from `~/.pi/agent/settings.json`. Project-specific extensions in `<cwd>/.pi/settings.json` were silently omitted from the "loaded extensions" startup block shown to Zed and other clients. Fix reads from both paths and uses `getAgentDir()` for the global path so `PI_CODING_AGENT_DIR` is respected.

**Code areas:** `src/acp/agent.ts` (`buildStartupInfo`), tests. Overlaps with #23 (which also proposes cleaning up `buildStartupInfo` — the hardcoded `index.ts` sub-bullet). Both are small, non-conflicting changes to the same function.

**Verdict: cherry-pick.** Unambiguous correctness fix. PR includes a passing test suite (73 tests). Apply before #23's cosmetic cleanup so the diff stays clean.

---

### PR #31 — fix: render bash tools as terminals

**Author:** ryanmazzolini | **Filed:** 2026-05-07

Changes bash tool-call output from ACP type `other` to `execute`, rendering a proper terminal panel in Zed instead of a raw JSON blob. Author acknowledges there's an intentional comment in the upstream code explaining why `other` was chosen:

> "Many ACP clients render `execute` tool calls only via the terminal APIs. Since this adapter lets pi execute locally (no client terminal delegation), we report bash as `other` so clients show inline text output blocks."

The PR overrides that reasoning, arguing the Zed UX is materially better with `execute`. Screenshot confirms it looks good in Zed.

**Code areas:** `src/acp/translate/` (bash translation helpers), `src/acp/session.ts` (replay path). **Conflicts with #19**, which also touches bash rendering (wraps output in fenced code blocks rather than switching to `execute` type).

**Verdict: cherry-pick with intent to supersede #19's bash handling.** The two approaches are mutually exclusive — pick one. PR #31's approach (`execute` type) is what the ACP spec intends for terminal output; #19's approach (fenced markdown) is a workaround for clients that don't render `execute`. If we're primarily targeting Zed, #31 wins. If we need a fallback for other clients, #19's fencing is more conservative. Decision needed before applying either.

---

### PR #29 — fix: support updated pi edit results

**Author:** ryanmazzolini | **Filed:** 2026-05-06

Pi's edit tool changed its schema to `{ path, edits: [{ oldText, newText }] }`. Without this fix, edit tool actions show as raw success strings ("Successfully replaced 6 block(s)...") rather than rendered diffs in Zed.

**Code areas:** `src/acp/translate/` (edit/write tool translation). **Conflicts with #19**, which implements its own structured-diff approach for edit/write by snapshotting file contents before the tool runs and emitting ACP `ToolCallContent { type: "diff" }`. PR #29 works with pi's existing diff data; PR #19 generates its own diffs.

**Verdict: cherry-pick #29 now, supersede with #19's approach later if we adopt #19.** PR #29 is a targeted compatibility fix for a schema change that already shipped. It's useful immediately. PR #19's approach is richer (true ACP diff type) but more complex. They're mutually exclusive once applied — coordinate the order.

---

### PR #25 — feat: add automatic ACP session titles

**Author:** RicoTrevisan | **Filed:** 2026-05-02

Generates a session title from the first user prompt and sends `session_info_update`. Also upgrades the ACP SDK to 0.21.0, implements stable `closeSession`, and removes the `closeAllExcept` behavior that could kill an active session when starting a new one. Addresses the cosmetic annoyance of every thread being named "New Agent Thread" (#24).

**Code areas:** `src/acp/session.ts`, `src/acp/agent.ts`, ACP SDK version bump. **Overlaps with #19**, which also emits `session_info_update` (with title + `_meta.piAcp` metadata). These two PRs solve the same problem with different scope — #25 is narrower and ships the SDK bump; #19 is comprehensive but doesn't bump the SDK.

**Verdict: cherry-pick if we're not taking #19.** If #19 goes in, the session-title portion of #25 is redundant. The `closeAllExcept` removal and SDK bump in #25 are independently valuable though — worth extracting those even if you roll your own title logic.

---

### PR #21 — feat: forward non-pi-acp CLI arguments to pi executable

**Author:** Th1nkK1D | **Filed:** 2026-04-26

Adds `src/pi-rpc/forward-args.ts`: strips pi-acp-managed flags (`--mode`, `--session`, `--no-themes`, `--terminal-login`) and forwards everything else to the underlying `pi` spawn. Also supports `--` passthrough boundary. Includes 9 unit tests, README docs, Zed config example.

**Code areas:** new `src/pi-rpc/forward-args.ts`, `src/pi-rpc/process.ts` (appends forwarded args). No conflicts with any other open PR.

**Verdict: cherry-pick.** Clean, self-contained, backwards-compatible. Directly useful for passing `--model`, `--provider`, and extension flags through Zed's agent config. Low risk.

---

### PR #20 — Support extension commands in ACP

**Author:** RogierKonings | **Filed:** 2026-04-24

Sparse description: "Adds support for slash commands initiated by extensions for ACP." No details in the body beyond that one sentence.

**Code areas:** likely `src/acp/slash-commands.ts` and possibly `src/acp/agent.ts`. **Overlaps with #19**, which exposes extension-sourced commands via `enableExtensionCommands` (env var + settings, defaulting to `true`).

**Verdict: defer pending diff review.** The body is too thin to evaluate without reading the diff directly. #19 covers this territory more thoroughly. Unless there's something unique in #20's approach, #19 is the better vehicle.

---

### PR #19 — feat(acp): improve Zed integration (usage telemetry, structured diffs, session metadata, /version)

**Author:** klujanrosas | **Filed:** 2026-04-24

The big omnibus PR. Includes:

- `session_info_update` emission with title + `_meta.piAcp` (version, git sha, model, contextWindow, sessionFile)
- `/version` slash command
- Context-aware session seeding with model/contextWindow from pi state
- Extension-sourced slash commands exposed by default (configurable via `PI_ACP_ENABLE_EXTENSION_COMMANDS`)
- Usage telemetry via `usage_update` + `session_info_update._meta.piAcp.usage`; auto-hides text fallback for Zed
- Structured ACP diffs for `edit`/`write` (snapshot-before + `type:"diff"`)
- Fenced bash output

Based on 0.0.26. We're on 0.0.27 — one upstream commit separates them, so rebase should be straightforward.

**Code areas:** touches nearly everything: `src/acp/agent.ts`, `src/acp/session.ts`, `src/acp/translate/` (new `usage.ts`), new `src/version.ts`, tests. **Conflicts with:** #25 (session titles, SDK bump), #29 (edit schema), #31 (bash rendering), #20 (extension commands).

**Verdict: cherry-pick selectively or rewrite as multiple smaller PRs.** This is the most valuable unmerged PR in the queue — usage telemetry and structured diffs are genuinely useful. But it's too large to take wholesale without conflict analysis against every other open PR. Recommended approach: land #29 and #31 first (they're narrower and fix real bugs), then evaluate whether the diff/bash portions of #19 supersede them, and cherry-pick the non-overlapping parts (#19's usage telemetry, `/version`, session metadata) as a separate commit.

---

### PR #10 — add Google Vertex AI environment variables to the list of valid variables

**Author:** miropls | **Filed:** 2026-04-09

Adds Vertex-required env vars (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, etc.) to the allowed env var passthrough list so Vertex-based providers work through pi-acp in Zed. Also adds README docs on the Vertex setup path.

**Code areas:** `src/acp/auth.ts` (or wherever the env var allowlist lives), `README.md`. No conflicts with any other open PR.

**Verdict: cherry-pick.** Straightforward extension to the env var list. Independently useful for anyone running Vertex. 3 comments on the PR — worth checking if they raised concerns about the var list completeness, but likely just discussion.

---

## Open Issues

### Issue #36 — Project specific packages not being loaded

Directly addressed by PR #37. **No separate action needed** — tracking issue only.

---

### Issue #35 — crypto is not defined on Node.js 18

`crypto.randomUUID()` is called in 4 places but relies on the global `crypto` object, which only exists on Node 19+. On Node 18 (still common via `.nvmrc`/`.prototools`), it throws `ReferenceError`. Fix: `import crypto from 'node:crypto'` at the top of wherever `randomUUID` is called.

**Code areas:** `src/index.ts` (or the relevant source files — the bug report cites lines 313, 612, 853, 2160 of `dist/index.js`).

**Verdict: quick fix, apply.** One-line import, backwards-compatible with Node 16+. No conflict with anything else. Worth checking whether our fork already has this given we're at 0.0.27.

---

### Issue #34 — ACP edit/write/bash tool fixes for Zed

Meta-issue from ryanmazzolini pointing to PRs #29 and #31. No separate action; see those PR entries.

---

### Issue #33 — IntelliJ ACP connection hangs

"Starting pi ACP..." shows indefinitely in IntelliJ AI editor. One comment, no resolution. Likely an IntelliJ-specific handshake issue or a problem with how IntelliJ sends `initialize`. We don't have IntelliJ in scope.

**Verdict: defer.** Not relevant unless we're targeting IntelliJ. Worth watching for root cause in case it reveals a general protocol conformance issue.

---

### Issue #32 — Support custom location for session-map.json

`session-map.json` is hardcoded to `~/.pi/pi-acp`. Pi itself respects `PI_CODING_AGENT_DIR` (defaults to `~/.pi/agent`). There's also a hardcoded path for `agent/prompts` in `slash-commands.ts`. Suggestion: honor `PI_CODING_AGENT_DIR` or add `PI_ACP_DIR`.

**Code areas:** `src/acp/paths.ts`, `src/acp/slash-commands.ts`.

**Verdict: rewrite (implement the fix).** Small change with real user value, especially for anyone using XDG-style config directories. Not controversial. Implement rather than cherry-pick since there's no PR yet.

---

### Issue #28 — Session lost after process restart — "Unknown sessionId" error

When pi-acp restarts (Zed crash, timeout, etc.), `SessionManager`'s in-memory `Map` is empty. Zed sends the same `sessionId` it had before, gets `Unknown sessionId: <uuid>` back. `session-map.json` has the right data but is only consulted for explicit `session/load`, not for `prompt`/`cancel`/model changes. Issue includes a detailed proposed fix (auto-restore helper).

**Code areas:** `src/acp/agent.ts` (`prompt`, `cancel`, `unstable_setSessionModel`, `setSessionMode`), `src/acp/session-store.ts`.

Our fork's `fa5ac74` commit is titled "add debug logging and safer session loading" — this may partially address this. Verify what's in that commit before acting.

**Verdict: cherry-pick the proposed fix (with review).** 4 upvotes, this annoys real users. The proposed patch in the issue body is detailed and sane. Check if our `fa5ac74` already covers it before implementing.

---

### Issue #27 — Windows: 'pi.cmd' is not recognized

On Windows with bun, the pi binary is `pi.exe` not `pi.cmd`. The spawn logic tries `pi.cmd` (the npm convention), which fails silently in Zed.

**Code areas:** `src/pi-rpc/process.ts` (spawn command resolution, platform detection).

**Verdict: cherry-pick if Windows matters to us.** If we're macOS/Linux only in our fork, skip. If Windows users are in scope, it's a small platform detection check. No conflict with other PRs.

---

### Issue #26 — Ask user not working correctly on ACP

Body is just an image (no text). From context and #22, this is likely about extension UI dialogs (confirm/select prompts from pi tools) not surfacing to ACP clients — same territory as #22.

**Verdict: defer pending clarity.** No actionable detail. Likely resolved by implementing #22 if that goes forward.

---

### Issue #24 — session_info_update not implemented — threads have no title

Same root cause as what PR #25 and PR #19 both address. **No separate action needed** — tracking issue for the title problem.

---

### Issue #23 — Extension startup info shows hardcoded "index.ts" sub-bullet

`buildStartupInfo()` emits `npm:<package>\n  - index.ts` for every npm extension. The `index.ts` is hardcoded regardless of the actual package entrypoint. Fix: drop the sub-bullet, emit the package name as a flat list item.

**Code areas:** `src/acp/agent.ts` (`buildStartupInfo`). **Overlaps with PR #37** which also modifies `buildStartupInfo`.

**Verdict: apply after #37.** One-line removal, independently correct. Apply on top of #37's project-packages change. Don't let it block anything.

---

### Issue #22 — Bridge extension_ui_request (select/confirm) to ACP session/request_permission

Pi extensions can hook `tool_call` and call `ctx.ui.select(...)` / `ctx.ui.confirm(...)` to gate tool execution. Currently, pi-acp drops these frames — tools get auto-approved, no UX surface. Proposal: translate `extension_ui_request` with method `select`/`confirm` into ACP `session/request_permission`, hold the pi response until the ACP client responds, then write the user's choice back to pi stdin.

**Code areas:** `src/pi-rpc/process.ts` (parse new frame type), `src/acp/session.ts` (bridge ACP ↔ pi), possibly new `src/acp/translate/permission.ts`. No PR exists yet.

**Verdict: rewrite (implement as new PR).** This is the right approach — narrowly scoped, uses stable ACP spec, doesn't require elicitation (the reason #11 was closed). High value for agentic safety. Substantial work (~150-200 lines) but architecturally clean. File a PR if/when we want this.

---

### Issue #18 — Authentication issues (17 comments)

Users finding pi-acp always demands authentication even when pi itself is configured with API keys. High comment count suggests this is a recurring confusion. Likely relates to `hasAnyPiAuthConfigured()` not detecting all provider configurations (similar to #15).

**Code areas:** `src/acp/auth.ts`, `src/acp/agent.ts`.

**Verdict: informational — root cause overlaps with #15.** The fix for #15 (bypass / better detection) would resolve most of these cases. No separate action beyond fixing #15.

---

### Issue #17 — ACP not working in Zed, auth issues

Same category as #18. Windows user, auth failing. Related to #15/#18.

**Verdict: resolved by fixing #15.**

---

### Issue #15 — Custom (dynamic) providers block pi startup due to wrong "auth required" check

Custom providers (e.g., LMStudio via `pi-custom-provider-lmstudio`) are dynamic — models aren't discoverable until after pi starts. `hasAnyPiAuthConfigured()` checks static env vars for known providers, so custom-provider users always fail the check and get the AUTH_REQUIRED error. Only workaround is setting a junk env var for another provider.

**Code areas:** `src/acp/auth.ts` (`hasAnyPiAuthConfigured`), `src/acp/agent.ts` (the call site).

**Verdict: implement a bypass.** Add `PI_ACP_SKIP_PI_AUTH=1` (or similar) that skips the `hasAnyPiAuthConfigured` check. 2 upvotes, clear root cause, clear fix. The PR for #10 (Vertex env vars) is a partial mitigation for one provider but doesn't solve the general case.

---

### Issue #7 — Map prompts during streaming to pi steer command

Currently, prompts arriving during an active pi turn are queued client-side and sent after `agent_end`. Pi supports a `steer` RPC that delivers a message mid-run, interrupting the current flow. Issue proposes: when `session/prompt` arrives while a turn is in-flight, route to `pi.steer()` instead of the queue.

**Code areas:** `src/pi-rpc/process.ts` (add `steer()`/`followUp()` methods), `src/acp/session.ts` (`prompt()` logic).

**Verdict: defer.** Useful feature but non-trivial to get right (what's the right default — steer vs follow-up?), and it doesn't fix a breakage. `/steering` and `/follow-up` slash commands already give power users control. Revisit after the correctness fixes are in.

---

## Conflict/Overlap Map

**Tool translation cluster** — #19, #29, #31 all modify `src/acp/translate/` and how edit/write/bash are rendered. They're mutually exclusive in the bash and edit areas. Pick one approach per tool type before merging anything from this cluster. Recommended sequence: cherry-pick #29 (edit schema fix, needed now), then decide between #31 (bash as `execute`) and #19's bash fencing. If taking #19, skip #31; if taking #31, skip #19's bash section.

**Session title/metadata cluster** — #19, #24, #25 all want `session_info_update` with a title. #25 is narrow and includes an SDK bump; #19 is broader. Pick one or cherry-pick the SDK bump from #25 and implement titles yourself.

**Extension commands cluster** — #19 and #20 both expose extension-sourced slash commands. If #19 goes in, #20 is redundant.

**buildStartupInfo cluster** — #23 and #37 both modify `buildStartupInfo` in `src/acp/agent.ts`. They don't conflict logically (one adds project packages, one removes the `index.ts` sub-bullet), but apply #37 first then #23.

**Auth cluster** — #10, #15, #17, #18 all relate to auth detection. #10 adds Vertex vars (apply it). #15 needs a bypass flag. #17/#18 are user confusion that #15 resolves.

---

## Priority Summary

| #   | Type  | Verdict                                        | Priority                         |
| --- | ----- | ---------------------------------------------- | -------------------------------- |
| #37 | PR    | cherry-pick                                    | high — bug fix, already has PR   |
| #29 | PR    | cherry-pick                                    | high — schema compat fix         |
| #35 | issue | quick fix                                      | high — crashes on Node 18        |
| #10 | PR    | cherry-pick                                    | medium — Vertex support          |
| #21 | PR    | cherry-pick                                    | medium — useful feature, clean   |
| #31 | PR    | cherry-pick (mutually exclusive with #19 bash) | medium                           |
| #23 | issue | trivial fix                                    | medium — one-line cleanup        |
| #25 | PR    | cherry-pick if not taking #19                  | medium                           |
| #28 | issue | implement (check fa5ac74 first)                | medium — session durability      |
| #15 | issue | implement bypass flag                          | medium — auth UX                 |
| #32 | issue | implement                                      | low-medium — config path         |
| #19 | PR    | selective cherry-pick                          | low (large, needs decomposition) |
| #22 | issue | implement new PR                               | low (substantial, no urgency)    |
| #7  | issue | defer                                          | low                              |
| #20 | PR    | defer (see #19)                                | low                              |
| #33 | issue | defer                                          | n/a (IntelliJ)                   |
| #27 | issue | cherry-pick if Windows in scope                | n/a                              |
| #26 | issue | defer                                          | n/a                              |
| #18 | issue | no action (covered by #15)                     | —                                |
| #17 | issue | no action (covered by #15)                     | —                                |
| #34 | issue | no action (meta-issue)                         | —                                |
| #36 | issue | no action (covered by #37)                     | —                                |
| #24 | issue | no action (covered by #25/#19)                 | —                                |

---

## Sources

- https://api.github.com/repos/svkozak/pi-acp/pulls?state=open
- https://api.github.com/repos/svkozak/pi-acp/issues?state=open
- Individual issue/PR endpoints for #7, #10, #15, #17, #18, #19, #20, #21, #22, #23, #24, #25, #26, #27, #28, #29, #31, #32, #33, #34, #35, #36, #37
