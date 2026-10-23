# Further rendering-preserving optimization

This round starts at `40374f15`, after fixed protocol schema compilation. Rendering
quality/output, all preview and syntax settings, and execution semantics are hard
constraints. Reproduce the baseline commands from `performance.md`; no renderer limits
or grammar/layout choices may be changed to improve these measurements.

## Fresh baseline and profile

Node v26.12.0, Linux x64; `hyperfine --warmup 3 --runs 10`:

| Metric                                | Baseline                 |
| ------------------------------------- | ------------------------ |
| Quick TUI process wall time           | 2.701 s mean             |
| Quick TUI mean peak RSS               | 426.8 MiB                |
| Focused decoder process wall time     | 1.279 s mean             |
| Focused decoder mean peak RSS         | 198.7 MiB                |
| Focused steady-state CPU              | 527.617 ms               |
| Focused steady-state throughput       | 3,969 decodes/s          |
| Focused batch-average p50 / p95 / p99 | 0.243 / 0.280 / 0.298 ms |
| Focused sampled allocation traffic    | 1,131,021,232 bytes      |
| Focused post-GC heap delta            | -54,896 bytes            |

The fresh quick-workload profile's top five self-time sites were GC (187 ms),
Pierre `execEditLength` (183 ms), module compilation (136 ms), Shiki initialization
(119 ms), and `parseDiffLine` (112 ms). `readField` and `capture` remain visible at
88 and 84 ms. Do not change Pierre or highlighting algorithms to optimize these sites.

A fresh focused decoder profile confirms `capture` (228 ms), `readField` (223 ms),
module compilation (123 ms), GC (69 ms), and `decodeVariant` (42 ms) as the top five.
Each decoded producer object/array currently allocates a Map to memoize fields, in
addition to the detached result object; `readField` never needs ordered iteration.

## Opportunity matrix

| Opportunity                                                                     | Impact | Confidence | Effort | Score |
| ------------------------------------------------------------------------------- | ------ | ---------- | ------ | ----- |
| Replace per-producer field memoization Maps with private null-prototype records | 3      | 5          | 2      | 7.5   |

## Rejected change: compact producer-field memoization

The experiment replaced only the private per-object field table in `DecodeState`,
retaining the WeakMap owner, per-decode lifetime, detached captures, schema validation,
and traversal/budget rules. The hypothesis was that a null-prototype string-key table
would reduce Map overhead. An own-property check kept captured `undefined` values from
being reread. Measurement rejected this hypothesis; the original Map remains.

- Ordering preserved: producer fields and arrays are still read in exactly the same
  schema/index order. The memo table is only queried, never iterated for output.
- Tie-breaking unchanged: no selection, pairing, diff, or layout rules change.
- Floating-point: identical; validators, numeric limits, and preview truncation unchanged.
- RNG seeds: unchanged in existing property tests; no RNG in production decoding.
- Producer isolation: still read each field once, including undefined-returning getters;
  private tables have no prototype setters and never become decoded output.
- Golden outputs: the committed oracle and a fresh baseline capture match before editing.
  Compare freshly generated output with the oracle, then run `sha256sum -c`.

```sh
node --import tsx benchmark/protocol-decoding.ts --golden /tmp/protocol-decoding-round2.json
cmp test/tools/protocol/golden/protocol-decoding.json /tmp/protocol-decoding-round2.json
sha256sum -c test/tools/protocol/golden/golden_checksums.txt
```

### Rejected experiment: memo table representation

The record experiment preserved the golden output but **regressed** the focused decoder:
CPU 528 → 670 ms and sampled allocations 1.13 → 1.39 GB. It was immediately reverted;
no memo-table implementation change is included. V8's null-prototype dictionaries are
not cheaper here. Profiling locates candidates; measurement decides whether they land.

## Retained completed-line memory

An ownership review identified the global completed-line LRU strongly holding line states
after their wrapper components die. The LRU is bounded (64 MiB), but dead transcript
components can leave tens of MiB resident until eviction or reset.

