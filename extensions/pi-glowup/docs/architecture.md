# Code ownership

`src/index.ts` is the Pi extension factory. It delegates installation to `pi/lifecycle.ts`, which constructs feature owners and connects them to Pi events.

| Area                   | Responsibility                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `pi/`                  | Installation, session transitions, syntax warmup, and Pi component patches              |
| `tools/built-in/`      | Native argument interpretation, feature state, and call/result presentation             |
| `tools/built-in/bash/` | Shell analysis, embedded scripts, formatting, streaming previews, and Bash presentation |
| `tools/external/`      | Existing tool-specific adapters retained until their owners ship verified replacements  |
| `tools/protocol/`      | Public display contracts, bounded decoding, and the generic component interpreter       |
| `rendering/`           | Shared components, headers, paths, output, and appearance policy                        |
| `rendering/diff/`      | Diff payloads, row projection, preview selection, and text/Pierre rendering             |
| `rendering/syntax/`    | Syntax recognition, highlighting, language catalogs, and theme assets                   |
| `config/`              | Settings loading and conversion into runtime options                                    |
| `diagnostics/`         | Logging and explicit diagnostic projections                                             |

The settings declaration, generated prevalidation artifact, and hydration entry remain at `src/settings-input.ts`, `src/settings.prevalidated.ts`, and `src/settings.ts`, as required by the package's settings integration. Their paths are declared in `package.json`; generated artifacts remain generator-owned.

## Dependency direction

Pi integration composes tools and rendering. Reusable rendering does not import tool features, configuration loading, diagnostics, or Pi orchestration. Tool features do not import Pi orchestration or configuration loading. They receive the options and callbacks they need. The generic protocol interpreter does not import external-tool families; `tools/renderers.ts` owns selection between the interpreter and existing adapters.

The public `@zigai/pi-glowup/protocol` export is `tools/protocol/contract.ts`. Its node definitions and builders live in `nodes.ts`, and its decoder consumes those definitions directly. This keeps the public re-exports acyclic and independent of internal rendering. The complete public dependency closure is included in the packed package.

Small shared value parsers stay in explicitly named root modules. Internal consumers import the owning module directly.

## Lifetimes

Native edit, delete, Bash, and exploration state belongs to feature instances created during installation and cleared at session boundaries. Syntax warmup owns its timer and outstanding tasks. Pi prototype hooks retain the process-wide ownership checks needed for cooperation with other extensions. Protocol mutation call/result coordination retains its existing bounded lifetime across renderer-cache replacement. Completed render caches retain their existing bounds and invalidation behavior.

File reads used to capture mutation previews live in `tools/built-in/file-snapshots.ts`. Diff payload construction and row projection remain separate from that filesystem adapter. Both text and Pierre views share diff selection and appearance policy, and use the existing syntax owner.

## Verification

Component tests mirror the source areas. `test/xterm/` checks interpreted terminal output, and `test/pty/` exercises the actual Pi process. `test/architecture.test.ts` checks dependency direction and cycles, including type-only imports. The package check packs the project and typechecks and executes a protocol consumer outside the repository, with only its schema peer supplied.

Run `just check` and `just benchmark-quick` after structural changes. Changes to source asset locations must also preserve packed-package theme resolution.
