# AGENTS.md

## Work and Verify

Keep Pi resources in `package.json.pi`, descriptions in `package.json.description`, and the default `ExtensionAPI` factory in `src/index.ts`. Use Pi's extension APIs without modifying installed Pi source. Keep Pi-host packages and TypeBox as `"*"` peers and development dependencies, never bundled.

Run `just setup` after cloning, `just check` before handoff, and `just coverage` when needed. Keep pre-commit enabled with `config:check` first; verify visual changes in a real tmux/TTY, not only snapshots.

## Extension Settings

- **Author:** edit TypeBox schema/metadata in `src/settings-input.ts`; no Pi runtime, generated-artifact imports, I/O, or feature initialization. Use a closed root (`additionalProperties: false`), user-facing descriptions, valid defaults, codecs for transformations, and `StaticDecode` for resolved types—not duplicate interfaces/casts. Add realistic, secret-free partial `exampleSettings` only when useful; give complex array-item/record-value objects PascalCase titles for readable docs.
- **Generate:** declare and publish `src/settings-input.ts`, `src/settings.prevalidated.ts`, `config.schema.json`, and `README.md` through `package.json.piExtensionSettings`. Run `npm run config:generate` after authoring changes; commit outputs, never hand-edit generated artifacts/README region. Gate pre-commit/CI with `npm run config:check`.
- **Load:** keep `@zigai/pi-extension-settings` a normal runtime dependency, not bundled. Use its root for authoring, `/runtime` for `definePrevalidatedExtensionSettings` hydration in `src/settings.ts`, and `/pi` for `loadPiExtensionSettings`/updates. Features call the existing `load<ExtensionName>Settings` boundary; no duplicate parsing or hardcoded Pi paths. Keep settings in `settings` modules, not parallel `config.ts`/one-file `config/` modules.
- **Resolve:** defaults → global → trusted project; objects merge, arrays/scalars replace. The loader owns paths/trust, schema refresh, and missing-global scaffolding; never overwrites settings or auto-creates project settings. Invalid layers are ignored, untouched, and diagnosed without values/secrets. Environment variables are only for secrets, CI/session or explicit path overrides; JSON is not secret storage.
- **Update:** load first, then use `updatePiExtensionSettings()` with a synchronous, deterministic, side-effect-free callback over the latest encoded layer. Pass `globalRevision`/`projectRevision` as `expectedRevision` for snapshot edits; omit for semantic updates. Handle every typed outcome. Explicit trusted-project updates may create project settings; invalid files remain untouched. No direct writers or extra mutation queue.
- **Document:** the generator owns the single README settings region: global path, editable-key table, complete defaults including `$schema` (no invented optional values). Keep library/lifecycle mechanics out. For details, read the installed package's `docs/manual-setup.md`, `docs/runtime.md`, and `docs/generation.md`.

## Settings Lifecycle

- Keep import and the synchronous factory free of settings I/O. Session activation owns policy loading and service replacement/cleanup; retain the recovery command when policy is disabled.
- Keep activation results, including disabled/rejected settings, session-owned and report settings diagnostics once per activation when `ctx.hasUI`. Preserve effective-policy refreshes on input and explicit edits, plus session policy restoration across reload/resume; do not replace this with a reload-only cache.
- Dispose owned resources before clearing state on shutdown/reload. Add cancellation/stale-result protection for actual async work, not a generic lifecycle framework. `pi config` prevents import and registration entirely.
- Renderers receive `ToolRenderContext`, not `ExtensionContext`: use arguments, results, and presentation state, never settings I/O, notifications, or a retained execution context. Always return a component, including history rendered before activation.

## Implementation Notes

- Keep user/LLM-facing descriptions on registered tools, commands, flags, and shortcuts.
- Tool `promptGuidelines` are appended flat to Pi's system prompt; every guideline must name the exact tool it refers to.
- If an extension starts timers, intervals, file watchers, sockets, or subprocesses after `session_start`, clean them up in `session_shutdown` and during reload.
- If a custom tool mutates files, use Pi's file mutation queue around the whole read-modify-write window.
- Custom tools must truncate large output and tell the model where any full output was saved.
- Use `StringEnum` from `@earendil-works/pi-ai` for model-facing string enums instead of `Type.Union` of literals.
- Use `ctx.mode === "tui"` before terminal-only UI work and `ctx.hasUI` before dialogs/notifications.
