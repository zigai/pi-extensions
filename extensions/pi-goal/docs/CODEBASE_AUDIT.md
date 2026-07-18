# Codebase Audit — pi-codex-goal

**Date:** 2026-07-01
**Scope:** Full repository (`src/`, `test/`, package metadata, docs, platform-smoke operability)
**Baseline:** `0.1.33` checkout against Pi `0.80.3`
**Local gate:** `npm run verify`
**Hosted CI:** GitHub Actions runs `npm ci` and `npm run verify` on Node 24 for `push` and `pull_request`
**Release platform gate:** local Crabbox `npm run smoke:platform:all`

> Historical record: this audit describes the 0.1.33 command contract. The current command surface
> has since consolidated creation into `/goal`, removed `copy`, `clear`, `resume cancel`, and token
> budgets, and added typed form-only active-time constraints, advanced goal adjustment,
> settings-based active-goal tool restrictions, and a resumable `blocked` state. See `README.md` and current tests for the active
> contract; command-discoverability findings below are retained as audit history.

## Executive summary

The package remains in **good structural health**. The core runtime is split across focused modules for command/tool API, state transitions, runtime events, stale queued-work cleanup, recovery, persistence, and platform-smoke tooling. No critical or high-severity defects were found in this audit.

This pass fixed the low-risk drift and code-judo findings that had clear, behavior-preserving remedies: runtime boundary/resume consolidation, stale queued-work simplification, platform-smoke script consolidation, prompt contract consolidation, duplicate prompt budget rendering, command discoverability gaps, redundant transition validation, one dead export, a double-cloning goal lookup, and the minimal hosted CI workflow.

The ordinary hosted CI workflow is intentionally smaller than the release gate: it runs `npm run verify` on Node 24 only. The full local Crabbox `npm run smoke:platform:all` matrix remains the release-sensitive proof and passed in this release pass.

## Coverage map

| Area                      | Status                        | Evidence                                                                                                         |
| ------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Entry/package metadata    | Inspected                     | `package.json`, `src/index.ts`, `README.md`, `AGENTS.md`                                                         |
| Commands/tools            | Inspected and fixed           | `src/commands.ts`, `src/tools.ts`, `src/format.ts`, `test/commands.test.ts`, `test/state.test.ts`                |
| Prompt contracts          | Inspected and fixed           | `src/prompts.ts`, `prompts/create-goal.md`, `test/prompts.test.ts`                                               |
| Domain/persistence        | Inspected                     | `src/state.ts`, `src/types.ts`, `src/goal-persistence.ts`, persistence/state tests                               |
| Runtime lifecycle         | Inspected and partially fixed | `goal-runtime-*`, `goal-state-controller.ts`, runtime/recovery tests                                             |
| Transitions               | Inspected and fixed           | `goal-transition.ts`, `goal-transition-effects.ts`, `test/goal-transition.test.ts`                               |
| Continuations             | Inspected                     | `continuation-scheduler.ts`, `queued-goal-work.ts`, `queued-goal-messages.ts`                                    |
| Stale queued-work cleanup | Inspected and partially fixed | `stale-queued-work-*`, stale queued-work tests                                                                   |
| Recovery                  | Inspected                     | `recovery*.ts`, recovery tests                                                                                   |
| Platform smoke            | Inspected and fixed           | `scripts/platform-smoke*`, `platform-smoke.config.mjs`, `docs/platform-smoke.md`, `test/platform-smoke.check.ts` |
| Hosted CI                 | Added                         | `.github/workflows/verify.yml` runs Node 24 `npm ci` and `npm run verify` on `push` and `pull_request`           |
| Security/performance      | Sampled only                  | Secret/artifact hygiene checks inspected; no dedicated threat model or profiling performed                       |

## Findings by priority

```text
[🟡 Medium] [Runtime boundary] src/goal-state-controller.ts, src/goal-transition.ts, src/goal-runtime-session-handlers.ts
- Problem: Runtime memory effects and resume continuation paths were split across transition, state-controller, command, auto-resume, and session-resume code.
- Evidence: `reloadGoalRuntimeEffects` is now exported from `src/goal-transition.ts` and covered by transition tests; `resumeGoalWithContinuation` is now the shared resume helper for command, provider-limit auto-resume, and session-resume confirmation.
- Impact: Reload/resume behavior now has one smaller contract to regression-test.
- Blast radius: Runtime recovery, session reload, provider-limit/manual resume.
- Fix: Fixed in this session.
```

```text
[🟡 Medium] [Stale queued-work maintainability] src/stale-queued-work-reducer.ts, src/stale-queued-work-guard.ts, src/stale-queued-work-obligations.ts
- Problem: The stale queued-work state machine had duplicated lifecycle branches, pass-through wrappers, and parallel anonymous terminal consumers.
- Evidence: Shared reducer defaults/helpers now cover repeated lifecycle handling, anonymous terminal consumption is centralized, and the unused `terminalCleanupFromObserving` export is gone.
- Impact: Stale terminal cleanup and abort release behavior have fewer duplicated branches to keep aligned.
- Blast radius: Replacement goals, stale hidden continuations, abort cleanup after late terminal events.
- Fix: Fixed in this session.
```

```text
[🟡 Medium] [Platform operability] scripts/platform-smoke/targets.mjs, scripts/platform-smoke/platform-build-windows.ps1, test/platform-smoke.check.ts
- Problem: Platform-build behavior was maintained in separate POSIX shell and PowerShell implementations, while smoke script inventories and marker expectations were repeated in tests/scripts.
- Evidence: `scripts/platform-smoke/platform-build.mjs` now owns the suite body for all targets, the Windows PowerShell file is a thin wrapper, `script-inventory.mjs` feeds the cheap checks, and `package.json` delegates `check:platform-smoke` to `check.mjs`.
- Impact: Platform smoke has one build-suite path and less source-text drift in the cheap check.
- Blast radius: Release validation on macOS, Ubuntu, and native Windows.
- Fix: Fixed in this session.
```

