# pi-codex-goal — agent notes

Pi extension: Codex-style `/goal` command and `get_goal` / `create_goal` / `update_goal` tools. State lives in pi session custom entries.

## Verify before finishing

```sh
npm run verify
```

Runs `tsc --noEmit`, the platform-smoke harness checks, and the full Node test suite (`test/*.test.ts`).

For release-sensitive changes, also use the local Crabbox platform gate documented in `docs/platform-smoke.md`:

```sh
npm run check:platform-smoke
npm run smoke:platform:all
```

`smoke:platform:all` runs `smoke:platform:doctor` before any target suite starts.

The required gate runs the full suite plus a real model-backed goal-tool smoke on macOS, Ubuntu Linux, and native Windows. The default smoke model is `zai/glm-5.1`; override with `PLATFORM_SMOKE_MODEL` when needed.

## Layout

| Area | Modules |
|------|---------|
| Wiring | `src/index.ts`, `goal-runtime-controller.ts` |
| User / model API | `commands.ts`, `tools.ts` |
| Runtime events | `goal-runtime-event-handlers.ts`, `goal-runtime-*-handlers.ts` |
| Transitions | `goal-transition.ts`, `goal-transition-effects.ts`, `goal-state-controller.ts` |
| Stale continuations | `stale-queued-work-*.ts` |
| Recovery | `recovery*.ts` |
| Domain | `state.ts`, `types.ts`, `goal-persistence.ts` |

Structural audit: `docs/CODEBASE_AUDIT.md`.
