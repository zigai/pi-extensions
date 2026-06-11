# Codebase Audit — pi-codex-goal

**Date:** 2026-06-10
**Scope:** Full repository (`src/`, `test/`, package metadata, docs, platform-smoke operability)
**Baseline:** `0.1.26` on the local checkout after platform-smoke/read-tool smoke hardening
**Local gate:** `npm run verify`

## Executive summary

The package is in **good structural health**. Core behavior is split across focused runtime modules: controller wiring, event handlers, state transitions, recovery, stale queued-work cleanup, persistence, prompt generation, and platform-smoke tooling. TypeScript remains strict, the package keeps pi runtime dependencies optional wildcard peers, and the local gate is broad.

No critical or high-severity structural defects were found in the 2026-06-10 audit. The meaningful findings were source-of-truth drift in this audit document, duplicated local execution of the platform-smoke test file, and a low-risk type-only event-registration back edge. Those findings were decomposed into CueLoop tasks and remediated in the queue-drain pass.

## Coverage map

| Area | Status | Evidence |
|------|--------|----------|
| Entry/package metadata | Inspected | `package.json`, `src/index.ts`, `README.md`, `AGENTS.md` |
| Commands/tools | Inspected | `src/commands.ts`, `src/tools.ts`, prompt template metadata |
| Domain/persistence | Inspected | `src/state.ts`, `src/types.ts`, `src/goal-persistence.ts` |
| Runtime lifecycle | Inspected | `goal-runtime-*`, `goal-state-controller.ts`, `goal-transition*.ts` |
| Continuation/queued work | Inspected | `continuation-scheduler.ts`, `queued-goal-*.ts`, `stale-queued-work-*` |
| Recovery | Inspected | `recovery*.ts`, recovery tests |
| Tests/local CI | Inspected and run | `npm run verify` passed with 307 tests before remediation; after remediation, platform-smoke checks are owned by `check:platform-smoke` and 302 tests remain under `npm test` |
| Platform smoke | Inspected, local syntax/unit gate run | `scripts/platform-smoke*`, `platform-smoke.config.mjs`, `docs/platform-smoke.md`; full Crabbox `smoke:platform:all` not run in this audit |
| Security/performance | Sampled only | Secret redaction/artifact checks inspected; no dedicated threat model or profiling performed |

## Current architecture

| Area | Modules |
|------|---------|
| Wiring | `src/index.ts`, `goal-runtime-controller.ts`, `goal-runtime-events.ts` |
| User/model API | `commands.ts`, `tools.ts`, `prompts.ts`, `format.ts` |
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

## Remediation roadmap

### Completed in the queue-drain pass

- [x] Refresh this audit to the `0.1.26` baseline.
- [x] Keep README/AGENTS audit links aligned with the current-vs-historical source of truth.
- [x] Remove duplicate platform-smoke test execution from `npm run verify`.
- [x] Narrow the event registrar type dependency to `GoalRuntimeEventHandlers`.

### Ongoing release-sensitive gate

- Run `npm run verify` before ending ordinary development work.
- Run the local Crabbox platform gate for release-sensitive changes:
  - `npm run check:platform-smoke`
  - `npm run smoke:platform:all`

## Validation evidence

- `npm run verify` passed before remediation with 307 tests.
- `npm run verify` passed after remediation: `check:platform-smoke` ran 5 platform-smoke checks once, and `npm test` ran 302 regular tests.
- `npm pack --dry-run --json` showed the package includes source, docs, platform-smoke scripts/config, prompts, and excludes local artifact directories.

## Assumptions, gaps, and blocked checks

- Full Crabbox `npm run smoke:platform:all` was not run during the audit; use it for release-sensitive changes.
- Security review was limited to structural inspection of artifact/secret hygiene and package contents; no dedicated threat model was performed.
- Performance was not profiled; event-driven paths and persistence coalescing did not show obvious structural performance risks.
