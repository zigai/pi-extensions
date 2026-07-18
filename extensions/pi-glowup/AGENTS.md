# AGENTS.md

## Pi Extension Workflow

- This repository is a standalone Pi package for the `pi-glowup` extension.
- Keep Pi resources declared explicitly in `package.json` under the `pi` manifest.
- The extension entrypoint is `src/index.ts` and must export a default factory that receives Pi's `ExtensionAPI`.
- Do not edit Pi's installed source code. Use Pi's public extension API and exported SDK helpers.
- Keep Pi-bundled imports (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and related Pi packages) in `peerDependencies` with `"*"` and in `devDependencies` only for local typechecking.
- If overriding a built-in tool, preserve its execution semantics and result shape. Use side-channel renderer state for UI-only metadata when the built-in result has no details field.
- If a custom or overridden tool mutates files, use Pi's file mutation queue around the whole read-modify-write window or reuse a Pi built-in tool definition that does so.
- Tool renderers must return TUI components whose rendered lines do not exceed the provided width.
- Validate changes with `just check` before handing off. For visual/TUI changes, also verify in an isolated real Pi TTY session when possible.

## TUI Testing

- Run `just test` for the complete automated test suite, including headless xterm and real-process PTY tests.
- Run `just check` for formatting, linting, typechecking, and the complete automated test suite.
- Keep component tests for renderer semantics, width limits, bounded previews, and focused state transitions.
- Use `@xterm/headless` integration tests for the seam from Pi's real `TUI` and `ToolExecutionComponent` through differential ANSI output to interpreted terminal cells. Assert redraws, stale-cell cleanup, wrapping, colors, backgrounds, resizing, and adjacent transcript integrity there.
- Use `node-pty` real-process tests for actual Pi CLI loading, configured key input, resize, reload, persisted-session resume, and streaming lifecycle behavior. Drive deterministic local fixtures with the network guard enabled and inspect every synchronized terminal frame.
- Keep PTY assertions semantic and invariant-based. Reject duplicate mutation blocks, stale content, raw argument JSON, internal paths, over-width or wrapped rows, and blank completion padding.
- Write raw ANSI and interpreted frame artifacts only when a PTY test fails. CI uploads those failure artifacts; do not commit bulky recordings.
- Use seeded property tests for streaming chunk boundaries, rewrites, truncation, CRLF, Unicode, width changes, component reuse, tool-call isolation, and cached-versus-cold equivalence.
- Run `just benchmark` for the full informational TUI benchmark or `just benchmark-quick` for its smoke form. Keep performance timing out of Vitest assertions until a reviewed regression policy exists.

## Tool Rendering Contract

- Treat every mutation tool call as immutable transcript history. Later `edit`, `write`, and patch calls render below earlier calls and never overwrite or group them.
- Render every file in a multi-file patch as its own top-level `Patch <path>` block. Do not add a parent file-count summary or tree connectors. Read-only `Explored` grouping is the deliberate exception.
- Keep static tool labels stable by default. The patch label is `Patch`; lifecycle mode uses `Patching` while active and `Patched` when complete.
- Keep mutation previews meaningful and bounded: six changed/content rows, change-aware selection, one neutral omission row at the bottom, and no blank completion padding. Expansion hints must use Pi's configured tool-expand keybinding rather than a hardcoded shortcut.
- Show real, dimmed, right-aligned line numbers on edits. Resolve coordinate-less patch hunks from a bounded pre-execution text snapshot rather than inventing positions.
- Use full-row semantic backgrounds for additions and deletions, preserve syntax colors within them, and leave context/omission rows neutral. Diff backgrounds and instruction-file path colors must remain user-configurable.
- Suppress zero-valued mutation statistics. Prefer `(+N)`, `(-N)`, or `(+N -N)` and never duplicate a successful mutation result below the call.
- Stream only renderers with meaningful evolving content, such as diffs, writes, and generation prompts. Simple read/search/list calls appear once their arguments are complete instead of typing character by character.
- Script previews show eight code lines by default, keep multiline code below the tool header, visibly mark soft wraps, separate output with the connector row, and retain leading Python/Node imports when the complete short script fits.
- Preserve rich syntax highlighting for code-bearing tool calls, including streaming mutations. Thinking blocks and user messages remain plain.
- Render compact semantic layouts for known third-party tools and avoid raw argument JSON, internal artifact paths, redundant attachment rows, and fake expansion affordances.
- New third-party tool-specific renderers, parsers, and state belong in the tool's parent library or companion extension. Existing compatibility renderers remain in this repository until their owning package ships and verifies an equivalent protocol adapter; migrate and remove them one family at a time, never preemptively.
- External tool owners must import `pi-glowup/protocol`; they must not import `src/rendering`, `src/third-party-tools`, Pi TUI components, Glowup themes, or ANSI helpers through this repository.
- Do not add external tool-name registries or family-specific fallback branches to `pi-glowup`. A tool-owned `glowupRendering` adapter is the supported customization seam.
- Components must react to width changes. Expanded Pierre diffs use side-by-side layout whenever the current width meets the threshold and unified layout otherwise; never freeze the initial-width decision.
- Never perform blocking subprocess or filesystem work from `render()`. Keep replay, syntax, snapshot, and component state bounded so large calls and restored sessions remain responsive.
- For visual verification, use isolated headless pseudo-TTY/tmux evidence, raw ANSI, resizing, scrollback, and the configured expansion key. Do not open an unsolicited visible terminal window for demonstrations.

## User-Facing Configuration Docs

- README and `docs/configuration.md` configuration docs are user-facing: explain available settings and examples, not implementation lifecycle.
- Add a Configuration section only when the extension has meaningful user-facing settings.
- README configuration sections must use one short global config path sentence, a compact option table, and one JSON block showing the full scaffolded default config.
- README and `docs/configuration.md` Configuration/Settings JSON blocks must show the full default config, not partial overrides; do not omit default-valued settings.
- Include `"$schema"` in JSON examples when the scaffolded default config includes it, but do not explain it in prose.
- Option tables should list actual user-editable setting keys, preferably dot paths like `tools.webSearch`; avoid vague category rows such as `tools`, `openai`, or `appearance` unless that object is edited as a single meaningful value.
- If a setting has no default, document it in the option table but do not invent a value for it in JSON.
- In README configuration sections, mention only the global path `~/.pi/agent/pi-glowup/config.json`; do not mention trusted project overrides or project-specific config paths.
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