The new `benchmark/completed-cache.ts` creates one live completed component and 100
abandoned components, each rendering 2,048 styled rows. It runs isolated fake Pi
prototype patches, not the personal session. It hashes the live component's exact ANSI
frames across hits, invalidation, and widths 80/40/180/40/80. GC is exposed only in this
benchmark; production must not request GC. Six collection/event-loop cycles allow
normal WeakRef and finalizer job boundaries to pass. Heap-snapshot runs are separate
from timing/RSS runs.

```sh
hyperfine --warmup 3 --runs 10 'node --expose-gc --import tsx benchmark/completed-cache.ts'
node --expose-gc --import tsx benchmark/completed-cache.ts --snapshot /tmp/completed.heapsnapshot
node --expose-gc --import tsx benchmark/completed-cache.ts --golden /tmp/completed-cache.sha256
cmp test/pi/golden/completed-cache.sha256 /tmp/completed-cache.sha256
sha256sum -c test/pi/golden/golden_checksums.txt
```

Baseline: 3.273 s mean process wall time, 257.6 MiB mean peak RSS (10 runs).
The focused creation loop took 2,250 ms (2,292 ms CPU), 44.4 components/s,
p50/p95/p99 22.34/24.41/25.13 ms. After collection, all **101** entries remained:
29,911,040 accounted cache bytes and 33,007,240 bytes of post-GC heap growth.

The heap profile's top self-size categories are strings (56.3 MB), compiled code
(12.1 MB), arrays (8.8 MB), native objects (3.5 MB), and objects (2.9 MB).
Its 101 `cachedLines` arrays reach **33,149,680 bytes** of unique strings/backing
arrays. The source path is `completedLineCacheLru → CompletedComponentState → cachedLines`;
the LRU is module-owned. Thus this is retained memory, not just temporary allocation.
A recorded regression test confirms 21 cached-line arrays remain when only one
component is live.

| Opportunity                                                         | Impact | Confidence | Effort | Score |
| ------------------------------------------------------------------- | ------ | ---------- | ------ | ----- |
| Release an LRU line state when its completed component is collected | 5      | 5          | 2      | 12.5  |

## Change: release cache state with its dead wrapper

Register completed wrappers with a module-owned FinalizationRegistry, holding only their
already-LRU-owned line state, never the wrapper/base/source graph. Cleanup calls the
existing idempotent release function. Cache bounds stay in force even if finalization is
delayed; correctness must never depend on GC/finalizer timing. Registration exists only
while an entry is in the LRU: explicit release, eviction, and clearing unregister the
state token, so registry metadata cannot accumulate for uncached/evicted live wrappers.

- Ordering preserved: live-component cache recency and rendering order are unchanged.
  Cleanup removes only entries whose wrapper is already unreachable.
- Tie-breaking unchanged: existing LRU eviction among live entries is unchanged.
- Floating-point: N/A; no rendering arithmetic or numeric validation changes.
- RNG seeds: unchanged; no production RNG added.
- Golden outputs: capture the live ANSI frame digest before editing; compare fresh
  output and both existing protocol and completed-cache checksum manifests afterward.
- Lifetime proof: held state has only width and string-array fields; neither refers
  to its wrapper. Each wrapper has a unique state. Releasing a stale state cannot
  evict a replacement or clear a live wrapper's cache. Repeated release is a no-op.

### Completed-cache results

| Metric                                          | Original         | Cleanup                |
| ----------------------------------------------- | ---------------- | ---------------------- |
| Post-GC heap growth, focused workload           | 33,007,240 bytes | 172,696 bytes          |
| Surviving cached entries                        | 101              | 1 (the live component) |
| Accounted cache bytes after collection          | 29,911,040       | 215,040                |
| Confirmatory process wall time, mean of 10 runs | 3.273 s          | 3.321 s                |
| Confirmatory mean peak RSS                      | 257.9 MiB        | 257.6 MiB              |

