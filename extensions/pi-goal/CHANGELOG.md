# Changelog

## Unreleased

- Refresh the structural audit to the current 0.1.26 baseline and align README/AGENTS audit links.
- Avoid duplicate platform-smoke test execution during `npm run verify` by moving the platform-smoke assertion file under the `check:platform-smoke` script only.
- Narrow runtime event registration typing to the event-handler interface.

## 0.1.26 - 2026-06-10

- Resume active goals after host context-overflow auto-compaction when Pi compacts successfully but no host retry turn starts, avoiding sessions that only continue again after `/reload`.
- Add regression coverage for the host-overflow post-compaction fallback and for avoiding duplicate continuations when the host retry turn does start.
- Update the documented Pi release baseline to `@earendil-works/*` `0.79.1`.
- Add a fast interactive `/goal` smoke path and tmux CSI-u Enter automation guidance to the README and platform smoke docs.
- Strengthen the model-backed platform runtime smoke so it requires built-in `read` tool verification before goal completion.

## 0.1.25 - 2026-06-08

- Update the local pi development baseline to `@earendil-works/*` `0.79.0` and refresh the npm lockfile after reviewing the Pi `0.79.0` changelog, extension docs, package docs, SDK/RPC docs, and current project-trust examples.
- Make release smoke commands explicit about Pi `0.79.0` project trust by passing `--approve` for isolated project-local package install, list, and non-interactive runtime smoke paths.
- Update platform-smoke regression checks and docs so future release gates catch missing trust approval flags before packed package validation runs.

## 0.1.24 - 2026-06-04

- Update the local pi development baseline to `@earendil-works/*` `0.78.1` and refresh the npm lockfile after reviewing the Pi `0.78.1` changelog, extension docs, package docs, and current examples.
- Add the new Pi extension context fields to the runtime test harness so tests stay aligned with Pi `0.78.1` `ctx.mode` and command `ctx.getSystemPromptOptions()` APIs.
- Confirm the goal extension remains forward-open for pi installs through optional wildcard pi runtime peers; Pi `0.78.1` is documented as the tested suggested floor, not a hard install requirement.

## 0.1.23 - 2026-06-04

- Add `/goal copy` to copy the current goal objective for active, paused, budget-limited, or completed goals.
- Allow explicit `create_goal` replacement of non-complete goals and teach `/create-goal` to use it so users do not have to clear existing goals first.
- Strengthen Windows doctor readiness with a disposable Crabbox clone SSH/tool probe when the stopped Parallels template has no live IP, while skipping that extra disposable probe during the full platform-smoke gate so the real Windows test lease is opened only once.

## 0.1.22 - 2026-06-02

- Tighten test-only TypeScript casts around goal state and recovery runtime harnesses.
- Make the recovery runtime generic over its context so tests can use the minimal status context they exercise.
- Add a type-hygiene regression check for banned TypeScript escape hatches such as double assertions, `as any`, `as never`, `any` annotations, and suppression comments.

## 0.1.21 - 2026-06-01

- Add a Crabbox-backed release gate for macOS, Ubuntu Linux, and native Windows.
- Prove releases through packed package install, `pi install`, `pi list`, and a real model-backed goal runtime smoke on every required platform.
- Add `check:platform-smoke` to the normal verification path and make `smoke:platform:all` run doctor before any target suite.
- Strengthen platform doctor checks for Crabbox providers, Windows Parallels template/snapshot readiness, repository hygiene, package contents, auth presence, artifact redaction, and lease cleanup evidence.

## 0.1.20 - 2026-05-31

- Defer active-goal continuations queued by `session_compact` until the compaction event has unwound, avoiding nested prompt/auto-compaction races in Pi’s compaction lifecycle.
- Accelerate pending idle continuation retries after compaction so length-stop recovery resumes promptly once the host is idle.
- Ignore stale compact usage snapshots during reconstruction so old runtime entries cannot rewind usage, reactivate completed goals, or downgrade budget-limited goals.
- Expand regression coverage for reported long-session failures: host retry cancellation, duplicate `session_compact` coalescing, shutdown cancellation, host overflow suppression, and stale runtime usage entries.

## 0.1.19 - 2026-05-31

