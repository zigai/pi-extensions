# AGENTS.md

## Pi Extension Workflow

- This repository is a standalone Pi package for the `pi-codex-core` extension.
- Keep Pi resources declared explicitly in `package.json` under the `pi` manifest.
- Validate changes with `npm run check` before handing off when practical.
- Keep `apply_patch`, `web_run`, `imagegen`, and `view_image` Glowup protocol adapters with their owning tools in this repository. Preserve native renderers alongside passive adapters, and keep the bundled protocol runtime available so this extension still loads when the Glowup extension itself is absent.
- Glowup adapters return semantic protocol nodes only; do not import Pi TUI components, Glowup themes, ANSI helpers, or pi-glowup internal modules.
- Preserve each tool's native Pi renderer alongside its optional `glowupRendering` adapter, and test both paths.
- Keep `src/settings/integration.ts` wire-compatible with Pi Codex Voice's `src/codex-integration-registry.ts`; this versioned global registry is what lets independently installed Codex extensions share one `/codex` command and settings tabs without package dependencies.

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

- README and `docs/configuration.md` configuration docs are user-facing: explain available settings and examples, not implementation lifecycle.
- Add a Configuration section only when the extension has meaningful user-facing settings.
- README configuration sections must use one short global config path sentence, a compact option table, and one JSON block showing the full scaffolded default config.
- README and `docs/configuration.md` Configuration/Settings JSON blocks must show the full default config, not partial overrides; do not omit default-valued settings.
- Include `"$schema"` in JSON examples when the scaffolded default config includes it, but do not explain it in prose.
- Option tables should list actual user-editable setting keys, preferably dot paths like `tools.webSearch`; avoid vague category rows such as `tools`, `openai`, or `appearance` unless that object is edited as a single meaningful value.
- If a setting has no default, document it in the option table but do not invent a value for it in JSON.
- In README configuration sections, mention only the global path `~/.pi/agent/pi-codex-core/config.json`; do not mention trusted project overrides or project-specific config paths.
- `docs/configuration.md` may include advanced project override details only in a dedicated Advanced section when they are genuinely useful.
- Do not mention TypeBox, `getAgentDir()`, `CONFIG_DIR_NAME`, schema refresh mechanics, user-owned/extension-owned terminology, or malformed-config overwrite policy in README/config docs.
- Keep lifecycle implementation policy in `AGENTS.md`, tests, and source code rather than user docs.

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
