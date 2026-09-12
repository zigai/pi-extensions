# Audit acceptance contracts

The default `npm test` remains the non-PTY Vitest lane followed by the existing real Pi PTY suite. Three ordinary test files were added: filesystem preimage boundaries, preview-store histories, and semantic diff selection. They contain 18 authored cases, including three generated properties. Their Vitest execution and TypeScript 6 typecheck were unavailable in the audit environment; do not treat the added case count as a passing result.

The separate `*.regression.ts` files assert unresolved requirements. They use ordinary positive acceptance assertions, not `test.fails`, skips, retries, or inverted expectations. They intentionally do not match default test discovery. Run them explicitly:

```sh
npm run test:regressions
# Or one contract:
npm run test:regressions -- test/audit/lockfile.regression.ts
npm run test:regressions -- test/audit/registration.regression.ts
npm run test:regressions -- test/audit/session-preimages.regression.ts
```

The manifest/lockfile declaration mismatch is statically confirmed. The registration call graph directly violates the no-settings-I/O rule. The capture/finish cases encode source-derived clear-during-await histories; they still need execution with the real dependencies and confirmation of host event ordering. The regression runner itself was blocked by missing dependencies. Do not describe any of these cases as an observed Vitest failure from this audit.

After fixing a requirement, promote its file to the ordinary `.test.ts` lane and remove it from this unresolved profile. The default suite must never be described as discharging these acceptance contracts while they remain outside it.

## Property replay

The two new property files use the existing `@fast-check/vitest` curried API and a default seed of `0x5eed2026`. The cache reference model recomputes an admissible insertion suffix; it does not reproduce production incremental counters. A `get` does not refresh recency. Oversized insertion currently evicts older entries before evicting itself; changing that policy requires a deliberate contract update.

```sh
npm run test:properties
npm run test:model
# Copy the seed and path from a failure; keep the test-name filter specific.
FC_SEED=1592598566 FC_PATH='0:0' npm run test:model -- -t 'matches a recomputed insertion-suffix model'
# To explore a different seed, omit FC_PATH and supply FC_SEED.
```

The seed/path above illustrate command syntax, not a stored failing case. `FC_SEED`/`FC_PATH` affect the new properties only; the pre-existing streaming properties retain their own fixed seeds. Fast-check shrinking paths depend on the exact property, generator, and library version. Preserve the minimized semantic history as a normal example when a new defect is found.

## Filesystem and coverage boundaries

The filesystem tests use private temporary directories, synthetic markers, and real symlinks. They require a filesystem/account that can create symlinks; failure to create one is infrastructure failure, not a passing or silently skipped security test. The canonical-path candidate blocks stable outward symlinks while preserving explicit outside-cwd metadata access. It is not an atomic sandbox against concurrent directory replacement, and stat-before-read is not a strict allocation bound.

`npm run coverage` now measures the in-process test lane over `src/**/*.ts`, excluding the two generated files named in `test/coverage.config.ts`. There are 90 source files in that denominator for this snapshot. It does not instrument the spawned Pi CLI, native node-pty internals, or external packages. No percentage threshold is imposed. Settings and language generation checks remain part of `npm run check`.

The archive-level `validation/` directory contains direct-source witnesses used when dependencies were unavailable. It is evidence tooling, not another project test runner. Read the assessment's execution record before merging the candidate changes.
