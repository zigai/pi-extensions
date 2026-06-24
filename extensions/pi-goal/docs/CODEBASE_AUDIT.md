# Codebase Audit — pi-codex-goal

**Date:** 2026-06-24
**Scope:** Full repository (`src/`, `test/`, package metadata, docs, platform-smoke operability)
**Baseline:** `0.1.30` checkout against Pi `0.80.2`
**Local gate:** `npm run verify`

## Executive summary

The package is in **good structural health**. Core behavior is split across focused runtime modules: controller wiring, event handlers, state transitions, recovery, stale queued-work cleanup, persistence, prompt generation, and platform-smoke tooling. TypeScript remains strict, the package keeps pi runtime dependencies optional wildcard peers, and the local plus Crabbox gates are broad.

No critical or high-severity structural defects were found in the 2026-06-24 Pi 0.80.2 audit. The runtime was verified against installed Pi 0.80.2 types/CLI/docs: tool/event/command APIs, `/compat` imports, lifecycle boundaries, project-trust handling, prompt-guideline dedup, and extension tax are all clean. Required work was release/docs fidelity only: align the dev baseline to the installed `0.80.2` runtime, stop hard-coding the published npm version in the README, curate the already-published `0.1.30` changelog, and document the intentional steady-state footer-refresh cost.

## Coverage map

| Area | Status | Evidence |
|------|--------|----------|
| Entry/package metadata | Inspected | `package.json`, `src/index.ts`, `README.md`, `AGENTS.md` |
| Commands/tools | Inspected | `src/commands.ts`, `src/tools.ts`, prompt template metadata |
| Domain/persistence | Inspected | `src/state.ts`, `src/types.ts`, `src/goal-persistence.ts` |
| Runtime lifecycle | Inspected | `goal-runtime-*`, `goal-state-controller.ts`, `goal-transition*.ts` |
| Continuation/queued work | Inspected | `continuation-scheduler.ts`, `queued-goal-*.ts`, `stale-queued-work-*` |
| Recovery | Inspected | `recovery*.ts`, recovery tests |
| Tests/local CI | Inspected and run | `npm run verify` passed; `check:platform-smoke` ran 6 platform-smoke checks and `npm test` ran 304 regular tests |
| Platform smoke | Inspected and run | `scripts/platform-smoke*`, `platform-smoke.config.mjs`, `docs/platform-smoke.md`; full Crabbox `smoke:platform:all` passed on macOS, Ubuntu, and native Windows |
| Security/performance | Sampled only | Secret redaction/artifact checks inspected; no dedicated threat model or profiling performed |

## Current architecture

| Area | Modules |
|------|---------|
| Wiring | `src/index.ts`, `goal-runtime-controller.ts`, `goal-runtime-events.ts` |
| User/model API | `commands.ts`, `tools.ts`, `prompts.ts`, `format.ts`, `prompts/create-goal.md` |
| Domain | `state.ts`, `types.ts`, `goal-persistence.ts` |
| Runtime lifecycle | `goal-runtime-*-handlers.ts`, `goal-runtime-state.ts`, `goal-runtime-status.ts` |
| Transitions | `goal-transition.ts`, `goal-transition-effects.ts`, `goal-state-controller.ts` |
| Continuations | `continuation-scheduler.ts`, `queued-goal-work.ts`, `queued-goal-messages.ts` |
| Stale queued-work cleanup | `stale-queued-work-*.ts` |
| Recovery | `recovery.ts`, `recovery-machine.ts`, `recovery-runtime.ts`, `recovery-phase.ts`, `recovery-adapters.ts` |
| Platform smoke | `scripts/platform-smoke.mjs`, `scripts/platform-smoke/*`, `platform-smoke.config.mjs` |

## Findings by priority

```text
[🟡 Medium] [Documentation/source of truth] docs/CODEBASE_AUDIT.md
- Problem: The previous active audit still described the 0.1.15 baseline and 284-test suite while README called it the latest structural audit.
- Evidence: package.json version 0.1.26; README linked this file as latest; npm run verify passed 307 tests in the audit session.
- Impact: Refactor/release planning could rely on stale coverage and architecture notes.
- Blast radius: Contributor handoff docs, release confidence, future queue planning.
- Fix: Replaced this file with a current 0.1.26 audit baseline and explicit gaps.
```