The original-vs-cleanup confirmation replays the unmodified original patch module
through an isolated resolver without changing working source or the running session.
Retained heap growth falls **99.5%** in this discard-heavy workload. Peak RSS barely
changes because all 100 components are created synchronously before finalizers can run.
The confirmation measured a **1.5% process-wall-time cost**; this is a retained-memory
improvement, not a CPU speedup. Default 64 MiB/10,000-entry limits are untouched.
Finalization is opportunistic; its timing and exact savings are not guaranteed per GC.

The recorded reproduction failed before the change (21 cached-line arrays instead of
one) and passes afterward. It also verifies the live width-80 cache hit avoids rerender,
and width 40 still rerenders correctly. Existing LRU recency/budget tests pass. The old
ownership test now checks initial cache insertion before crossing the GC job boundary,
rather than requiring an orphan to remain cached after it is eligible for cleanup.

Rollback: `git revert` the `perf(pi-glowup): reclaim abandoned completed line caches`
commit. Re-run the completed-cache and protocol golden comparisons, patch tests, and
real-process PTY tests.

## Re-profile: repeated text-diff parsing

After cache cleanup, a fresh quick TUI profile still ranks `parseDiffLine` fourth by
self time (131 ms), behind Pierre diff (195 ms), GC (176 ms), and module compilation
(147 ms). The diff regex accounts for another 44 ms. Parsing is repeated by preview
selection, number-width measurement, syntax reconstruction, changed-span pairing,
unchanged-replacement filtering, and final row rendering.

`benchmark/text-diff.ts` isolates 1,000 collapsed renders of a 600-line text-file
addition through the real styled renderer (not a parser-only microbenchmark). Baseline:
1.122 s process wall time and 197.8 MiB mean peak RSS (3 warmups, 10 runs);
469 ms steady-state elapsed, 540 ms CPU, 2,131 renders/s;
batch-average p50/p95/p99 0.412/0.625/0.751 ms, post-GC heap delta 20,544 bytes,
and 1,185,555,632 sampled allocation bytes. The focused CPU profile ranks module
compilation (120 ms), `parseDiffLine` (108 ms), GC (68 ms), width truncation (67 ms),
and changed-span pairing (39 ms) as the top five self-time sites.

| Opportunity                                           | Impact | Confidence | Effort | Score |
| ----------------------------------------------------- | ------ | ---------- | ------ | ----- |
| Share parsed diff rows among passes within one render | 4      | 5          | 2      | 10.0  |

## Change: parse each diff row once per render

Build a transient parsed-row array for each section inside the render callback, and pass
it to the existing selection/width/highlight/span/row helpers. Do not change the parser,
regex, diff pairing, syntax input, selection algorithm, or output formatting. Do not
retain parsed arrays across renders, changes, width transitions, or syntax generations.

- Ordering preserved: arrays remain indexed by original section and row positions;
  selection and syntax reconstruction consume the same ordered parse results.
- Tie-breaking unchanged: all pairing and preview-selection algorithms are untouched.
- Floating-point: identical; no arithmetic or numeric coordinate formatting changes.
- RNG seeds: unchanged; no production RNG.
- Lifetime proof: the parsed arrays are local to one callback invocation, never stored
  in a component or module cache. Each resize or syntax invalidation parses current
  source again; no extra transcript-sized retained cache is added.
- Golden outputs: captured before implementation and repeated in a fresh process.
  The new oracle covers exact ANSI frames with real plain/highlighted syntax, all three
  background styles, both number styles, expanded/collapsed rendering, multiple files,
  omissions, metadata, empty/identical replacements, coordinates, Unicode, terminal
  controls, and 20/80/180/80-column resize sequences. Existing protocol goldens remain
  immutable as a second independent oracle.

```sh
node --import tsx benchmark/text-diff.ts --golden /tmp/text-diff.json
cmp test/rendering/diff/golden/text-diff.json /tmp/text-diff.json
sha256sum -c test/rendering/diff/golden/golden_checksums.txt
```

