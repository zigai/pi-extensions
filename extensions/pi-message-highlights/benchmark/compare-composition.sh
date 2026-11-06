#!/usr/bin/env bash
set -euo pipefail
# Run from repository root, serially on an otherwise idle host.
# The baseline is a pre-edit SOURCE COPY, never git HEAD.
baseline=${1:-.cache/perf-followup/rendering/original}
frames=${2:-3000}
output=${3:-.cache/perf-followup/rendering/comparison}
current=extensions/pi-message-highlights
mkdir -p "$baseline/benchmark" "$output"
cp "$current/benchmark/assistant-composition.ts" "$baseline/benchmark/assistant-composition.ts"
node --version | tee "$output/runtime.txt"
for variant in before after; do
    source=$current
    if [[ $variant == before ]]; then source=$baseline; fi
    TIMEFORMAT='process wall=%R user=%U system=%S'
    { time node --expose-gc --import tsx "$source/benchmark/assistant-composition.ts" "$frames" \
        > "$output/$variant.jsonl"; } 2> "$output/$variant-process.txt"
    cat "$output/$variant.jsonl" "$output/$variant-process.txt"
done
