# AGENTS.md

## Pi Extension Workflow

- This repository is a standalone Pi package for the `pi-codex-core` extension.
- Keep Pi resources declared explicitly in `package.json` under the `pi` manifest.
- Validate changes with `npm run check` before handing off when practical.
- Keep `apply_patch`, `web_run`, `imagegen`, and `view_image` Glowup protocol adapters with their owning tools in this repository. Preserve native renderers alongside passive adapters, and keep the bundled protocol runtime available so this extension still loads when the Glowup extension itself is absent.
- Glowup adapters return semantic protocol nodes only; do not import Pi TUI components, Glowup themes, ANSI helpers, or pi-glowup internal modules.
- Test both native rendering and optional `glowupRendering` paths.
- Keep `src/settings/integration.ts` wire-compatible with Pi Codex Voice's `src/codex-integration-registry.ts`; this versioned global registry is what lets independently installed Codex extensions share one `/codex` command and settings tabs without package dependencies.

## Settings and Session Lifecycle

Keep the existing `src/config` and `src/settings` architecture, shared `/codex` registry, explicit updates, and reload behavior. Glowup’s dependency does not make this extension a direct settings-library consumer. Keep imports free of settings I/O; preserve the current startup configuration boundary and synchronous resource registration. Load new behavior’s settings only where needed.

Gate feature side effects on their resolved configuration. Cancel/dispose owned async work before clearing session state; use the existing recovery and activation owners. Report configuration failures without raw values or secrets. `pi config` is the zero-load switch, preventing import and registration.

Native renderers receive `ToolRenderContext`, not `ExtensionContext`: return components even for history before activation, using arguments/results and renderer state without settings I/O or retained execution contexts. Keep passive Glowup adapters on their protocol contract. Guard dialogs/notifications with `ctx.hasUI` and terminal UI with `ctx.mode === "tui"`.

Preserve the current configuration owner; these instructions do not require a settings-library migration. If adopting `@zigai/pi-extension-settings` as part of a requested change, follow its `docs/manual-setup.md` and `docs/runtime.md`.

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

Keep README/configuration docs user-facing, without lifecycle or schema implementation details. Show one global path sentence (`~/.pi/agent/pi-codex-core/config.json`), a compact table of actual editable keys/dot paths, and the complete default JSON, including `$schema` when scaffolded. Do not invent defaults. Put useful project-override details only in a dedicated Advanced section of `docs/configuration.md`, not the README.

## Pi Extension Configuration

- If the extension needs user-configurable behavior, store persistent runtime settings as JSON files, not Pi core `settings.json` or YAML/TOML/TypeScript config.
- Use `getAgentDir()/<extension-id>/config.json` for user-owned global config and trusted `ctx.cwd/CONFIG_DIR_NAME/<extension-id>/config.json` for user-owned project overrides.
- Import `getAgentDir()` and `CONFIG_DIR_NAME` from `@earendil-works/pi-coding-agent`; do not hardcode Pi agent paths.
- Parse config at the boundary: read JSON with `JSON.parse` into `unknown`, then decode with TypeBox before passing typed config inward.
- Keep checked-in `config.schema.json` synchronized with the TypeBox schema and default config values, including top-level JSON Schema metadata.
- Scaffold default global `config.json` only when missing, include `"$schema": "./config.schema.json"`, and never overwrite existing or malformed user config.
- Treat `config.schema.json` as extension-owned: write it when missing and refresh it when the installed extension schema content is stale.
- Never auto-create project config; read trusted project config only when already present.
- Use environment variables only for secrets, CI/session overrides, or explicit config-path overrides.