```text
[🟡 Medium] [Prompt/source-of-truth] src/prompts.ts, prompts/create-goal.md, test/package-manifest.test.ts
- Problem: Completion-audit guidance existed in multiple authored surfaces.
- Evidence: `src/prompts.ts` now exports canonical completion-audit guideline/continuation sections, and prompt tests assert those sections appear in tool guidance and continuation prompts.
- Impact: Model-facing completion rules have a smaller source of truth for runtime prompt surfaces.
- Blast radius: Model behavior around `update_goal` completion.
- Fix: Fixed in this session for runtime prompt surfaces; static markdown prompt alignment remains test-enforced rather than imported at runtime.
```

```text
[🔵 Low] [Command discoverability] src/commands.ts, src/format.ts
- Problem: `/goal` summary hints and completions lagged the documented command surface.
- Evidence: Hints omitted `/goal copy`; completions omitted `resume cancel` even though commands and README documented it.
- Impact: Users could miss safe command actions.
- Blast radius: `/goal` command UX only.
- Fix: Fixed. Hints now include `/goal copy`; completions include `resume cancel`; tests cover both.
```

```text
[🔵 Low] [Transition/readability] src/goal-transition.ts, src/goal-state-controller.ts
- Problem: Runtime-accounting validation had a redundant paused/complete branch, and `isCurrentActiveGoalId` called `getGoal()` twice.
- Evidence: The second validation branch already rejected every non-`active`/`budgetLimited` status; `getGoal()` clones snapshots.
- Impact: Small avoidable branch/read cost in hot runtime checks.
- Blast radius: Runtime accounting validation and active-goal ID checks.
- Fix: Fixed. Validation uses the canonical status set once; active-goal checks read one snapshot.
```

```text
[🔵 Low] [Dead API surface] src/stale-queued-work-terminal-cleanup.ts
- Problem: `terminalCleanupFromObserving` was exported but unused.
- Evidence: Repo-wide reference search found no importers.
- Impact: Misleading stale queued-work helper surface.
- Blast radius: None at runtime.
- Fix: Fixed. Removed the export.
```

```text
[🔵 Low] [CI] repository root
- Problem: No in-repo automated CI workflow existed.
- Evidence: `.github/workflows/verify.yml` runs Node 24, `npm ci`, and `npm run verify` on `push` and `pull_request`.
- Impact: PR/push checks now have ordinary hosted CI coverage without secrets or platform-matrix claims.
- Blast radius: Contributor/release workflow.
- Fix: Fixed in this session. Crabbox remains a local release gate, not hosted CI.
```

## Systemic patterns

- **Good:** Transition planning, persistence, recovery, and stale queued-work logic are heavily tested and mostly split by concern.
- **Good:** No source file is near the 1k-line presumptive-blocker threshold.
- **Good:** Runtime side effects are mostly explicit through transition effects and recovery machines.
- **Watch:** Stale queued-work cleanup remains the densest state-machine area; future edits still need the full stale-work test suite, not piecemeal checks.
- **Watch:** Hosted CI is ordinary `npm run verify` coverage only; do not treat it as proof that the local Crabbox release matrix passed.
- **Watch:** Prompt contract text is centralized for runtime prompt surfaces; keep static markdown prompt alignment covered by tests.

## Remediation roadmap

### Completed in this audit pass

- [x] Share runtime memory-effect derivation between transitions and session reload.
- [x] Route command resume, provider-limit auto-resume, and session resume confirmation through the shared resume+continuation helper.
- [x] Simplify stale queued-work lifecycle and anonymous terminal-consumer duplication.
- [x] Remove unused `terminalCleanupFromObserving` export.
- [x] Consolidate platform-build POSIX/PowerShell behavior into one Node orchestrator with a thin Windows wrapper.
- [x] Single-source platform-smoke script inventory for cheap checks.
- [x] Consolidate completion-audit prompt contract text for runtime prompt surfaces.
- [x] Consolidate repeated prompt Budget lines behind one helper.
- [x] Remove redundant runtime-accounting validation branch.
- [x] Avoid double goal snapshot reads in `isCurrentActiveGoalId`.
- [x] Add `/goal copy` to summary hints for all goal states.
- [x] Add `resume cancel` command completion coverage.
- [x] Add minimal GitHub Actions hosted CI for Node 24 `npm ci` plus `npm run verify` on `push` and `pull_request`.
- [x] Refresh this audit record to the `0.1.33` baseline.

### Release-sensitive verification

- [x] Run full local Crabbox `npm run smoke:platform:all` before release-sensitive platform claims.

## Validation evidence

- `npm run verify` passed under Node/Pi local dev setup: TypeScript typecheck, 6 platform-smoke checks, and 318 regular tests.
- `npm run smoke:platform:all` passed under Pi 0.80.3: doctor, macOS, Ubuntu, and native Windows target suites.
- `.github/workflows/verify.yml` was added for ordinary hosted CI: Node 24, `npm ci`, `npm run verify`, `push`, and `pull_request`.

## Assumptions, gaps, and blocked checks

- Security review was limited to structural inspection of artifact/secret hygiene and package contents; no dedicated threat model was performed.
- Performance was not profiled; no obvious structural performance risk surfaced beyond small snapshot/timer cleanup opportunities.
- Hosted CI validation does not prove the local Crabbox release matrix; keep that evidence separate.
