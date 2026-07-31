# AGENTS.md

## Pi Package Workflow

- Keep the extension entrypoint declared explicitly in `package.json` under `pi.extensions`.
- Keep Pi-bundled imports in `peerDependencies` with `"*"` and in `devDependencies` for local checks only.
- Bundle `pi-typed-args` because Pi packages do not share module roots at runtime.
- Keep the package allowlist and package smoke test current when adding published files.
- Validate changes with `just check` before handing off.

## README Configuration Docs

- When documenting extension configuration in `README.md`, show the full scaffolded default `config.json` rather than partial override examples.
- Do not omit settings that have default values from README JSON config blocks.
- Include `$schema` in README JSON config blocks when the scaffolded default config includes it, but do not explain `$schema` in prose.
- Do not mention project-specific configuration overrides in `README.md`.
- Option tables must list actual user-editable keys or dot paths.
- If a setting has no default, document it in the option table but do not invent a value for it in README JSON config blocks.
