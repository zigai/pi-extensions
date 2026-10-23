# Rendering-preserving performance work

## Method

Rendering fidelity is a hard constraint: no changes to preview budgets, grammar selection,
syntax colors, diff algorithms/layout, terminal safety, or lifecycle behavior. Optimize
work around rendering instead. Measurements are informational, not timing assertions.

Reproduce from `extensions/pi-glowup` (Node v26.12.0, Linux x64):

```sh
hyperfine --warmup 3 --runs 10 'node --expose-gc --import tsx benchmark/tui-rendering.ts --quick'
hyperfine --warmup 3 --runs 10 'node --expose-gc --import tsx benchmark/protocol-decoding.ts'
node --expose-gc --cpu-prof --import tsx benchmark/protocol-decoding.ts
node --expose-gc --import tsx benchmark/protocol-decoding.ts --allocations
```

The focused workload decodes 1,000 500-line mutations and 1,000 500-row summaries.
Allocation sampling includes objects collected by both minor and major GC; it estimates
allocation traffic, not retained memory. Profiler overhead affects timing/RSS, so compare
like modes. The unprofiled report includes CPU time, throughput, per-decode batch-average
p50/p95/p99, peak RSS, and post-GC heap delta. Negative heap deltas are measurement noise.
Warmup is excluded from the focused operation count, timing, and allocation sample.

## Baseline

- Renderer suite: 49 files, 891 passed, 5 skipped.
- Quick TUI benchmark: 4.268 s mean (10 runs), 429.6 MiB mean peak RSS.
- Focused decoder benchmark: 7.693 s mean process wall time, 204.6 MiB mean peak RSS.
- Focused steady state: 6,690 ms elapsed, 6,782 ms CPU, 299 decodes/s;
  p50/p95/p99 3.319/3.561/3.806 ms; post-GC heap delta -61,184 bytes.
- Sampled allocation traffic: 11,932,183,848 bytes (separate profiled run).

The quick-workload CPU profile's top five self-time sites were GC (257 ms),
TypeBox `HasPropertyKey` (227 ms), TypeBox `Stack` (198 ms), Pierre diff's
`execEditLength` (198 ms), and module compilation (152 ms). Protocol capture's
repeated interpreted scalar/schema checks feed the TypeBox sites and allocate validation
stacks on each check. Do not alter Pierre's diff algorithm to optimize this profile.

The focused baseline confirmed the source: `HasPropertyKey` 2,206 ms, `CheckSchema`
1,002 ms, GC 492 ms, `capture` 455 ms, and `Stack` 403 ms self time;
`capture` inclusive time was 5,897 ms out of 8,009 ms sampled.

## Opportunity matrix

| Opportunity                                                                | Impact | Confidence | Effort | Score |
| -------------------------------------------------------------------------- | ------ | ---------- | ------ | ----- |
| Compile fixed protocol schemas once instead of interpreting them per value | 5      | 5          | 2      | 12.5  |

## Change: specialize validation of fixed protocol schemas

Prepare each fixed schema's ordered property names and TypeBox validator once, rather
than reinterpreting schemas for every field and captured object. Retain the existing
capture/snapshot traversal: never validate a producer-owned object directly.

- Ordering preserved: capture/traversal order and resulting collection order are unchanged.
- Tie-breaking unchanged: no selection/layout/diff rules change.
- Floating-point: same TypeBox schemas and constraints; preview truncation unchanged.
- RNG seeds: N/A to production decoding; existing property tests retain their seeds.
- Golden outputs: captured **before** implementation; additional nested-metadata boundary
  cases were replayed against the saved original decoder, then compared with the optimized
  decoder before accepting the extended oracle. They hash detached decoded snapshots
  and exact ANSI frames together, across every node kind, styled Unicode/control text,
  previews, partial/completed states, expansion, and 20/80/180/80-column resize sequences.
  A separate digest covers malformed/optional-field variants including NaN/infinity.
- Producer isolation: field capture, getter read counts, cycle/depth/text/collection limits,
  and detached snapshots remain unchanged; existing adversarial tests cover these.

Verify without regenerating the committed oracle:

```sh
node --import tsx benchmark/protocol-decoding.ts --golden /tmp/protocol-decoding.json
cmp test/tools/protocol/golden/protocol-decoding.json /tmp/protocol-decoding.json
sha256sum -c test/tools/protocol/golden/golden_checksums.txt
npm run test:vitest
npm run test:pty
```

The checksum checks the stored oracle; `cmp` and the golden Vitest test verify freshly
rendered output against it. Never update golden digests to accommodate an optimization.

## Results

| Metric                                       | Before                   | After                    |
| -------------------------------------------- | ------------------------ | ------------------------ |
| Focused process wall time, mean of 10 runs   | 7.693 s                  | 1.562 s                  |
| Focused process CPU, mean of 10 runs         | 8.205 s                  | 1.916 s                  |
| Focused process peak RSS, mean of 10 runs    | 204.6 MiB                | 199.6 MiB                |
| Focused steady-state CPU, one unprofiled run | 6,782 ms                 | 602 ms                   |
| Focused steady-state throughput              | 299 decodes/s            | 3,258 decodes/s          |
| Focused batch-average p50 / p95 / p99        | 3.319 / 3.561 / 3.806 ms | 0.293 / 0.433 / 0.490 ms |
| Focused sampled allocation traffic           | 11.93 GB                 | 1.13 GB                  |
| Quick TUI process wall time, mean of 10 runs | 3.422 s                  | 2.731 s                  |
| Quick TUI process CPU, mean of 10 runs       | 4.764 s                  | 4.012 s                  |
| Quick TUI process peak RSS, mean of 10 runs  | 431.4 MiB                | 427.6 MiB                |

The quick TUI results in this table are a final confirmation after the repository tests
finished: the saved original decoder was replayed with an isolated resolver, without
changing the working source or running session. Each version had 3 warmups and 10 runs.
This removes the initial baseline's overlap with renderer tests: the confirmation shows
20.2% lower TUI wall time and 15.8% lower whole-process CPU, rather than the preliminary
30.5% wall-time improvement. Process wall-time p50/p95/p99 was 3.401/3.540/3.540 s before
and 2.701/2.855/2.855 s after (only 10 process samples; not a tail-latency guarantee).

That is 91.1% less focused steady-state CPU and 90.5% less sampled allocation traffic;
whole-process startup/import cost remains. Peak RSS barely changes: this removes
short-lived allocation pressure, not most retained renderer/grammar memory.
The after-run post-GC heap delta was -51,160 bytes (no measured retained growth).

Re-profiling the focused workload leaves `capture` (238 ms), `readField` (205 ms),
module compilation (161 ms), GC (70 ms), and `decodeVariant` (53 ms) as the top five
self-time sites. `capture` inclusive time falls to 421 ms. No additional optimization
lever is included in this change. The broader profile still includes substantial
Pierre diff, parsing, and tool-owner fixture work; those algorithms are untouched.

Verification: the full root `npm run check` passed, including architecture, settings,
formatting/lint, types, root/workspace tests, package consumers, 892 Glowup renderer tests
(5 pre-existing skips), and all 15 real-process PTY tests. Fresh golden output matches
the stored baseline and `sha256sum -c` passes. Existing lint warnings are unchanged.

Rollback: find the `perf(pi-glowup): precompile protocol snapshot validation` commit
with `git log --oneline -- src/tools/protocol/decode.ts`, then `git revert <sha>`.
Re-run the golden checks and renderer/PTY suites after rollback.

Further profiling, retained-memory work, and rejected experiments: [round 2](performance-round2.md).
