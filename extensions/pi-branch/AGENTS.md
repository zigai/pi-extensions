# AGENTS.md

## README Configuration Docs

- When documenting extension configuration in `README.md`, show the full scaffolded default `config.json` rather than partial override examples.
- Do not omit settings that have default values from README JSON config blocks.
- Include `$schema` in README JSON config blocks when the scaffolded default config includes it, but do not explain `$schema` in prose.
- Do not mention project-specific configuration overrides in `README.md`.
- Option tables must list actual user-editable keys or dot paths.
- If a setting has no default, document it in the option table but do not invent a value for it in README JSON config blocks.
