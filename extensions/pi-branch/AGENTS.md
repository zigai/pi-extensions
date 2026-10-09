# AGENTS.md

## Pi Package Workflow

- Keep the extension entrypoint declared explicitly in `package.json` under `pi.extensions`.
- Keep Pi-bundled imports in `peerDependencies` with `"*"` and in `devDependencies` for local checks only.
- Bundle `pi-typed-args` because Pi packages do not share module roots at runtime.
- Keep the package allowlist and package verification check current when adding published files.
- Validate changes with `just check` before handing off.

## Settings and Session Lifecycle

Keep the configuration owned by `index.ts`; this extension does not directly use `@zigai/pi-extension-settings`. Register `/branch` synchronously and load configuration in its command callback, not during import or registration. Preserve the existing reload boundary rather than adding a session cache.

Guard dialogs/notifications with `ctx.hasUI` and terminal UI with `ctx.mode === "tui"`. Dispose owned session resources before clearing state; cancel async work and reject stale results when adding session-bound operations.

Preserve the current configuration owner; these instructions do not require a settings-library migration. If adopting `@zigai/pi-extension-settings` as part of a requested change, follow its `docs/manual-setup.md` and `docs/runtime.md`.

## README Configuration Docs

Document the global configuration with a table of actual editable keys and one complete default JSON example, including `$schema` when scaffolded. Include all defaults, invent none, and omit project overrides and schema implementation prose.
