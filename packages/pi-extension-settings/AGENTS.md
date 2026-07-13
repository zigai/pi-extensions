# AGENTS.md

## Project Contract

- This package provides reusable runtime and artifact tooling for Pi extension settings; it is not itself a Pi extension.
- Keep the public API small and cohesive. Extension-specific semantic validation, UI policy, and migrations belong in consuming extensions.
- `src/definition.ts` owns definition invariants, `src/runtime.ts` owns async/synchronous layer resolution, `src/artifacts.ts` owns repository artifact workflows, and `src/projects.ts` owns package/workspace discovery.
- Async and synchronous loaders must preserve identical paths, diagnostics, merge order, and file-ownership behavior.
- Keep Pi-specific imports isolated in `src/pi.ts`; core runtime and generation modules must remain testable with explicit paths and trust state.
- Publish compiled JavaScript and declarations from the checked-in `dist`; do not expose TypeScript source as an executable package boundary. Keep `dist` synchronized with `npm run build:check` so private Git installs do not depend on lifecycle scripts.

## Configuration Invariants

- TypeBox definitions are the source of truth for runtime types, persisted input schemas, defaults, checked-in JSON Schema, README option tables, and README default JSON.
- Parse persisted JSON to `unknown`, validate and decode at the boundary, then pass decoded settings inward. Never cast serialized input to a settings type.
- Apply defaults once, then layer global settings and trusted project settings. Deep-merge objects and replace arrays/scalars.
- Store global config under `getAgentDir()/extension-settings/<id>.json` and global schemas under `getAgentDir()/extension-settings/schemas/<id>.schema.json`.
- Resolve project overrides with `CONFIG_DIR_NAME` and honor them only for trusted projects.
- Never overwrite, repair, or migrate an existing user config. Scaffold global config exclusively when missing; never scaffold project config.
- Treat schemas as generated extension-owned artifacts. Verify bundled schema content and refresh the global copy atomically when stale.
- Diagnostics must not include raw setting values or secrets.

## Generated Artifacts

- Never hand-edit generated `config.schema.json` content or README text between `<!-- pi-extension-settings:start -->` and `<!-- pi-extension-settings:end -->`.
- Run `pi-extension-settings generate` after changing a definition.
- `pi-extension-settings check` must remain non-mutating and deterministic for pre-commit and CI.
- Standalone packages and npm workspace packages use the same package-level `piExtensionSettings` manifest.

## Quality Gates

- Run `just check` before handing off changes.
- Keep strict TypeScript and type-aware Oxlint enabled; do not add unsafe casts or broad lint suppressions.
- Exercise filesystem behavior through real temporary directories rather than module mocks or method spies.
- Preserve the enforced coverage thresholds. New failure paths and boundary behavior require observable tests.
