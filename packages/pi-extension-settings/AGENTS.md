# AGENTS.md

## Work and verification

This library provides settings runtime and artifact tooling for Pi extensions; it is not itself an extension. Run `just setup` after cloning and `just check` before handing off changes. Preserve strict TypeScript, type-aware Oxlint, coverage thresholds, and non-mutating generation checks. Test filesystem behavior with real temporary directories, not module mocks or method spies.

## Ownership and package surface

Keep the public API limited to settings definitions, runtime hydration, Pi loading/updates, and the `generate`/`check` CLI. Filesystem, schema, artifact, and workspace-discovery helpers remain internal.

- `src/definition.ts`: definition invariants.
- `src/settings-layer.ts`: parsing and merge validation.
- `src/settings-loader.ts`: synchronous loading.
- `src/settings-transaction.ts`: explicit asynchronous updates.
- `src/pi.ts`: Pi paths and project trust; internal operations accept explicit paths for testing.
- `src/artifacts.ts`: repository artifact generation.

Publish generated runtime artifacts and declarations from `dist`; do not commit that directory. Preserve the manifest's root JavaScript entry and Pi-facing generated `/runtime` and `/pi` bundles. Preserve build and prepack verification; do not redirect executable exports to authoring source.

## Agent-facing usage contract

Keep documentation and examples sufficient for agents to implement consumers correctly:

- Author TypeBox schemas in generation-safe `settings-input.ts`; derive resolved types with `StaticDecode`. Hydrate prevalidation in `settings.ts` through `/runtime`; load/update through `/pi`. The package root serves authoring APIs.
- Declare and publish the input, prevalidation, schema, and README artifacts. Generate after definition changes; never hand-edit generated content.
- Keep I/O out of imports, factories, and renderers. Consumers own caching, diagnostics, activation, and reset; this library does not own Pi sessions. Cache disabled and semantically invalid results too, without a redundant activation flag.
- Reset at `session_start` and load at the first callback needing settings, including `session_start` when behavior begins there. Dispose owned resources before clearing state; add cancellation/stale-result handling only for owned async work. Deferred loading moves the cost, not eliminates it.
- Renderers use execution/presentation data and work before activation; `ToolRenderContext` cannot substitute for `ExtensionContext`.
- Load before `updatePiExtensionSettings()`, handle typed outcomes, and use revisions for snapshot edits rather than semantic updates. Do not add consumer-side settings writers or mutation queues.

Keep API recipes in `docs/manual-setup.md`, `docs/runtime.md`, and `docs/generation.md` aligned with this contract. Do not introduce a generic session helper that hides extension-specific validation, diagnostics, or resource ownership.

## Persistence invariants

- Parse persisted JSON from `unknown`, validate/decode once, and pass typed values inward. Apply defaults once, then global and trusted-project layers; deep-merge objects and replace arrays/scalars.
- Resolve global files through `getAgentDir()/extension-settings/` and schemas through its `schemas/` directory. Resolve project overrides through `CONFIG_DIR_NAME`, only for trusted projects.
- Loading scaffolds global settings only when missing. Never overwrite or repair existing user settings or scaffold project settings. Legacy migration may copy into a missing centralized target only, leaving the original untouched.
- Explicit transactions may create trusted-project files. Reject untrusted projects and preserve malformed/invalid existing files exactly.
- Transaction callbacks receive the latest encoded layer and run synchronously once under lock. Validate the layer, resolved settings, and codecs before publication. Coordinate through Pi's per-file mutation queue and the cooperative inter-process lock; replace atomically and preserve permissions.
- Verify bundled schemas and refresh stale global copies atomically. Diagnostics never include raw setting values or secrets.

## Schema and generation invariants

TypeBox definitions own types, defaults, persisted schemas, prevalidation, README tables/defaults, and examples. Complex array-item/record-value objects need concise PascalCase titles; reject unnamed types that produce unreadable tables.

`exampleSettings` is optional: use it for structured or interacting options, not obvious scalars. Validate it as a partial JSON layer that differs from defaults, resolves successfully, and demonstrates focused non-secret usage.

Never hand-edit generated schemas or README text between the settings markers. Keep `generate` and `check` consistent for standalone and workspace manifests. `check` must remain deterministic and non-mutating. Compare codec function text during authoring prevalidation only; runtime hydration checks JSON-visible drift because Pi and bundlers transform function text.

New boundary and failure paths require observable tests; preserve package verification and enforced coverage.
