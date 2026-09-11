# pi-codex-goal — agent notes

Pi extension: Codex-style `/goal` command and `get_goal` / `create_goal` / `update_goal` tools. State lives in pi session custom entries.

Keep the passive Glowup protocol adapters for all three goal tools beside their owning contracts in this repository. Preserve native behavior when Glowup is not active, parse restored arguments/results at the adapter boundary, and never import Glowup internals or TUI implementation modules.

## Settings and Session Lifecycle

Keep `src/goal-settings.ts` and the runtime controller as the settings owners; Glowup’s dependency does not make this extension a direct settings-library consumer. Register tools and commands synchronously without settings I/O. Goal behavior begins at `session_start`: reset session state, then load settings there. Preserve explicit updates and reload behavior, and gate feature effects on resolved configuration.

Cancel/dispose owned async work before clearing session state; preserve the existing recovery, stale-work rejection, and continuation lifecycle rather than introducing another framework. Report configuration failures without raw values or secrets. `pi config` prevents import and registration entirely.

Native renderers receive `ToolRenderContext`, not `ExtensionContext`: return components even for history before activation, using arguments/results and renderer state without settings I/O or retained execution contexts. Keep passive Glowup adapters on their protocol contract. Guard dialogs/notifications with `ctx.hasUI` and terminal UI with `ctx.mode === "tui"`.

Preserve the current configuration owner; these instructions do not require a settings-library migration. If adopting `@zigai/pi-extension-settings` as part of a requested change, follow its `docs/manual-setup.md` and `docs/runtime.md`.

## Local pi install policy

On this machine, the canonical active install is the global/user package pointing at this local checkout:

```text
../../Projects/AI/pi-codex-goal
```

Do not leave project-local installs of this package in this repo. In particular, avoid release verification commands such as:

```sh
pi install -l npm:pi-codex-goal
pi install -l https://github.com/fitchmultz/pi-codex-goal@vX.Y.Z
```

Those write duplicate package entries under `.pi/` for the current project, causing `get_goal`, `create_goal`, and `update_goal` tool-registration conflicts with the global local-checkout install. For install-path release verification, use an isolated temp project/config directory or remove the project-local entries immediately after the check. With Pi 0.79+ project trust, pass `--approve` for isolated project-local package install/list/non-interactive smoke commands when those commands must load `.pi/settings.json`. If conflicts appear, inspect `pi list --approve` and `.pi/settings.json`, then remove any project-local `pi-codex-goal` npm/GitHub installs so only the global local-checkout package remains active.

## Verify before finishing

```sh
npm run verify
```

Runs `tsc --noEmit`, the platform-smoke harness checks, and the full Vitest suite (`test/*.test.ts`).

For release-sensitive changes, also use the local Crabbox platform gate documented in `docs/platform-smoke.md`:

```sh
npm run check:platform-smoke
npm run smoke:platform:all
```

`smoke:platform:all` runs `smoke:platform:doctor` before any target suite starts.

The required gate runs the full suite plus a real model-backed goal-tool smoke on macOS, Ubuntu Linux, and native Windows. The default smoke model is `zai/glm-5.2`; override with `PLATFORM_SMOKE_MODEL` when needed.

## Layout

| Area                | Modules                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Wiring              | `src/index.ts`, `goal-runtime-controller.ts`                                                   |
| User / model API    | `commands.ts`, `tools.ts`, `prompts.ts`, `format.ts`, `clipboard.ts`, `prompts/create-goal.md` |
| Runtime events      | `goal-runtime-event-handlers.ts`, `goal-runtime-*-handlers.ts`                                 |
| Transitions         | `goal-transition.ts`, `goal-transition-effects.ts`, `goal-state-controller.ts`                 |
| Stale continuations | `stale-queued-work-*.ts`                                                                       |
| Recovery            | `recovery*.ts`                                                                                 |
| Domain              | `state.ts`, `types.ts`, `goal-persistence.ts`                                                  |

Current structural audit and remediation record: `docs/CODEBASE_AUDIT.md`.
