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
- Render every available completed-mutation row by default. Keep the selectable preview view meaningful and bounded: six changed/content rows by default, change-aware selection, one neutral omission row at the bottom, and no blank completion padding. Expansion hints must use Pi's configured tool-expand keybinding rather than a hardcoded shortcut.
- Keep mutation row budgets, diff guardrails, native-write retention, and delete preimage capture user-configurable with explicit byte/line units. Preserve the established bounded values as defaults even when a setting also accepts `null` to disable its limit.
- Show real, dimmed, right-aligned line numbers on edits. Resolve coordinate-less patch hunks from a bounded pre-execution text snapshot rather than inventing positions.
- Use full-row semantic backgrounds for additions and deletions, preserve syntax colors within them, and leave context/omission rows neutral. Diff backgrounds and instruction-file path colors must remain user-configurable.
- Suppress zero-valued mutation statistics. Prefer `(+N)`, `(-N)`, or `(+N -N)` and never duplicate a successful mutation result below the call.
- Stream only renderers with meaningful evolving content, such as diffs, writes, and generation prompts. Simple read/search/list calls appear once their arguments are complete instead of typing character by character.
- Script previews show eight code lines by default, keep multiline code below the tool header, visibly mark soft wraps, separate output with the connector row, and retain leading Python/Node imports when the complete short script fits.
- Preserve rich syntax highlighting for code-bearing tool calls, including streaming mutations. Thinking blocks and user messages remain plain.
- Render compact semantic layouts for known third-party tools and avoid raw argument JSON, internal artifact paths, redundant attachment rows, and fake expansion affordances.
- New third-party tool-specific renderers, parsers, and state belong in the tool's parent library or companion extension. Existing compatibility renderers remain in this repository until their owning package ships and verifies an equivalent protocol adapter; migrate and remove them one family at a time, never preemptively.
- External tool owners must import `@zigai/pi-glowup/protocol`; they must not import `src/rendering`, `src/tools`, Pi TUI components, Glowup themes, or ANSI helpers through this repository.
- Do not add external tool-name registries or family-specific fallback branches to `pi-glowup`. A tool-owned `glowupRendering` adapter is the supported customization seam.
- Components must react to width changes. Pierre-backed native edits and completed `apply_patch` diffs use side-by-side layout whenever the current width meets the threshold and unified layout otherwise; never freeze the initial-width decision.
- Never perform blocking subprocess or filesystem work from `render()`. Keep replay, syntax, snapshot, and component state bounded so large calls and restored sessions remain responsive.
- For visual verification, use isolated headless pseudo-TTY/tmux evidence, raw ANSI, resizing, scrollback, and the configured expansion key. Do not open an unsolicited visible terminal window for demonstrations.

## Extension Settings

- **Author:** edit TypeBox schema/metadata in `src/settings-input.ts`; no Pi runtime, generated-artifact imports, I/O, or feature initialization. Use a closed root (`additionalProperties: false`), user-facing descriptions, valid defaults, codecs for transformations, and `StaticDecode` for resolved types—not duplicate interfaces/casts. Add realistic, secret-free partial `exampleSettings` only when useful; give complex array-item/record-value objects PascalCase titles for readable docs.
- **Generate:** declare and publish `src/settings-input.ts`, `src/settings.prevalidated.ts`, `config.schema.json`, and `README.md` through `package.json.piExtensionSettings`. Run `npm run config:generate` after authoring changes; commit outputs, never hand-edit generated artifacts/README region. Gate pre-commit/CI with `npm run config:check`.
- **Load:** keep `@zigai/pi-extension-settings` a normal runtime dependency, not bundled. Use its root for authoring, `/runtime` for `definePrevalidatedExtensionSettings` hydration in `src/settings.ts`, and `/pi` for `loadPiExtensionSettings`/updates. Features call the existing `load<ExtensionName>Settings` boundary; no duplicate parsing or hardcoded Pi paths. Keep settings in `settings` modules, not parallel `config.ts`/one-file `config/` modules.
- **Resolve:** defaults → global → trusted project; objects merge, arrays/scalars replace. The loader owns paths/trust, schema refresh, and missing-global scaffolding; never overwrites settings or auto-creates project settings. Invalid layers are ignored, untouched, and diagnosed without values/secrets. Environment variables are only for secrets, CI/session or explicit path overrides; JSON is not secret storage.
- **Update:** load first, then use `updatePiExtensionSettings()` with a synchronous, deterministic, side-effect-free callback over the latest encoded layer. Pass `globalRevision`/`projectRevision` as `expectedRevision` for snapshot edits; omit for semantic updates. Handle every typed outcome. Explicit trusted-project updates may create project settings; invalid files remain untouched. No direct writers or extra mutation queue.
- **Document:** the generator owns the single README settings region: global path, editable-key table, complete defaults including `$schema` (no invented optional values). Keep library/lifecycle mechanics out. For details, read the installed package's `docs/manual-setup.md`, `docs/runtime.md`, and `docs/generation.md`.

Advanced project overrides belong only in a useful dedicated Advanced section of `docs/configuration.md`. Configuration/Settings JSON blocks there must also show complete defaults; keep implementation policy here, in source, and in tests.

## Settings Lifecycle

- Keep import and synchronous registration free of settings I/O. Load at session setup in the existing composition boundary: rendering needs settings there, not at first render. Keep resolved types as the source for runtime adapters, not duplicate schemas or scaffolding.
- Keep the full activation result session-owned, including rejected settings; report settings diagnostics once per activation when `ctx.hasUI`. Reset at session boundaries, disposing owned resources before clearing state. Preserve existing configuration refresh behavior; do not introduce a generic activation framework or an `enabled` option the schema does not own.
- Deferred loading moves synchronous work; it does not eliminate it. `pi config` prevents import and registration entirely.
- Renderers receive `ToolRenderContext`, not `ExtensionContext`: use arguments, results, and presentation state, never settings I/O, notifications, or a retained execution context. Always return a component, including history rendered before activation.
