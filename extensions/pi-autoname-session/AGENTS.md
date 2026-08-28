# AGENTS.md

Guidance for agents working in this repository.

## Working method

1. Inspect `package.json`, the affected source modules, and the installed Pi types or documentation for every Pi API being changed. Do not guess at lifecycle, model-registry, provider-auth, or session-entry contracts.
2. Preserve session ownership and stale-result rejection before changing naming behavior. A picked name must never overwrite a newer session, branch, or user rename.
3. Keep persisted settings, session entries, provider payloads, and model output parsed at their boundaries. Pass typed domain values inward.
4. Add behavior evidence at the seam that owns the change, regenerate settings artifacts when required, and run the release gate before handoff.

Run `just setup` after cloning. For later changes, run:

```sh
npm run check
```

The check validates generated settings, formatting, lint, strict TypeScript, and the Vitest suite. Keep pre-commit enabled. Use `just coverage` when coverage evidence is useful. The repository has real tests; do not retain or reintroduce `--passWithNoTests` when modernizing scripts.

## Package and module contract

- This is a TypeScript ESM Pi extension package. `package.json` declares `src/index.ts` in `pi.extensions`; the entry exports a synchronous default factory receiving `ExtensionAPI`.
- Keep module import and the factory free of settings I/O, model calls, timers, and other owned background work. Register lifecycle handlers synchronously.
- `src/index.ts` owns Pi composition and session lifecycle: settings application, state restoration, event registration, naming attempts, cancellation, diagnostic presentation, and cleanup.
- `src/session-naming.ts` owns pure naming rules: persisted-state parsing, metrics, trigger decisions, prompt/context construction, repository summaries, and output normalization.
- `src/picker-request.ts` owns the narrow provider-payload compatibility boundary. Parse payloads from `unknown`; return no replacement when the model or payload does not require the compatibility shape.
- `src/settings.ts` currently owns the legacy settings definition, semantic validation, model-reference parsing, and package-facing loader. Do not move unrelated naming logic into it.
- Keep the source root flat while these capabilities remain cohesive. Do not add generic `utils.ts`, `helpers.ts`, `services.ts`, or one-file directories.
- Keep Pi-provided packages in optional `peerDependencies` with `"*"` and in `devDependencies` for local checks. Put other runtime libraries in `dependencies`.

## Session lifecycle and concurrency

- `session_start` is the activation and reset boundary for this extension because naming state must be restored before the first `before_agent_start` event. Abort the predecessor session, increment the generation, reset diagnostic and retry state, load settings once, and restore state from the active branch.
- Invalid settings disable naming for that session but still count as completed activation. Present loader and semantic diagnostics once and only when `ctx.hasUI` is true.
- Prompt-timed initial naming runs in the background so it does not delay the user's agent turn. Settled naming may be awaited from `agent_settled`. Keep those timing semantics explicit in tests.
- Own every background naming promise in `backgroundNamingTasks`. Attach rejection handling immediately, remove settled tasks, abort on shutdown, and await all remaining tasks before clearing ownership.
- Every naming attempt is session-owned. Preserve the abort controller plus generation, name revision, starting name, and starting leaf checks. A result may call `pi.setSessionName()` only while all of those identities still match.
- A user rename, branch navigation, session replacement, reload, or shutdown invalidates work computed against the old state. Do not weaken this because a model call appears likely to finish quickly.
- Distinguish an extension-initiated `session_info_changed` event from a user rename through `pendingAutoName`. User renames invalidate attempts and establish a fresh baseline.
- Restore branch-local state after `session_tree`. Persist successful baseline changes through `pi.appendEntry()` using `AUTONAME_STATE_ENTRY_TYPE`; do not use process-global persistence for session state.
- `session_shutdown` must abort session and attempt controllers, invalidate state, increment the generation, await background tasks, and leave no promise capable of renaming a later session.

## Naming and model boundaries

