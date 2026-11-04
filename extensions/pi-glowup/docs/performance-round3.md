# Bounded rendering work and retained memory

## Scope and baseline

This round compares a frozen **working-tree snapshot** taken before these changes,
not clean HEAD or the last release. The snapshot was based on `3df64047` plus the
operator's existing edits. Those edits and the existing golden files were left
intact. No personal Pi session was reloaded and no settings, preview budgets,
grammars, diff algorithms, or tool execution semantics were changed.

Node v26.13.0, Linux x64. Measurements below are informational synthetic workloads,
not production latency promises. Timing assertions were not added to Vitest.

## Changes

### Bound extraction demand and preserve recovery

The statement service now shares admission/accounting between parse and extraction
requests: 300 active/queued jobs and a 4 MiB competing UTF-8 source budget. A single
larger source remains eligible when the worker is idle; this is not a new script
truncation limit. Cancellation releases queued capacity immediately but accounts
for an active worker's source until that worker finishes.

Embedded previews serialize worker admission behind bounded pending/cache demand
(300 entries, 8 MiB competing source bytes). Old pending demand is reclaimable and
subsequent demand retries it. Recent demand is refreshed, an oversized individual
source remains supported, and clear/dispose settle outstanding waiters without
publishing a stale generation. Capacity misses do not become permanent cached
extraction results.

A deterministic instrumented-worker benchmark uses the real extraction function;
it measures admission and retained source references, not worker latency or heap.

| Burst of 1,000 requests                          |     Before |     After |
| ------------------------------------------------ | ---------: | --------: |
| Direct extraction jobs admitted                  |      1,000 |       300 |
| Embedded pending entries                         |      1,000 |       255 |
| Referenced UTF-8 source bytes in embedded demand | 32,796,780 | 8,363,231 |

Both versions reproduce identical latest and evicted-source recovery results.
An overloaded real Bash-renderer test compares exact ANSI at widths 60/24/180/60.
Sources larger than the competing budget have a separate no-truncation test.

### Unsubscribe superseded Pierre highlights

The scheduler tracks subscribers to each key. Replacing a component's pending key
removes queued work only when no current subscriber needs it. An active operation
stays joinable if the call changes A→B→A. Promise reactions weakly reference their
component; the completed cache weakly references the component-owned highlighted
value, not a disposable result wrapper.

For 100 updates to one reused component, pending highlight jobs fall **100→1**.
Median enqueue-to-settled workload time falls **217.5→92.3 ms** (three runs).
This includes payload construction and timer scheduling, not just highlighting.
The final exact ANSI digest is unchanged. Tests also cover shared consumers and
active-operation re-subscription.

### Incremental write-preview bookkeeping

The streaming owner snapshots the primitive argument fields, sharing the current
string rather than retaining a chain of previous arguments. This matters when a
producer mutates its argument object in place. Append-validated input updates
LF-only statistics from the appended suffix. Passthrough display previews reuse
bounded scanner state; rewrites/truncations reset it. A bounded raw line prefix
repairs split surrogate/grapheme boundaries, CRLF split across updates is handled,
and invisible runs of pending blank lines are counted without visiting every row.

Direct render calls and transformed display streams without append identity retain
the safe rebuild path. Exact `startsWith` rewrite detection still examines prefixes;
this is **not a claim of linear total streaming cost**.

Real renderer, ANSI theme, 100 columns, 128-byte appends, passthrough `streamCode`,
three repetitions per size; timing includes hashing every rendered update:

| Updates | Final input | Before median | After median | Speedup |
| ------- | ----------: | ------------: | -----------: | ------: |
| 500     |    62.5 KiB |      524.4 ms |     310.4 ms |   1.69× |
| 1,000   |     125 KiB |    1,673.1 ms |     650.2 ms |   2.57× |
| 2,000   |     250 KiB |    4,318.0 ms |   1,115.1 ms |   3.87× |
| 4,000   |     500 KiB |   18,208.3 ms |   2,572.8 ms |   7.08× |

All-update ANSI hashes match at every size. Another **1,240 exact frames** match
the frozen original across head/moving previews, direct/streamed paths, widths
18/40/100/23/100, CRLF, Unicode/ZWJ/combining/surrogate edges, rewrites and truncation.
Seeded properties additionally cover deferred draws and transformed streams. A
mutable-argument reproduction caught a stale `+N` header in an early candidate;
snapshotting primitives fixes it and has a dedicated regression test.

A retained-heap check caught a second early-candidate regression: short sliced
samples pinned old full-input buffers (about 2.4 MiB of extra retention in a 500 KiB
stream). Incremental samples now detach their bounded code units with UTF-16, not
UTF-8, so unmatched surrogates remain byte-for-byte equivalent at rendering.
Three final 4,000-update runs retain 1.51 MiB before versus 1.54 MiB after (post-GC
heap growth, including renderer/JIT state), with about 64 KiB of additional Buffer
pool storage. Final ANSI digests match; the multi-input retention is gone.

### Reclaim idle hidden syntax sources without color flashes

A collapsed exploration result now retires **source-only idle** syntax ownership
and avoids constructing its hidden output text. It deliberately retains finished
colors, previous colored results, pending jobs and readiness/capacity requests.
Aggressively discarding those would introduce uncolored first frames on re-expansion.

In a renderer-only experiment with twelve 1 MiB plain sources, stable callbacks and
hidden components, post-GC external source retention falls **12,582,952→40 bytes**.
This is an ownership/lifetime result, **not a production 12 MiB saving guarantee**:
Pi may still own the same input strings in its transcript. Completed syntax-rich
results intentionally retain their colors. Tests compare the first reopened frame,
pending collapse/reopen, and exact colored frames through resizing.

