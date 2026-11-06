# Upstream performance integration

Measured on 2026-11-06: AMD Ryzen 9 7900X (12 cores / 24 threads), Linux 7.2.14-arch1-1 x86_64, Node v26.13.0.

## Comparison

- Before: local `c44d41a1`, including all ten local commits.
- After: that baseline merged with upstream `480e2929` (18 commits), before formatting/document-generation cleanup.
- Identical upstream benchmark harnesses for both versions; only source import paths were adjusted in temporary copies under `.cache/upstream-perf`.
- Five samples per fixture, explicit GC before each sample, medians below. Sequential runs on the same machine; no repository checks ran during the benchmark. This was not an idle-machine, CPU-pinned, randomized trial.
- All output hashes matched before/after for every measured fixture, including all highlight sizes and timestamp cases.

| Workload                                            | Before (ms) | After (ms) | Speedup |
| --------------------------------------------------- | ----------- | ---------- | ------- |
| Footer: 100 redraws, 1,000 session entries          | 12.21       | 1.90       | 6.4×    |
| Footer: 100 redraws, 10,000 session entries         | 98.86       | 1.64       | 60.4×   |
| Footer: 100 redraws, 30,000 session entries         | 296.09      | 1.31       | 226.7×  |
| Highlights: scan 5,000 bare filenames               | 47.67       | 0.95       | 50.0×   |
| Highlights: 20 editor decorations, 5,000 filenames  | 947.42      | 20.41      | 46.4×   |
| Highlights: 20 editor decorations, 5,000 mixed refs | 1,063.56    | 67.56      | 15.7×   |
| Response: 30 streaming heading-rich renders         | 2,404.50    | 244.03     | 9.9×    |
| Timestamp: 10,000 ASCII-padded rows                 | 197.80      | 13.75      | 14.4×   |
| Timestamp: 10,000 ANSI-padded rows                  | 214.84      | 54.68      | 3.9×    |
| Timestamp: 10,000 Unicode rows                      | 170.49      | 188.78     | 0.90×   |
| Timestamp: 10,000 control-rejection rows            | 33.85       | 44.40      | 0.76×   |

The timestamp Unicode and rejected-control fixtures were approximately 11% and 31% slower respectively in this run; these are not universal improvements. A separate controlled investigation would be needed to distinguish persistent regressions from run/JIT variance.

Footer timings mostly measure the warm revision cache: projection calls drop from 100 per sample to one in the first candidate sample, then zero in later samples. They do not measure 100 session revisions. Even the first candidate sample includes a cold projection.

These are synthetic component benchmarks, not full-terminal latency or startup measurements. Editor decoration excludes native editor layout and terminal painting. This small suite does not measure every upstream optimization (policy reconciliation, prompt search, command preparation, collation, or rendering-resource lifetimes).

## Integration notes

The merge preserved the local formatting/build changes and editor keymap fix. Settings README regions were regenerated with the locally updated generator, and the new upstream shell benchmark was formatted with shfmt.

The full check also exposed hash-pinned Codex prompts/tool guidance that the earlier local Markdown formatting had changed. Those assets were restored byte-for-byte from upstream rather than changing the integrity tests. Root and package Markdown recipes now exclude those runtime assets; Git whitespace checking permits the upstream prompts' original trailing whitespace.

Verification: `just check` passed all 11 checks, including formatting, lock consistency, architecture, collection, generated settings, language catalog, lint, types, build, packaging, and all workspace tests. The running personal Pi session was not reloaded.

## Reproduce

Run from the repository root with dependencies installed. Use the same harness files against both source versions; the baseline predates these harness files. Do not reload the personal Pi session. Temporary copies can replace `../src/` imports with absolute paths into the source checkout under test. The response harness resolves the source directory from the working directory.

```sh
node --import tsx --expose-gc extensions/pi-footer/benchmark/routed-footer.ts 5
node --import tsx --expose-gc extensions/pi-message-highlights/benchmark/highlight-ranges.ts 5 20
node --import tsx --expose-gc extensions/pi-message-timestamps/benchmark/timestamp-rendering.ts 5 10000
for sample in 1 2 3 4 5; do
  node --import tsx --expose-gc extensions/pi-response-renderer/benchmark/presentation.ts after headings-stream
done
```

The response harness's `after` argument selects the current checkout, not a provenance label: baseline response samples also contain `variant: "after"`. Their actual provenance is recorded by the enclosing `before`/`after` groups in [the complete raw samples](upstream-integration.json). Timings exclude process startup and imports.
