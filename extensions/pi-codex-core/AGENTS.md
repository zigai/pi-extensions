# AGENTS.md

## Pi Extension Workflow

- This workspace is an independently installable Pi package for the `pi-codex-core` extension.
- Keep Pi resources declared explicitly in `package.json` under the `pi` manifest.
- Build dependencies with `npm run build` at the repository root, then validate this workspace with `npm run check` before handing off when practical.
- Keep `apply_patch`, `web_run`, `imagegen`, and `view_image` Glowup protocol adapters with their owning tools in this repository. Preserve native renderers alongside passive adapters, and keep the declared protocol dependency available so this extension still loads when the Glowup extension itself is absent.
- Glowup adapters return semantic protocol nodes only; do not import Pi TUI components, Glowup themes, ANSI helpers, or pi-glowup internal modules.
- Test both native rendering and optional `glowupRendering` paths.
- Keep `src/settings/integration.ts` wire-compatible with Pi Codex Voice's `src/codex-integration-registry.ts`; this versioned global registry is what lets independently installed Codex extensions share one `/codex` command and settings tabs without package dependencies.

## Settings and Session Lifecycle

Keep the existing `src/config` and `src/settings` architecture, shared `/codex` registry, explicit updates, and reload behavior. This workspace directly uses `@zigai/pi-extension-settings` through `src/settings.ts`; keep its exact supported runtime dependency declared. Keep imports free of settings I/O; preserve the current startup configuration boundary and synchronous resource registration. Load new behavior’s settings only where needed.

Gate feature side effects on their resolved configuration. Cancel/dispose owned async work before clearing session state; use the existing recovery and activation owners. Report configuration failures without raw values or secrets. `pi config` is the zero-load switch, preventing import and registration.

Native renderers receive `ToolRenderContext`, not `ExtensionContext`: return components even for history before activation, using arguments/results and renderer state without settings I/O or retained execution contexts. Keep passive Glowup adapters on their protocol contract. Guard dialogs/notifications with `ctx.hasUI` and terminal UI with `ctx.mode === "tui"`.

Preserve the current configuration owner and shared settings integration. Follow `@zigai/pi-extension-settings`'s `docs/manual-setup.md` and `docs/runtime.md` when changing that integration.

## Codex Parity Policy

- Treat the behavior of the pinned Codex CLI release as the baseline for system prompts, tool contracts, and remote compaction request shapes.
- Keep verbatim upstream prompt and tool-description assets byte-for-byte identical, record their tag, commit, source path, and hash in the nearest `UPSTREAM.md`, and adapt them only at runtime for Pi tool names or capabilities.
- Prefer Codex behavior unless Pi lacks the corresponding runtime seam or a deliberate Pi-specific choice is documented here and in the nearest `UPSTREAM.md`.
- Keep automatic compaction at 80% of the active model context. This deliberately compacts earlier than Codex's current 90% threshold to leave headroom for Pi's provider projection and checkpoint replay.
- Keep `openai.compactionReasoning` at `"medium"` by default. Remote compaction must still preserve Codex's model-specific reasoning shape and encrypted reasoning content.
- Keep standalone `web_run` in `"live"` mode by default. Codex stores `"cached"` as its base preference but resolves eligible turns without an outer sandbox to `"live"`; Pi has no equivalent permission-profile resolver.
- Preserve Codex's citation contract: internal search reference IDs are tool-call inputs only, final answers use Markdown links, and Pi's compact tool output removes non-renderable citation markers while retaining explicit source URLs.
- When a future upstream sync would change one of these deliberate defaults or adaptations, preserve the documented Pi behavior unless the user explicitly chooses otherwise.

## User-Facing Configuration Docs

Keep README configuration docs user-facing, without lifecycle or schema implementation details. The generated settings region owns the global path (`~/.pi/agent/extension-settings/pi-codex-core.json`), editable-key table, and default JSON. Update `src/settings-input.ts` and regenerate instead of hand-editing that region. Do not invent defaults.

## Pi Extension Configuration

- Keep persistent runtime settings in the shared settings library's JSON files, not Pi core `settings.json` or YAML/TOML/TypeScript config.
- `src/settings-input.ts` owns the TypeBox schema, defaults, and descriptions; `src/settings.ts` hydrates prevalidation and loads through the library's `/pi` adapter. Do not add parallel config paths or readers.
- Keep the exact supported settings-library runtime dependency and all `piExtensionSettings` artifacts synchronized. Run `npm run config:generate` after definition changes and `npm run config:check` to verify them.
- Parse external data at its boundary, decode with TypeBox, and pass typed values inward. Let the library own Pi paths, schema refresh, and missing-global scaffolding.
- Preserve existing and malformed user files. Read project overrides only when trusted and already present; creating them requires an explicit trusted update.
- Use environment variables only for secrets, CI/session overrides, or explicit config-path overrides.
