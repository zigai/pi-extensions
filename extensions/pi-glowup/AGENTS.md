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