- Add the `/create-goal` prompt template to the package and document it as the recommended way to create high-quality goals from plain tasks.
- Treat `exceeded request buffer limit while retrying upstream` as a retryable transient provider failure so active goals stay active with pending recovery instead of being paused.
- Allow `/goal resume` to queue a user-start continuation when an already-active goal is waiting for post-overflow user-start recovery, avoiding misleading “Only paused goals can be resumed” dead ends.
- Suppress duplicate hidden continuations while an extension-injected user continuation is passing through compaction, avoiding nested prompt errors like “Agent is already processing a prompt.”
- Persist runtime-only usage updates as compact usage snapshot entries after the initial goal snapshot so long active sessions no longer append the full objective on every runtime flush.

## 0.1.18 - 2026-05-29

- Updates the local pi development baseline to `@earendil-works/*` `0.78.0` and refreshes the npm lockfile after reviewing the Pi `0.78.0` changelog.
- Confirms the goal extension remains compatible with Pi `0.78.0` extension and package APIs; no runtime code changes were needed.

## 0.1.17 - 2026-05-29

- Aligns the budget-limit steering prompt with the public `budgetLimited` status spelling.
- Documents that default-branch source installs may include unreleased changes beyond the latest npm/tagged release.
- Adds a copy-pasteable interactive Cursor Composer 2.5 `/goal` smoke test and documents that `pi -p '/goal ...'` is not a reliable slash-command smoke path.
- Stops refreshing the latest active hidden goal continuation during provider-context rewriting, preserving prompt-cache stability while still superseding older continuations.
- Includes README-linked `AGENTS.md` and `docs/CODEBASE_AUDIT.md` in npm packages, switches pinned install examples to version placeholders, and synchronizes audit/recovery baseline notes with Pi `0.77.0`.

## 0.1.16 - 2026-05-28

- Adds `docs/CODEBASE_AUDIT.md` with a 2026-05-28 structural health report and remediation record.
- Adds project `AGENTS.md` and documents `npm run verify` in the README Development section.
- Extracts stale queued-work reducer lifecycle default tables into `stale-queued-work-reducer-defaults.ts`.
- Ignores local `.debug/` Cursor SDK event artifacts in `.gitignore`.
- Updates the local pi development baseline to `@earendil-works/*` `0.77.0`, keeps pi runtime packages as optional wildcard peers, and leaves no pi/Node upper-bound metadata that would block future pi releases at install time.

## 0.1.15 - 2026-05-27

- Refactors the goal runtime monolith into focused modules for clearer lifecycle ownership, event handling, and continuation orchestration.
- Narrows runtime handler dependency interfaces so input/context, turn, agent, and session handlers only receive the lifecycle ports they use.
- Moves goal transition effect application into a focused effect module so transition planning stays centered on goal snapshots and persistence decisions.
- Reworks the stale queued-work reducer around per-lifecycle default transition tables and focused state reducers, keeping no-op handling centralized while preserving explicit exceptional transitions.
- Removes the queued provider-context rewrite type assertion by returning typed provider-context rewrite intersections and clarifies the message normalization boundary comments.
- Hardens stale queued-work cleanup across abort, delayed terminal events, and continuation boundaries so stale work is consumed without mutating replacement-goal accounting.
- Tightens runtime continuation scheduling, recovery sequencing, and persistence/accounting handoff behavior with expanded regression coverage around lifecycle edge cases.
- Updates the local pi development baseline to `@earendil-works/*` `0.76.0` and refreshes the npm lockfile.
- Aligns recovery retry classification with Pi 0.76.0 so terminal quota, billing, and provider-limit errors do not stay pending for host retries even when they include `429` wording.
- Validates the cutover with the existing typecheck/test suite plus package metadata and dry-run pack checks.

## 0.1.14 - 2026-05-26

- Widens the package Node engine range to support Node 22.19.0 through Node 26.x.

## 0.1.13 - 2026-05-26

- Bounds hidden goal continuation provider context by superseding older active-goal continuations with short bookkeeping markers, refreshing only the latest continuation, and using compact auto-continuation prompts after `/goal` start or resume.
- Stops provider-error continuation retry storms by skipping immediate hidden requeues on `stopReason: "error"`, auto-compacting on context-window overflow when available, using bounded backoff for transient failures, and pausing with a recoverable `/goal resume` path when recovery is exhausted.
- Makes goal lifecycle transitions terminal and idempotent: duplicate `update_goal complete` calls no longer append extra session entries, completed goals cannot be paused or resumed, and runtime/compaction skips unchanged goal snapshots.
- Coalesces runtime goal persistence so repeated tool completions and unchanged compaction snapshots do not append full goal entries on every event; live footer usage stays current, and turn boundaries, shutdown, budget crossings, and bounded long-run intervals flush pending accounting to session history.
- Allows `create_goal` to replace a completed goal and clarifies recovery via `/goal <objective>` or `/goal clear`.
- Surfaces failed goal tool calls as real pi tool errors by throwing from tool handlers.