- Persisted custom-entry data is untrusted. Validate it with TypeBox, preserve the explicit state version, accept the intentional legacy shape, and distinguish invalid data from unsupported future versions.
- Count and context rules must remain deterministic across reload, branch navigation, compaction summaries, missing legacy usage, and circular or non-JSON tool arguments.
- Preserve prompt-context limits. Truncation must bound model input while retaining useful head and tail context; repository guidance contents must not be copied into picker prompts.
- Resolve picker models through `ctx.modelRegistry`, including provider auth, headers, environment, and credential-free providers. Do not infer credentials directly from environment variables.
- Compose session cancellation and the configured timeout into the model request. Classify cancellation, timeout, authentication failure, unavailable models, provider failure, and invalid output without exposing credentials or prompt contents.
- Keep the Responses Lite payload adjustment narrowly gated by provider, API, model/header evidence, and parsed object payloads. Do not mutate the provider payload in place.
- Normalize model output before setting a name and enforce configured length constraints. Model text is boundary input, not a trusted session name.

## Extension settings

- This repository currently uses the legacy `@zigai/pi-extension-settings` 0.4.2 single-file definition in `src/settings.ts`, and its npm package bundles that dependency. Keep ordinary feature changes truthful to that current layout unless the task explicitly includes the settings-runtime migration.
- The target settings architecture is the current prevalidated runtime. Migrate atomically: use the exact supported `@zigai/pi-extension-settings` version as a normal runtime dependency, remove it from `bundleDependencies`, move the build-safe TypeBox definition to `src/settings-input.ts`, generate `src/settings.prevalidated.ts`, hydrate it with `definePrevalidatedExtensionSettings` in `src/settings.ts`, derive decoded values with `StaticDecode`, update `piExtensionSettings` and `files`, regenerate artifacts, and verify the packed npm topology. Do not leave a half-migrated combination of old and new APIs.
- Keep the root settings object closed with `additionalProperties: false`. Every option needs a valid default and a user-facing description. Use TypeBox codecs for encoded-to-decoded transformations instead of unchecked casts.
- Define `exampleSettings` only when structured or interacting options need one focused, realistic advanced example. Give complex array-item and record-value schemas concise PascalCase titles so generated tables stay readable.
- Resolution applies defaults, global settings, then trusted-project settings. Objects merge recursively; arrays and scalar values replace earlier values.
- Never hardcode `~/.pi/agent` or `.pi`. Use the Pi settings adapter, `getAgentDir()`, `CONFIG_DIR_NAME`, and `ctx.isProjectTrusted()` as appropriate.
- Loading may scaffold a missing global settings file and install or refresh its schema. It never repairs existing settings or creates project settings. Keep malformed or invalid files unchanged, and never include raw setting values or secrets in diagnostics.
- If the extension gains settings-writing UI, first migrate to the current runtime and use `updatePiExtensionSettings()` rather than adding a custom lock or atomic writer. Project writes require trust and may explicitly create a missing project file; snapshot editors use the loaded revision for conflict detection.
- Run `npm run config:generate` after changing the definition. Never hand-edit `config.schema.json` or the README text between the settings markers. `npm run config:check` must remain the first pre-commit and CI settings gate.

## Verification

- `test/index.test.ts` owns extension composition and lifecycle behavior. Preserve coverage for session replacement, shutdown, background rejection, stale attempts, user renames, branch navigation, disabled or malformed settings, and diagnostic deduplication.
- `test/session-naming.test.ts` owns naming-domain and persisted-boundary behavior. Add focused cases for metrics, trigger baselines, truncation, state versions, prompt substitution, repository context, and output normalization.
- `test/picker-request.test.ts` owns provider-payload compatibility behavior. Cover positive and negative provider/header/model evidence and malformed payloads.
- Use temporary directories for settings tests and restore environment overrides. Do not write test data into the repository or shared Pi agent directory.
- Test observable behavior through the extension harness or module boundary. Do not export implementation details merely for tests, and do not replace the subject under test with module mocks.
- For package manifest, dependency, or `files` changes, inspect `npm pack --dry-run` and ensure runtime dependencies remain available when Pi installs the package without development dependencies.