### Share the budget with inner Pierre caches

Pierre's two ANSI width caches and its derived unified/split row caches now use the
same reclaimable global byte/entry pool as completed render frames. The finalizer
and LRU hold data state only, never components. Cache accounting is an estimate of
UTF-8 strings and row/span overhead, not an exact V8 heap or RSS limit. Payload and
syntax-result ownership are separate from this derived-data budget.

**Frames have priority over derived rows.** Row admission cannot evict an existing
frame; frame admission reclaims derived rows first. This is important for repaint
responsiveness. The initial uniform-LRU experiment cut memory but regressed a
100-component workload from roughly 12→22 seconds by discarding finished frames;
it was rejected. The tiered policy below preserves frame hits when their working
set fits the configured budget.

Three alternating runs; each live component replaces a 400-line file, renders at
80/180/80, crosses six GC/event-loop cycles, then redraws at 180/80. Every frame is
hashed. The retained-heap measurement includes required payloads as well as caches.

| Default 64 MiB budget, 100 live components |     Before |      After |
| ------------------------------------------ | ---------: | ---------: |
| Post-GC heap growth, median                | 184.96 MiB | 102.76 MiB |
| Timed redraw + frame hashing, median       |    94.9 ms |    96.3 ms |
| Process wall time, mean                    |   12.683 s |   12.533 s |
| Process CPU, mean                          |   14.387 s |   13.873 s |
| Peak RSS, mean                             |  518.9 MiB |  466.6 MiB |

Retained heap falls **44.4%** in this workload. All ANSI digests match. The small
redraw/process timing differences are not a statistically established speedup.

A deliberately undersized **4 KiB** budget with 30 live components reduces post-GC
heap growth **56.29→2.99 MiB**, but process time increases **4.547→9.040 s** because
full frames cannot be cached and must be rebuilt. This is an explicit memory/CPU
tradeoff under cache pressure, not a general performance win. No visible rows or
syntax are removed to meet the budget.

## Mixed-workload confirmation

Five alternating process runs after warming both module paths, without this task's
own tests running concurrently. Other work on the shared host/checkout was not
controlled. `benchmark/tui-rendering.ts --quick` exact output hashes match across
all runs.

| Metric                  |    Before |     After |
| ----------------------- | --------: | --------: |
| Process wall time, mean |   3.570 s |   3.888 s |
| Process CPU, mean       |   5.108 s |   5.554 s |
| Peak RSS, mean          | 507.5 MiB | 504.5 MiB |

The mixed workload is **8.9% slower by wall time** in this sample; do not describe
this round as an across-the-board speedup. Process times were variable: baseline
3.10–4.15 s, candidate 3.42–4.43 s. The useful wins are the measured
streaming path, avoided obsolete work, and bounded retained memory. These short
sample sets do not establish tail latency or significance.

## Verification and known baseline failures

- 1,604 non-PTY tests pass, five existing skips; the two existing golden tests fail
  in both the frozen original and final checkout. They were not updated to hide
  those mismatches.
- Fresh protocol and text-diff corpus captures compare byte-for-byte with the frozen
  pre-change sources, including the portions that already differ from stored goldens.
  The 1,240 write frames and all focused/mixed benchmark hashes also match exactly.
- All **25 real-process Pi PTY tests** pass against rebuilt `dist/`; headless xterm
  composition is included in the non-PTY suite. Colored eviction/resize, shared
  consumers, active A→B→A, hidden pending/reopen, mutable args and overload recovery
  have focused coverage. Three retention reproductions failed against the frozen
  original before their fixes.
- Source-only TypeScript checking passes. The ordinary workspace check still has
  the same **26 existing `keyText` test-context errors**, reproduced unchanged with
  the frozen original. Formatting/lint pass for the final implementation.
- Root `npm run check` passes build and root gates, then stops in the unrelated
  `pi-autoname-session` packed-install test: its installed Pi dependency tree lacks
  the `PI_ATTRIBUTION` export requested by `pi-agent-core`. That package/dependency
  work was left untouched. Therefore the aggregate repository gate is **not green**.
- This task made no commits or personal settings changes, and performed no
  running-session reloads or visible-terminal demonstrations. Rendering equivalence here is relative to the starting
  working tree, not certification of its earlier unrelated edits.

## Reproduction

From `extensions/pi-glowup`, with `baseline` pointing to the saved extension snapshot
and the new benchmark scripts copied into that snapshot's `benchmark/` directory:

```sh
node --import tsx benchmark/extraction-queue.ts "$baseline"
node --expose-gc --import tsx benchmark/render-retention.ts queue
node --expose-gc --import tsx benchmark/render-retention.ts hidden
node --expose-gc --import tsx benchmark/render-retention.ts caches 100 67108864
node --expose-gc --import tsx benchmark/render-retention.ts caches 30 4096
WRITE_PREVIEW_CAPTURE=/tmp/write-frames.json node --expose-gc --import tsx benchmark/write-preview.ts
node --expose-gc --import tsx benchmark/write-preview.ts --memory
node --expose-gc --import tsx benchmark/tui-rendering.ts --quick
node --import tsx benchmark/protocol-decoding.ts --golden /tmp/protocol.json
node --import tsx benchmark/text-diff.ts --golden /tmp/text-diff.json
npm run test:vitest
npm run test:pty:dist
npm run check
```

Repeat workload commands from both directories and compare their captures; never
regenerate the existing committed golden files to accommodate an optimization.
Private evidence, frozen sources, the alternating-run driver, raw measurements,
rejected uniform-LRU results and a task-only reverse-applicable patch are retained
under `~/.cache/pi-glowup-performance-round3-20261104/`.
