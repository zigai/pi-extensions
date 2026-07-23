# AGENTS.md

## Pi Package Workflow

- This repository provides `pi-typed-args`, a TypeScript library for Pi extensions and typed skills.
- Keep public package exports in `package.json` aligned with files under `src/`, `schemas/`, and `docs/`.
- Validate changes with `npm run check` before handing off when practical.

## User-Facing Configuration Docs

- README and `docs/configuration.md` configuration docs are user-facing: explain available settings and examples, not implementation lifecycle.
- Add a Configuration section only when the extension has meaningful user-facing settings.
- README configuration sections must use one short global config path sentence, a compact option table, and one JSON block showing the full scaffolded default config.
- README and `docs/configuration.md` Configuration/Settings JSON blocks must show the full default config, not partial overrides; do not omit default-valued settings.
- Include `"$schema"` in JSON examples when the scaffolded default config includes it, but do not explain it in prose.
- Option tables should list actual user-editable setting keys, preferably dot paths like `tools.webSearch`; avoid vague category rows such as `tools`, `openai`, or `appearance` unless that object is edited as a single meaningful value.
- If a setting has no default, document it in the option table but do not invent a value for it in JSON.
- In README configuration sections, mention only the global path `~/.pi/agent/pi-typed-args/config.json`; do not mention trusted project overrides or project-specific config paths.
- `docs/configuration.md` may include advanced project override details only in a dedicated Advanced section when they are genuinely useful.
- Do not mention TypeBox, `getAgentDir()`, `CONFIG_DIR_NAME`, schema refresh mechanics, user-owned/extension-owned terminology, or malformed-config overwrite policy in README/config docs.
- Keep lifecycle implementation policy in `AGENTS.md`, tests, and source code rather than user docs.

## Pi Extension Configuration

- If an extension needs user-configurable behavior, store persistent runtime settings as JSON files, not Pi core `settings.json` or YAML/TOML/TypeScript config.
- Use `getAgentDir()/<extension-id>/config.json` for user-owned global config and trusted `ctx.cwd/CONFIG_DIR_NAME/<extension-id>/config.json` for user-owned project overrides.
- Import `getAgentDir()` and `CONFIG_DIR_NAME` from `@earendil-works/pi-coding-agent`; do not hardcode Pi agent paths.
- Parse config at the boundary: read JSON with `JSON.parse` into `unknown`, then decode with TypeBox before passing typed config inward.
- Keep checked-in `config.schema.json` synchronized with the TypeBox schema and default config values, including top-level JSON Schema metadata.
- Scaffold default global `config.json` only when missing, include `"$schema": "./config.schema.json"`, and never overwrite existing or malformed user config.
- Treat `config.schema.json` as extension-owned: write it when missing and refresh it when the installed extension schema content is stale.
- Never auto-create project config; read trusted project config only when already present.
- Use environment variables only for secrets, CI/session overrides, or explicit config-path overrides.
