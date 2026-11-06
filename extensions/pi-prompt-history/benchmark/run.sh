#!/usr/bin/env bash
set -euo pipefail
# From repository root; baseline was copied before any edits to this extension.
stage=.cache/perf-followup/history/runner-before
mkdir -p "$stage/src" "$stage/benchmark"
cp .cache/perf-followup/history/original/src/{search,source}.ts "$stage/src/"
# This class is imported but never instantiated in the baseline branch.
cp extensions/pi-prompt-history/src/history-index.ts "$stage/src/"
cp extensions/pi-prompt-history/benchmark/history.ts "$stage/benchmark/"
TIMEFORMAT='process wall=%3R user=%3U system=%3S'
for mode in cold-query queries ingestion scan scan-only; do
  for variant in before after; do
    runner=extensions/pi-prompt-history/benchmark/history.ts
    if [[ "$variant" == before ]]; then runner="$stage/benchmark/history.ts"; fi
    time node --expose-gc --import tsx "$runner" "$variant" "$mode"
  done
done