### Shared-parsing results

The final confirmation replays frozen snapshots of both the original and optimized text
renderers through an isolated resolver. Both versions receive 3 warmups and 10 runs;
no test suites run concurrently. Earlier confirmations varied with host load (including
a 5.2% TUI wall-time improvement); the final results below supersede those timings.
Focused process timing was 1.122 ± 0.022 s versus 1.061 ± 0.051 s; the final TUI
comparison was 2.680 ± 0.045 s versus 2.580 ± 0.020 s.

| Metric                                                  | Original                 | Shared parsing           |
| ------------------------------------------------------- | ------------------------ | ------------------------ |
| Focused process wall time, mean of 10 runs              | 1.122 s                  | 1.061 s                  |
| Focused process CPU, mean of 10 runs                    | 1.561 s                  | 1.520 s                  |
| Focused mean peak RSS                                   | 197.7 MiB                | 202.4 MiB                |
| Focused steady CPU, median of 3 alternating runs        | 536.626 ms               | 479.149 ms               |
| Focused steady elapsed, median of 3 alternating runs    | 458.892 ms               | 381.682 ms               |
| Focused throughput, median of 3 alternating runs        | 2,179 renders/s          | 2,620 renders/s          |
| Focused batch-average p50 / p95 / p99, median of 3 runs | 0.393 / 0.629 / 0.738 ms | 0.325 / 0.607 / 0.723 ms |
| Focused sampled allocation traffic                      | 1,182,077,272 bytes      | 808,349,680 bytes        |
| Focused post-GC heap delta, median of 3 runs            | 18,024 bytes             | 13,376 bytes             |
| Quick TUI process wall time, mean of 10 runs            | 2.680 s                  | 2.580 s                  |
| Quick TUI process CPU, mean of 10 runs                  | 3.943 s                  | 3.895 s                  |
| Quick TUI mean peak RSS                                 | 428.9 MiB                | 430.4 MiB                |

The focused workload uses **10.7% less CPU** and **31.6% fewer sampled allocation
bytes**. The quick TUI confirmation is **3.7% lower wall time** and **1.2% less CPU**.
Peak RSS does not improve (the focused high-water mark increases 4.7 MiB); post-GC
heap is essentially unchanged. Do not describe this as a retained-memory reduction.

Fresh final profiles confirm the bottleneck shifted: focused `parseDiffLine` self time
falls 108 → 29 ms, and quick TUI parser self time falls 131 → 31 ms. The focused profile
now ranks module compilation (106 ms), GC (72 ms), truncation (71 ms), the render callback
(44 ms), and syntax-run processing (43 ms) as the top five; the TUI profile instead ranks
GC (178 ms), Pierre diff (177 ms), module compilation (129 ms), Shiki initialization
(118 ms), and protocol field capture (118 ms). No diff/syntax algorithm changes are included.

A final compatibility test also covers sparse omitted rows: mapped holes retain their
original indices, and pass consumers treat missing entries as unparsed rows. Its exact
frame was replayed against the saved original renderer and matches. Explicit invalidation
and resize tests verify current row content and coordinates are recomputed, not frozen.

Rollback: `git revert` the `perf(pi-glowup): share parsed diff rows within each render`
commit. Re-run all three golden comparisons, renderer/property tests, and PTY tests.

## Final verification

The full root `npm run check` passed (exit 0), including architecture, generated settings,
formatting/lint, types, root/workspace tests, packaging, headless xterm/property coverage,
915 Glowup tests (5 existing skips), and all 19 real-process PTY tests in the combined
checkout. Earlier root attempts encountered concurrent shared-build/coverage artifact
races; the final run completed successfully. Independent static review found no
correctness regressions. All three fresh golden comparisons and checksum manifests pass.
Concurrent unrelated streaming/settings/Bash edits were left untouched and are not part
of either optimization commit. Timing reports are informational, never Vitest thresholds.
