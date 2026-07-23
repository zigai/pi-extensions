# AGENTS.md

## Pi Extension Workflow

- This repository is a Pi package. Keep resources declared explicitly in `package.json` under the `pi` manifest.
- The extension entrypoint is `src/index.ts` and should export a default factory that receives Pi's `ExtensionAPI`.
- Do not edit Pi's installed source code to implement package behavior. Use Pi's extension API instead.
- Keep Pi-bundled imports (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) in `peerDependencies` with `"*"` and in `devDependencies` only for local typechecking.
- Put the package description in the top-level `package.json` `description` field. Pi does not have extension-level description metadata.

## Extension Settings

This scaffold includes extension-owned settings. Keep the generated settings artifacts current as options are added or changed.

- Use `@zigai/pi-extension-settings` for extension-owned JSON settings. The template bundles it so published extensions remain independently installable.
- Keep the TypeBox source of truth and runtime settings boundary together in a flat `src/settings.ts` module using `defineExtensionSettings`.
- Use “settings” for the extension capability and source module; reserve “config” for concrete persisted-file concepts such as config paths and `config.schema.json`. Do not create a one-file `src/config/` directory or a parallel `config.ts`; split `settings.ts` only when a substantial domain capability earns its own specifically named module.
- Register `src/settings.ts`, `config.schema.json`, and the README in the package's `piExtensionSettings` manifest field.
- Expose the package-facing loader as `load<ExtensionName>Settings`, such as `loadExampleSettings`. This function owns the shared loader call and returns the extension's typed, resolved settings; ordinary extension code should call it rather than the definition or shared adapter directly.
- Implement that loader with `loadPiExtensionSettings`. It uses `getAgentDir()` and `CONFIG_DIR_NAME`; never hardcode `~/.pi/agent` or `.pi` in runtime code.
- Global settings live at `getAgentDir()/extension-settings/pi-autoname-session.json`; editor schemas live at `getAgentDir()/extension-settings/schemas/pi-autoname-session.schema.json`.
- Trusted project overrides live at `ctx.cwd/CONFIG_DIR_NAME/extension-settings/pi-autoname-session.json`. Never read project settings for an untrusted project or create project settings automatically.
- Parse settings at the boundary: `JSON.parse` to `unknown`, validate/decode with TypeBox, then pass typed settings inward. Never cast `JSON.parse` output to settings types or scatter hand-written shape checks.
- Run the shared generator after changing the TypeBox definition. Check in `config.schema.json` and the generated README region; pre-commit and CI must run the shared artifact check.
- The shared loader may scaffold default global settings only when missing, never overwrite existing or malformed user settings, and refresh missing or stale installed schemas from the checked-in bundled schema.
- Use environment variables only for secrets, CI/session overrides, or explicit settings-path overrides, not normal persisted options.
- Keep secrets out of ordinary JSON settings unless the extension deliberately designs secure storage and permissions.
- Keep lifecycle, trust, and malformed-file policy in `AGENTS.md` and tests, not in generated README documentation.

## README Settings Documentation

Keep the declared `piExtensionSettings` artifacts and generated README region synchronized with the settings definition.

- Put the generated settings region after installation and the normal first-use guidance.
- Put `<!-- pi-extension-settings:start -->` and `<!-- pi-extension-settings:end -->` in the README exactly once.
- Do not hand-edit content between those markers. The shared generator owns the settings path, compact option table, and complete default JSON document in its collapsed disclosure.
- Put user-facing descriptions on TypeBox properties in `src/settings.ts`; wording changes flow into README documentation through generation.
- Do not document alternate paths, layering, TypeBox mechanics, schema refresh, trust, user-owned terminology, or malformed-file policy in the generated region.

## Implementation Notes

- Keep user/LLM-facing descriptions on registered tools, commands, flags, and shortcuts.
- Tool `promptGuidelines` are appended flat to Pi's system prompt; every guideline must name the exact tool it refers to.
- If an extension starts timers, intervals, file watchers, sockets, or subprocesses after `session_start`, clean them up in `session_shutdown` and during reload.
- If a custom tool mutates files, use Pi's file mutation queue around the whole read-modify-write window.
- Custom tools must truncate large output and tell the model where any full output was saved.
- Use `StringEnum` from `@earendil-works/pi-ai` for model-facing string enums instead of `Type.Union` of literals.
- Use `ctx.mode === "tui"` before terminal-only UI work and `ctx.hasUI` before dialogs/notifications.
- Run `just setup` after cloning to install dependencies and Git hooks and verify the project.
- Keep pre-commit enabled. Its first hook must run `config:check` so stale `config.schema.json` or generated README documentation cannot be committed.
- Validate later changes with `just check` before handing off; use `just coverage` when coverage output is needed.
- For visual/TUI changes, verify in a real tmux/TTY session instead of only relying on snapshots or non-interactive output.
