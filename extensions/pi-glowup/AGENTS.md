# AGENTS.md

## Pi Extension Workflow

- This repository is a standalone Pi package for the `pi-codex-look` extension.
- Keep Pi resources declared explicitly in `package.json` under the `pi` manifest.
- The extension entrypoint is `src/index.ts` and must export a default factory that receives Pi's `ExtensionAPI`.
- Do not edit Pi's installed source code. Use Pi's public extension API and exported SDK helpers.
- Keep Pi-bundled imports (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and related Pi packages) in `peerDependencies` with `"*"` and in `devDependencies` only for local typechecking.
- If overriding a built-in tool, preserve its execution semantics and result shape. Use side-channel renderer state for UI-only metadata when the built-in result has no details field.
- If a custom or overridden tool mutates files, use Pi's file mutation queue around the whole read-modify-write window or reuse a Pi built-in tool definition that does so.
- Tool renderers must return TUI components whose rendered lines do not exceed the provided width.
- Validate changes with `npm run check` before handing off. For visual/TUI changes, also verify in a real Pi TTY session when possible.

## User-Facing Configuration Docs

- README and `docs/configuration.md` configuration docs are user-facing: explain available settings and examples, not implementation lifecycle.
- Add a Configuration section only when the extension has meaningful user-facing settings.
- README configuration sections must use one short global config path sentence, a compact option table, and one JSON block showing the full scaffolded default config.
- README and `docs/configuration.md` Configuration/Settings JSON blocks must show the full default config, not partial overrides; do not omit default-valued settings.
- Include `"$schema"` in JSON examples when the scaffolded default config includes it, but do not explain it in prose.
- Option tables should list actual user-editable setting keys, preferably dot paths like `tools.webSearch`; avoid vague category rows such as `tools`, `openai`, or `appearance` unless that object is edited as a single meaningful value.
- If a setting has no default, document it in the option table but do not invent a value for it in JSON.
- In README configuration sections, mention only the global path `<Pi agent dir>/<extension-id>/config.json`; do not mention trusted project overrides or project-specific config paths.
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
