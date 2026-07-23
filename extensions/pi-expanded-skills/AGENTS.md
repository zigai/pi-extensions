# AGENTS.md

## Pi Extension Workflow

- This repository is a Pi package. Keep resources declared explicitly in `package.json` under the `pi` manifest.
- The extension entrypoint is `src/index.ts` and should export a default factory that receives Pi's `ExtensionAPI`.
- Do not edit Pi's installed source code to implement package behavior. Use Pi's extension API instead.
- Keep Pi-bundled imports (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) in `peerDependencies` with `"*"` and in `devDependencies` only for local typechecking.
- Put the package description in the top-level `package.json` `description` field. Pi does not have extension-level description metadata.

## Extension Configuration

Only add extension configuration when the extension needs user-configurable behavior. Extensions that work from defaults or Pi context do not need config files.

- Do not store extension runtime settings in Pi's core `settings.json`; it is for Pi runtime, package, and resource loading.
- If config is needed, use extension-owned JSON at `getAgentDir()/<extension-id>/config.json` for global settings and trusted project overrides at `ctx.cwd/CONFIG_DIR_NAME/<extension-id>/config.json`.
- Import and use `getAgentDir()` and `CONFIG_DIR_NAME` from `@earendil-works/pi-coding-agent`; do not hardcode `~/.pi/agent` or `.pi` in code.
- Use JSON only for persisted extension config.
- Define the config schema with TypeBox. At the file boundary, `JSON.parse` file contents to `unknown`, validate/decode with TypeBox, and pass typed config inward.
- Do not cast `JSON.parse` output to a config type or scatter ad hoc shape checks throughout the extension.
- Keep a checked-in `config.schema.json` in the repo and update it whenever the TypeBox schema or default config changes.
- Add `"$schema": "./config.schema.json"` to scaffolded config files so editors resolve the local schema copy.
- Treat `config.json` as user-owned. Scaffold the default global config only when it is missing; never overwrite existing or malformed user config.
- Treat `config.schema.json` as extension-owned. Copy/write it from the installed extension when it is missing or stale, using an atomic or otherwise safe write where practical.
- Report a clear warning/error for malformed user config and fall back safely or abort setup depending on the operation.
- Use environment variables only for secrets, CI/session overrides, or explicit config-path overrides, not normal persisted options.
- Keep secrets out of ordinary JSON config unless the extension deliberately designs secure storage and permissions.
- Keep lifecycle and implementation policy in `AGENTS.md` and tests, not in `README.md`.

## README Configuration Documentation

README config docs should be minimal, user-facing, and focused on usable settings rather than internal implementation policy. Only include a Configuration section if the extension has meaningful user-facing settings.

Use this structure for README configuration docs:

1. Start with one short sentence documenting the global config path with user-facing wording: `<Pi agent dir>/<extension-id>/config.json`.
2. Add a compact option table with columns such as Option, Type, Default, and Description for each user-facing setting.
3. Include one JSON example showing default values or a common useful override. Keep it minimal; do not include both minimal and full defaults unless the full default is tiny.

Do not put these details in README configuration docs:

- Trusted project override paths or project override behavior.
- TypeBox details.
- `getAgentDir()` or `CONFIG_DIR_NAME` implementation names.
- Schema refresh mechanics.
- User-owned or extension-owned terminology.
- Malformed-config overwrite policy.
- Lifecycle or implementation policy.
- Explanatory prose about `"$schema"`; JSON examples may include it if the default config file contains it.
- Long default JSON dumps.
- JSONC references; document JSON only.

## Implementation Notes

- Keep user/LLM-facing descriptions on registered tools, commands, flags, and shortcuts.
- Tool `promptGuidelines` are appended flat to Pi's system prompt; every guideline must name the exact tool it refers to.
- If an extension starts timers, intervals, file watchers, sockets, or subprocesses after `session_start`, clean them up in `session_shutdown` and during reload.
- If a custom tool mutates files, use Pi's file mutation queue around the whole read-modify-write window.
- Custom tools must truncate large output and tell the model where any full output was saved.
- Use `StringEnum` from `@earendil-works/pi-ai` for model-facing string enums instead of `Type.Union` of literals.
- Use `ctx.mode === "tui"` before terminal-only UI work and `ctx.hasUI` before dialogs/notifications.
- Validate changes with `just check` before handing off; use `just coverage` when coverage output is needed.
- For visual/TUI changes, verify in a real tmux/TTY session instead of only relying on snapshots or non-interactive output.
