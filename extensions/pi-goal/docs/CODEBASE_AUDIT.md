# Codebase Audit — pi-codex-goal

**Date:** 2026-05-28
**Scope:** Full repository (`src/`, `test/`, package metadata, operability)
**Baseline:** `0.1.15` on `main` after runtime refactor and 0.1.15 release audit remediation (`347b8bd`)

## Executive summary

The package is in **good structural health**. Core behavior is split across focused runtime modules (controller, event handlers, transitions, recovery, stale queued-work state machine, persistence). TypeScript is strict, the test suite is broad (284 tests), and `npm run verify` passes.

This audit found **no critical or high-severity structural defects**. Remaining items were operability/documentation gaps and one maintainability split (stale queued-work default transition tables). Those are addressed on branch `chore/post-0.1.15-codebase-audit`.

## Scope

| Area | Examined |
|------|----------|
| Entry | `src/index.ts` → `goal-runtime-controller.ts` |
| Commands / tools | `commands.ts`, `tools.ts` |
| Domain state | `state.ts`, `types.ts`, `goal-persistence.ts` |
| Runtime lifecycle | `goal-runtime-*`, `goal-state-controller.ts`, `goal-transition*.ts` |
| Continuation / queue | `continuation-scheduler.ts`, `queued-goal-*.ts`, `prompts.ts` |
| Stale work FSM | `stale-queued-work-*.ts` |
| Recovery | `recovery*.ts` |
| Tests | 24 files under `test/`, harness in `test/support/` |
| Config | `package.json`, `tsconfig.json`, `.gitignore` |

## Findings by category

### Architecture and boundaries

```text
[🔵 Low] [Architecture] src/state.ts (~377 lines)
- Problem: Combines validation, mutations, session reconstruction, and equivalence helpers in one module.
- Impact: Slightly higher cognitive load when changing persistence vs. command semantics.
- Blast radius: All goal CRUD, persistence replay, and tool handlers.
- Fix: Acceptable for now; split only if reconstruction or validation grows further. No behavior change required.
```

```text
[🔵 Low] [Architecture] src/stale-queued-work-reducer.ts (~420 lines after defaults extraction)
- Problem: Reducer mixed lifecycle default tables with transition logic (pre-audit).
- Impact: Harder to scan exceptional transitions vs. table-driven defaults.
- Blast radius: Stale continuation abort/cleanup across all runtime paths.
- Fix: Extracted `stale-queued-work-reducer-defaults.ts` (this PR).
```

**Positive patterns (evidence):**

- `goal-runtime-event-handlers.ts` composes four handler modules with narrowed `goal-runtime-event-handler-types.ts` ports.
- `goal-transition.ts` plans transitions; `goal-transition-effects.ts` applies side effects once.
- `stale-queued-work-reducer.ts` uses per-lifecycle default tables and explicit handlers for non-default events.

### Complexity and maintainability

No `TODO`/`FIXME`, no `any`, no `@ts-expect-error`, no `eslint-disable` in `src/`. Exhaustive `switch`/`never` guards are used consistently in reducers and effect applicators.

### Testing and verification

| Signal | Value |
|--------|-------|
| Tests | 284 passing (`npm test`) |
| Typecheck | Strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| Local gate | `npm run verify` |

Coverage is **integration-heavy** via `test/support/runtime-harness.ts` and scenario tests — appropriate for an extension that wires pi session events. Dedicated unit tests exist for transitions, stale queued-work reducer tables, recovery classification, and persistence coalescing.

**Gap (acceptable):** No isolated unit file for `continuation-scheduler.ts` or `goal-runtime-status.ts`; behavior is covered by `test/continuation.test.ts` and footer/command scenarios.

### Configuration and operability

```text
[🟡 Medium] [Operability] README.md (pre-audit)
- Problem: No documented local verification command for contributors/agents.
- Impact: Harder to discover the canonical CI-equivalent check.
- Blast radius: Contributors, agent sessions, release prep.
- Fix: Development section + project `AGENTS.md` (this PR).
```

```text
[🔵 Low] [Operability] .gitignore
- Problem: Local `.debug/` runtime/debug artifacts were not ignored.
- Impact: Risk of accidental commit of session debug artifacts.
- Fix: Ignore `.debug/` (this PR).
```

## Metrics / notable patterns

| Metric | Value |
|--------|-------|
| `src/*.ts` modules | 38 |
| Largest modules (lines) | `stale-queued-work-reducer.ts` ~420, `state.ts` ~377, `queued-goal-work.ts` ~383 |
| Test files | 24 |
| Pi dev baseline | `@earendil-works/*` 0.79.0 |

Dependency graph is acyclic: handlers → controller ports → state/persistence/recovery; stale-work subsystems do not import runtime handlers.

## Remediation roadmap

### Quick wins (done on audit branch)

- [x] Extract stale queued-work reducer default tables
- [x] Document `npm run verify` in README and `AGENTS.md`
- [x] Ignore `.debug/` in `.gitignore`
- [x] Publish this audit in `docs/CODEBASE_AUDIT.md`

### Short-term (optional, not blocking)

- Add a one-line “Contributing” link from README to `docs/CODEBASE_AUDIT.md` if the doc grows follow-up sections.

### Deeper refactors (only if scope expands)

- Split `state.ts` into `goal-domain.ts` + `goal-session-reconstruction.ts` if either half exceeds ~250 lines or gains new concerns.

## Assumptions and open questions

- **Security:** Out of scope; no secrets in repo; objectives are XML-escaped in hidden prompts (`prompts.ts`).
- **CI:** No GitHub Actions in-repo by project convention; local `npm run verify` is the gate.
- **Performance:** Not profiled; hot paths are event-driven with coalesced persistence — no obvious anti-patterns for an extension.

## Definition of done (audit)

- [x] Main subsystems and entrypoints examined
- [x] Findings prioritized with file evidence
- [x] Structural risks separated from style noise
- [x] Practical remediation roadmap with follow-up items executed on branch
