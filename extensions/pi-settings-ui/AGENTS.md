# AGENTS.md

## Work and verification

This Pi package declares resources in `package.json`; `src/index.ts` exports its default `ExtensionAPI` factory. Use Pi's extension APIs without modifying installed Pi source. Put package descriptions in `package.json`, not invented extension metadata.

Run `just setup` after cloning and `just check` before handing off changes (`just coverage` for coverage output). Preserve pre-commit's first `config:check` hook. Verify visual changes in a real tmux/TTY session.

Keep Pi-host packages (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui` under `@earendil-works`, and `typebox`) as `"*"` peers and development dependencies for local checking. Extension-owned libraries belong in runtime dependencies.

## Settings integration

Keep `@zigai/pi-extension-settings` a normal runtime dependency and distinguish this extension's own settings from the catalogs it edits.

- **Author:** `src/settings-input.ts` owns the generation-safe TypeBox schema, defaults, and descriptions. No feature initialization or generated-artifact imports belong there. Derive decoded types with `StaticDecode`; validate external data at its boundary rather than casting it.
- **Load:** `src/settings.ts` owns hydration, the `load<ExtensionName>Settings` loader, and semantic validation. Use the package root for authoring, `/runtime` for `definePrevalidatedExtensionSettings`, and `/pi` for loading/updates. Feature code calls the local loader. Keep this capability flat and named “settings”, without a parallel `config.ts` or one-file config directory.
- **Generate:** declare and publish the input, prevalidation, schema, and README in `piExtensionSettings`. Run `npm run config:generate` after definition changes. Never hand-edit prevalidation, JSON Schema, or the single README settings region. Put wording on schema properties; give complex object items PascalCase titles and use valid non-secret partial examples only when helpful.
- **Respect persistence:** defaults are overlaid by global and trusted-project settings; objects merge and arrays/scalars replace. The library owns Pi paths, missing-global scaffolding, and schema refresh. Loading never overwrites existing settings or creates project files. Invalid layers remain untouched and are reported without their values. Do not duplicate readers or hardcode paths.
- **Write typed settings:** load first, then use `updatePiExtensionSettings()` from `/pi` with a synchronous callback over the latest encoded layer. Handle every typed outcome. Pass `expectedRevision` for snapshot edits and omit it for semantic updates. Project writes require trust. Do not add ad hoc writers, locks, or another mutation queue around this API.

The schema-discovered catalog editor in `src/settings-store.ts` has its own persistence boundary. Preserve its validation, conflict checks, project trust, and malformed-file protection. Pi's core settings use separate adapters; do not replace these boundaries with a typed-definition API that cannot represent them.

Use environment variables only for secrets, CI/session overrides, or explicit path overrides. Keep secrets out of ordinary JSON unless secure storage is deliberately designed. Keep implementation policy outside generated user documentation. Consult the installed settings package's `docs/manual-setup.md`, `docs/runtime.md`, and `docs/generation.md` when changing the integration.

## Lifecycle and UI

Keep settings I/O and editor-only implementation imports out of module loading, the factory, and session-editor installation. `session_start` installs only the lightweight editor wrapper; load this extension's own settings and dynamically import the catalog/editor stack when the user opens the settings UI. Preserve fresh reads for explicit editing and dispose the editor wrapper on shutdown. Do not add a second activation flag or turn explicit editing into a reload-only workflow.

Renderers receive `ToolRenderContext`, not `ExtensionContext`. Render from arguments, results, and renderer state without settings I/O or retained execution contexts. Return a component even before execution/activation and for history. Guard dialogs with `ctx.hasUI` and terminal-only work with `ctx.mode === "tui"`.

Dispose owned timers, watchers, sockets, and subprocesses on reload and shutdown. Deferred loading moves work to first use; `pi config` prevents import and registration entirely.

Give tools, commands, flags, and shortcuts useful descriptions. Tool `promptGuidelines` entries must name their exact tool; Pi appends them flat to the system prompt. Use Pi's `StringEnum` for model-facing enums. Truncate large output with the full-output path. Ordinary file tools use Pi's mutation queue around the complete read-modify-write operation; settings transactions use their owning persistence boundary above.