## 0.1.12 - 2026-05-23

- Updated the local pi development baseline to `@earendil-works/*` `0.75.5`, refreshed Node/tsx tooling, and regenerated the npm lockfile.
- Reviewed the pi `0.75.5` changelog and package guidance; the goal extension remains compatible with current extension lifecycle and package install/update behavior.

## 0.1.11 - 2026-05-21

- Cancels stale hidden goal continuations before they can reach the model after a goal is completed, cleared, or replaced.
- Keeps stale abort cleanup from charging tokens, pausing active replacement goals, persisting extra entries, or requeueing continuations during compaction and shutdown.
- Allows normal interactive and RPC prompts that paste continuation marker text to pass through instead of being treated as hidden extension follow-up work.
- Adds regression coverage for stale queued work across missing or delayed `agent_end`, late stale terminal events, compaction cleanup, and pasted marker input sources.

## 0.1.10 - 2026-05-18

- Updated the local pi package baseline to `@earendil-works/*` `0.75.3` and refreshed the npm lockfile.
- Removed tracked CueLoop runtime state from the package and ignored local `.cueloop/` artifacts.


## 0.1.9 - 2026-05-09

- Escapes goal objectives in hidden continuation and budget-limit prompts before embedding them in XML-style untrusted blocks.
- Keeps budget-limited goals from being paused or resumed back to active while they remain at or over budget.
- Sends a one-shot hidden budget-limit steering message when token accounting crosses the configured budget.
- Keeps ordinary user prompts from silently reactivating paused goals; session resume now prompts before restarting a paused goal.
- Returns Codex-shaped goal tool responses with `remainingTokens` and completion budget reports.
- Prevents tokens from an old in-flight turn from being charged to a replacement goal.
- Updates `/goal` summary and footer labels toward Codex-style status wording while retaining this package's 8000-character objective limit.

## 0.1.8 - 2026-05-07

- Migrates the local pi development baseline and peer metadata from deprecated `@mariozechner/*` packages to maintained `@earendil-works/*` `0.74.0`.
- Regenerates the npm lockfile against the current stable dependency graph.

## 0.1.7 - 2026-05-07

- Keeps active goals continuing after auto-compaction, including length-stop compactions.
- Prevents stale queued goal continuations from running after a goal is completed or changed.
- Strengthens completion-audit prompts and update-goal guidance so goals are marked complete only after verified completion.
- Avoids duplicate persisted completion entries from `update_goal`.

## 0.1.6 - 2026-05-06

- Clarifies README install commands for npm, pinned npm, GitHub, and pinned GitHub package installs.

## 0.1.5 - 2026-05-06

- Counts goal tokens from completed assistant input plus output usage instead of `usage.totalTokens`.
- Excludes cache read and cache write accounting channels from goal token budgets so cached provider tokens do not inflate sent and received totals.

## 0.1.4 - 2026-05-06

- Pauses active goals when pi reports an aborted assistant turn, including user Esc aborts.
- Resumes paused goals automatically on the next user-driven agent start, while keeping `/goal resume` available.
- Prevents aborted turns from immediately queueing hidden continuation messages.

## 0.1.3 - 2026-05-06

- Corrects the README behavior summary to describe completed assistant turn token accounting.

## 0.1.2 - 2026-05-06

- Counts completed assistant turn usage via pi's `usage.totalTokens` instead of using context-window deltas, so goal token totals track tokens sent and received across compaction.
- Keeps elapsed-time accounting stable before and after compaction while continuing to persist active goal state.

## 0.1.1 - 2026-05-06

- Marks pi runtime peer dependencies as optional so `pi install npm:pi-codex-goal` stays lightweight while still documenting the extension runtime contract.

## 0.1.0 - 2026-05-06

- Initial public release.
- Adds Codex-style `/goal` tracking for pi.
- Adds model-callable `get_goal`, `create_goal`, and `update_goal` tools.
- Persists goal state in pi session custom entries for resume, reload, fork, tree navigation, and compaction.
- Starts and resumes goals with hidden follow-up messages so active objectives keep moving.
- Shows live elapsed active time and compact/exact token counts in the pi footer.