```text
[🔵 Low] [Verification] package.json
- Problem: test/platform-smoke.test.ts was executed once by check:platform-smoke and again by npm test during npm run verify.
- Evidence: package.json check:platform-smoke explicitly ran the platform-smoke test file; npm test globbed test/*.test.ts.
- Impact: Wasted local CI time and unclear ownership of platform-smoke assertions.
- Blast radius: Local CI and release prep.
- Fix: Platform-smoke assertions now live in test/platform-smoke.check.ts and are run only by check:platform-smoke.
```

```text
[🔵 Low] [Architecture] src/goal-runtime-events.ts
- Problem: Event registration imported the full GoalRuntimeController type, creating a type-only back edge to the controller.
- Evidence: goal-runtime-controller.ts imports registerGoalRuntimeEvents; the registrar only needs event handler methods.
- Impact: Minor boundary leak and misleading dependency graph.
- Blast radius: Runtime wiring readability.
- Fix: registerGoalRuntimeEvents now accepts GoalRuntimeEventHandlers from the event handler type module.
```

## Systemic patterns

- **Good:** Runtime side effects are mediated through transition planning and effect handlers, which keeps state mutation and persistence decisions explicit.
- **Good:** Stale queued-work and recovery behavior is tested heavily against delayed terminal events, context aborts, provider errors, compaction, and shutdown.
- **Good:** Platform-smoke tooling validates packed-package install/list behavior and model-backed runtime behavior, not just source-tree shortcuts.
- **Watch:** Source-of-truth docs must be refreshed when release-sensitive platform/runtime changes land; otherwise README/AGENTS links can point to stale confidence claims.
- **Fixed in 0.1.28 prep:** Pi 0.79.10 `session_compact.willRetry` is now part of the continuation decision, so host overflow retry compactions do not schedule extension fallback continuations.

## Remediation roadmap

### Completed in prior queue-drain pass

- [x] Refresh this audit to the `0.1.26` baseline.
- [x] Keep README/AGENTS audit links aligned with the current-vs-historical source of truth.
- [x] Remove duplicate platform-smoke test execution from `npm run verify`.
- [x] Narrow the event registrar type dependency to `GoalRuntimeEventHandlers`.

### Completed in the 0.1.28 Pi 0.79.10 refresh

- [x] Update the local Pi dev baseline and README compatibility note to Pi 0.79.10 on Node 24.
- [x] Use `session_compact.willRetry` to skip extension fallback continuations while the host will retry an overflow turn.
- [x] Refresh compact/shutdown test fixtures to include `reason`, `willRetry`, and shutdown `reason`.
- [x] Fix native Windows platform-smoke coverage for fake `.cmd` Crabbox wrappers and warmup failure redaction assertions.

### Ongoing release-sensitive gate

- Run `npm run verify` before ending ordinary development work.
- Run the local Crabbox platform gate for release-sensitive changes:
  - `npm run check:platform-smoke`
  - `npm run smoke:platform:all`

## Validation evidence

- `npm run verify` passed under Pi 0.80.2: typecheck, 6 platform-smoke checks, and 304 regular tests.
- `npm run smoke:platform:doctor` passed with Crabbox 0.33.0 and model auth for `zai/glm-5.2`.
- `npm run smoke:platform:all` passed on macOS, Ubuntu Linux, and native Windows. The gate ran `platform-build` and `goal-runtime-smoke`, packed the package, installed it into isolated projects with `--approve`, checked `pi list`, and completed real model-backed goal-tool smokes.
- `npm pack --dry-run --json` is covered by `check:platform-smoke` and showed the package includes source, docs, platform-smoke scripts/config, prompts, and excludes local artifact directories.
- `npm audit --omit=optional` found 0 vulnerabilities after lockfile refresh.

## Assumptions, gaps, and blocked checks

- Security review was limited to structural inspection of artifact/secret hygiene and package contents; no dedicated threat model was performed.
- Performance was not profiled; event-driven paths and persistence coalescing did not show obvious structural performance risks.
