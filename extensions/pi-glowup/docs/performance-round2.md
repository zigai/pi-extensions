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

## Change: compact producer-field memoization

Replace only the private per-object field table in `DecodeState`. Retain the WeakMap
owner, per-decode lifetime, detached captures, schema validation, and all traversal/budget
rules. A null-prototype record avoids Map backing-store allocation and supports exact
string-key lookup. Use an own-property check so a captured `undefined` is not reread.

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
delayed; correctness must never depend on GC/finalizer timing.

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
| Post-GC heap growth, focused workload           | 33,007,240 bytes | 162,392 bytes          |
| Surviving cached entries                        | 101              | 1 (the live component) |
| Accounted cache bytes after collection          | 29,911,040       | 215,040                |
| Confirmatory process wall time, mean of 10 runs | 3.225 s          | 3.289 s                |
| Confirmatory mean peak RSS                      | 258.3 MiB        | 256.8 MiB              |

The original-vs-cleanup confirmation replays the unmodified original patch module
through an isolated resolver without changing working source or the running session.
Retained heap growth falls **99.5%** in this discard-heavy workload. Peak RSS barely
changes because all 100 components are created synchronously before finalizers can run.
The confirmation measured a **2.0% process-wall-time cost**; this is a retained-memory
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
