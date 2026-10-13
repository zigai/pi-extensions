# AGENTS.md

## Work and verification

This is a strict TypeScript ESM npm-workspaces monorepo. Independently installable Pi extensions live under `extensions/*`; shared libraries and the published collection live under `packages/*`; extension packages declare their entrypoints in `pi.extensions`. Extensions run with user-level permissions: settings persistence and patches of Pi internals require particular care.

Packages retain independent versions, licenses, published exports, and strict workspace checks. Oxlint and Oxfmt use the repository-root configurations and dependencies, with scoped overrides preserving package policies. The root task runner runs imported-package builds, types, and tests from their own working directories; do not flatten those configurations or suppress failures. The collection uses bundled published dependencies and Pi resource paths, never a combined extension factory. Root development loading and collection loading are alternatives, not simultaneous activations.

Run `just setup` after cloning and `npm run check` before handing off changes. The check covers architecture, generated settings, formatting, lint, types, tests, and npm packaging. Keep pre-commit enabled, including its generated-settings check.

Use explicit `.ts` suffixes for local imports. Let Oxfmt format code; Oxlint disallows ternary expressions. Avoid `any`, `@ts-ignore`, and unchecked assertions about Pi internals. Follow Conventional Commit subjects such as `fix(pi-tree): ...`.

## Live Pi and review

The user's running Pi loads extensions directly from this checkout, including Glowup's built `dist/`. Until it loads from deployed live copies, make changes in a worktree under `$WORKTREE_DIR/pi-tweaks/<name>`, not here. Verify bug fixes with a recorded reproduction by running it before and after the fix; put features that need the user's judgment through the isolated review environment. The work plan, live copies, review environment, and extension lifecycle are in `~/Projects/config/pi/MONOREPO_PLAN.md`.

## Code ownership

- Keep `src/index.ts` cohesive: it owns Pi registration, settings application, controller construction, activation, and disposal. Extract domain rules, persistence, reusable rendering, and substantial adapters; avoid pass-through entrypoints.
- Keep small capabilities flat. Introduce a directory when a capability spans several cohesive files. Name modules for their responsibility; avoid generic `utils`, `helpers`, `types`, or `constants` dumping grounds. Keep tests beside their feature ownership; reserve `index.test.ts` for composition and lifecycle.
- Use `@zigai/pi-extension-internals` only for cross-extension composition protocols and guarded Pi-internal loading. Keep feature policy in its owning extension.
- Every published package needs an explicit `exports` map, normally only `"."`. Add subpaths only for intentional consumer APIs; do not use broad export barrels or expose internals for tests.
- Cross-package runtime imports must use published exports and declared runtime dependencies, never another package's `src/`. Dependencies must be independently published and installable.

## Pi integration and patches

Prefer `getAgentDir()` and `CONFIG_DIR_NAME` over hardcoded Pi paths. Environment variables are for secrets, CI/session overrides, or explicit path overrides, not ordinary persistent options.

Prototype patches must be idempotent and use `Symbol.for(...)` markers set only after the required targets are verified. Removable installers return handles with update and idempotent disposal; retain the current policy with the marker and restore the predecessor safely. Missing or moved private modules must produce a clear warning rather than crash startup.

Keep Pi-internal TUI imports out of extension factories. Activate patches needed throughout a TUI session at `session_start`, with one in-flight activation, stale-completion rejection after reset, and restoration on shutdown. Do not delay required behavior to first use solely to improve startup measurements. Measure perceived startup at a deterministic presented-screen boundary in a real TUI; RPC readiness does not establish that timing.

## Extension settings

Use `@zigai/pi-extension-settings` only when an extension has meaningful configurable behavior. Keep it at the exact supported version as a normal runtime dependency; do not bundle it or put extension options in Pi's core `settings.json`.

- **Author:** `src/settings-input.ts` owns the TypeBox schema, defaults, descriptions, and optional example. It must be safe for generation: no Pi registration, feature initialization, or generated-artifact imports. Derive resolved types with `StaticDecode`; decode persisted input once at its boundary.
- **Load:** `src/settings.ts` hydrates `settings.prevalidated.ts` with `definePrevalidatedExtensionSettings` from `/runtime`, calls the loader from `/pi`, and owns extension-specific semantic validation. Use the package root for authoring APIs. Expose `load<ExtensionName>Settings` for ordinary extension code. Keep this capability flat and named “settings”; reserve “config” for persisted-file concepts.
- **Generate:** declare the input, prevalidation, schema, and README in `piExtensionSettings` and include all four in the package. Run `just config-generate` after schema or description changes and `just config-check` to verify them. Never hand-edit prevalidation, JSON Schema, or the README settings region.
- **Own the session:** keep settings I/O out of imports, factories, and renderers. Reset at `session_start`; load once in the first callback that needs settings, including `session_start` when behavior begins there. Cache disabled and invalid results too, and report diagnostics once when `ctx.hasUI`. Dispose owned resources before clearing their state on reset/shutdown; add cancellation and stale-result checks for owned asynchronous work. Preserve deliberate refresh exceptions such as mtime-based model settings.
- **Respect persistence:** the library resolves defaults, global settings, then trusted-project overrides; objects merge and arrays/scalars replace. It handles Pi paths, missing global files, and schema refresh. Loading never overwrites existing settings or creates project files; invalid layers remain untouched and are reported without their values. Do not duplicate readers or expose secrets in diagnostics.
- **Write:** load first, then use `updatePiExtensionSettings()` from `/pi`. The synchronous update callback receives the latest encoded layer. Handle every typed outcome. Pass `expectedRevision` for snapshot edits and omit it for semantic updates. Project writes require trust and may create a missing project file. Do not add ad hoc writers, locks, or another mutation queue.

Put user-facing wording on schema properties. Use a concise PascalCase `title` for complex array-item/record-value objects. Add a valid, focused, non-secret partial `exampleSettings` only when structured or interacting options need explanation. The generator owns the README path, option table, defaults, and example; keep implementation policy outside that region.

Consult the installed settings package's `docs/manual-setup.md`, `docs/runtime.md`, and `docs/generation.md` for API details when changing the integration. Deferred loading moves synchronous work to first use; it does not remove the cost.

Tool renderers receive `ToolRenderContext`, not `ExtensionContext`. Render from arguments, results, and renderer state; never retain execution contexts for settings access. Return a component even before activation or execution, including for history.

## Packaging

Put extension-owned libraries in `dependencies` and Pi-provided host APIs in `peerDependencies`. Verify Pi's managed npm topology, where host peers may be absent from the extension's own dependency tree. If a README references an asset, verify its tarball inclusion with `npm pack --dry-run -w <workspace>`. Keep install snippets and the root package table aligned when packages change.
