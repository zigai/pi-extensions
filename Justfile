# Install repository dependencies
setup:
    @npm ci

# Install the extension into Pi
install:
    pi install .
    @printf 'installed  %s  pi extension\n' 'pi-extensions-monorepo'

# Format every supported first-party file type
format:
    @git ls-files -co --exclude-standard -z | while IFS= read -r -d '' file; do if [[ -f $file ]]; then printf '%s\0' "$file"; fi; done | xargs -0 -r oxfmt --no-error-on-unmatched-pattern '!**/*.md'
    @git ls-files -co --exclude-standard -z | while IFS= read -r -d '' file; do if [[ -f $file ]]; then printf '%s\0' "$file"; fi; done | xargs -0 -r shfmt -f | xargs -r -d '\n' shfmt -w
    @git ls-files -co --exclude-standard -- Justfile justfile "*.just" | while IFS= read -r file; do just --justfile "$file" --fmt || exit $?; done
    @just markdown fmt --exclude extensions/pi-footer/README.md,extensions/pi-goal/CHANGELOG.md,extensions/pi-input-corrections/README.md,extensions/pi-keymap-tweaks/README.md,extensions/pi-mention-anything/README.md,extensions/pi-mention-project/README.md,extensions/pi-mention-skill/README.md,extensions/pi-message-highlights/README.md,extensions/pi-message-timestamps/README.md,extensions/pi-model-alias/README.md,extensions/pi-model-filter/README.md,extensions/pi-model-modes/CHANGELOG.md,extensions/pi-model-modes/README.md,extensions/pi-response-renderer/test/fixtures,extensions/pi-settings-ui/README.md,extensions/pi-status-bar/README.md,extensions/pi-tree/README.md,extensions/pi-ui-tweaks/README.md,extensions/pi-workspace/README.md,packages/pi-typed-args/README.md,packages/pi-typed-args/docs/command-definitions.md,packages/pi-typed-args/docs/completions-and-forms.md

# Generate config schemas and README sections
config-generate:
    npm run config:generate

# Run the config check checks
config-check:
    npm run config:check
    npm run config:check --workspaces --if-present

# Run every configured linter on the whole project, stopping on failure
lint:
    @npm run lint

# Run fast unit tests
[positional-arguments]
test *args:
    @npm test -- "$@"

# Static type check with TypeScript
typecheck:
    npm run typecheck

# Run the commit checks
check: (run-checks "formatcheck" "lockcheck" "architecture-check" "collection-check" "config-check" "language-catalog-check" "lint" "typecheck" "build" "package-check" "test")

# Measure all local Vitest suites and print coverage
coverage:
    npm run coverage

# Apply safe lint autofixes, then format every supported file type
fix: && format
    npm run lint:fix
    just --justfile extensions/pi-autoname-session/Justfile --working-directory extensions/pi-autoname-session fix
    just --justfile extensions/pi-branch/Justfile --working-directory extensions/pi-branch fix
    just --justfile extensions/pi-codex-core/Justfile --working-directory extensions/pi-codex-core fix
    just --justfile extensions/pi-expanded-skills/Justfile --working-directory extensions/pi-expanded-skills fix
    just --justfile extensions/pi-glowup/Justfile --working-directory extensions/pi-glowup fix
    just --justfile extensions/pi-goal/Justfile --working-directory extensions/pi-goal fix
    just --justfile extensions/pi-settings-ui/Justfile --working-directory extensions/pi-settings-ui fix
    just --justfile extensions/pi-toggles/Justfile --working-directory extensions/pi-toggles fix
    just --justfile packages/pi-extension-settings/Justfile --working-directory packages/pi-extension-settings fix
    just --justfile packages/pi-typed-args/Justfile --working-directory packages/pi-typed-args fix

# Remove generated output, caches, and dependencies
clean:
    #!/usr/bin/env bash
    set -euo pipefail
    export CLEAN_TOTAL_FILE="$(mktemp)"
    trap 'rm -f "$CLEAN_TOTAL_FILE"' EXIT
    printf '== workspace output ==\n'
    just --justfile "{{ justfile() }}" remove "coverage" "extensions/*/dist" "extensions/*/coverage" "packages/*/dist" "packages/*/coverage"
    if test -d node_modules/typebox; then node scripts/workspace-tasks.ts clean; fi
    for project in extensions/pi-autoname-session extensions/pi-branch extensions/pi-codex-core extensions/pi-expanded-skills extensions/pi-glowup extensions/pi-goal extensions/pi-settings-ui extensions/pi-toggles packages/pi-extension-settings packages/pi-typed-args; do
        printf '== %s ==\n' "$project"
        just --justfile "$project/Justfile" --working-directory "$project" clean
    done
    printf '== root ==\n'
    just --justfile "{{ justfile() }}" remove "node_modules" "dist" "coverage" "extensions/*/node_modules" "extensions/*/dist" "extensions/*/coverage" "packages/*/node_modules" "packages/*/dist" "packages/*/coverage" ".pytest_cache" ".ruff_cache" "**/*.tsbuildinfo"
    printf '\ngrand total  %s freed\n' "$(awk '{ k += $1 } END { print k + 0 }' "$CLEAN_TOTAL_FILE" | LC_ALL=C numfmt --from-unit=1024 --to=iec-i --suffix=B --format=%.1f)"

# Run the build checks
build:
    npm run build

# Run the architecture check checks
architecture-check:
    npm run architecture:check

# Run the collection check checks
collection-check:
    npm run collection:check

# Run the format check root checks
format-check-root:
    npm run format:check:root

# Run the lint root checks
lint-root:
    npm run lint:root

# Run the typecheck root checks
typecheck-root:
    npm run typecheck:root

# Run the test root checks
test-root:
    npm run test:root

# Run the test package built checks
test-package-built:
    npm run test:package:built

# Run the check code workspaces checks
check-code-workspaces:
    npm run check:code:workspaces

# Check the same files and tools without writing
formatcheck:
    @git ls-files -co --exclude-standard -z | while IFS= read -r -d '' file; do if [[ -f $file ]]; then printf '%s\0' "$file"; fi; done | xargs -0 -r oxfmt --check --no-error-on-unmatched-pattern '!**/*.md'
    @git ls-files -co --exclude-standard -z | while IFS= read -r -d '' file; do if [[ -f $file ]]; then printf '%s\0' "$file"; fi; done | xargs -0 -r shfmt -f | xargs -r -d '\n' shfmt -d
    @git ls-files -co --exclude-standard -- Justfile justfile "*.just" | while IFS= read -r file; do just --justfile "$file" --fmt --check || exit $?; done
    @just markdown check --exclude extensions/pi-footer/README.md,extensions/pi-goal/CHANGELOG.md,extensions/pi-input-corrections/README.md,extensions/pi-keymap-tweaks/README.md,extensions/pi-mention-anything/README.md,extensions/pi-mention-project/README.md,extensions/pi-mention-skill/README.md,extensions/pi-message-highlights/README.md,extensions/pi-message-timestamps/README.md,extensions/pi-model-alias/README.md,extensions/pi-model-filter/README.md,extensions/pi-model-modes/CHANGELOG.md,extensions/pi-model-modes/README.md,extensions/pi-response-renderer/test/fixtures,extensions/pi-settings-ui/README.md,extensions/pi-status-bar/README.md,extensions/pi-tree/README.md,extensions/pi-ui-tweaks/README.md,extensions/pi-workspace/README.md,packages/pi-typed-args/README.md,packages/pi-typed-args/docs/command-definitions.md,packages/pi-typed-args/docs/completions-and-forms.md
    @git ls-files -co --exclude-standard -z | while IFS= read -r -d '' file; do if [[ -f $file ]]; then printf '%s\0' "$file"; fi; done | xargs -0 -r editorconfig-checker -disable-indent-size -disable-indentation -disable-max-line-length -disable-charset

# Run the package check checks
package-check:
    npm run test:package
    npm run test:package --workspaces --if-present
    npm run check:package --workspaces --if-present

# Run the commit checks and slow suites
checkfull: (run-checks "formatcheck" "lockcheck" "architecture-check" "collection-check" "config-check" "language-catalog-check" "lint" "typecheck" "build" "package-check" "test" "checkfull-glowup")

# Run the language catalog check checks
language-catalog-check:
    npm run language-catalog:check --workspaces --if-present

# Synchronize dependency locks without upgrading dependencies
[no-exit-message]
lock:
    @npm install --package-lock-only --ignore-scripts

# Verify dependency manifests and locks without changing files
[no-exit-message]
lockcheck:
    npm ci --dry-run --ignore-scripts

# List available recipes
[default]
help:
    @just --list

alias cov := coverage
alias fmt := format

[positional-arguments]
[private]
remove +paths:
    #!/usr/bin/env bash
    set -euo pipefail
    shopt -s nullglob globstar
    size() { LC_ALL=C numfmt --from-unit=1024 --to=iec-i --suffix=B --format=%.1f "$1"; }
    rows=() total=0
    for pattern in "$@"; do
        found=()
        for path in $pattern; do
            if [[ -e $path || -L $path ]]; then found+=("$path"); fi
        done
        if (( ${#found[@]} == 0 )); then continue; fi
        kib=$(du -sck -- "${found[@]}" | tail -n1 | cut -f1)
        rm -rf -- "${found[@]}"
        label=$pattern
        if (( ${#found[@]} > 1 )); then label+=" (${#found[@]})"; fi
        rows+=("removed  $label|$(size "$kib")")
        total=$(( total + kib ))
    done
    if [[ -n ${CLEAN_TOTAL_FILE:-} ]]; then echo "$total" >> "$CLEAN_TOTAL_FILE"; fi
    if (( ${#rows[@]} == 0 )); then echo "nothing to clean"; exit 0; fi
    printf '%s\n' "${rows[@]}" "total freed|$(size "$total")" | column -t -s '|' -R 2

[private]
checkfull-glowup:
    just --justfile extensions/pi-glowup/Justfile --working-directory extensions/pi-glowup checkfull

[positional-arguments]
[private]
run-checks +steps:
    #!/usr/bin/env bash
    set -uo pipefail
    LC_NUMERIC=C
    log_dir="${XDG_CACHE_HOME:-$HOME/.cache}/just-check"
    mkdir -p "$log_dir"
    log=$(mktemp "$log_dir/step.XXXXXX")
    trap 'rm -f "$log"' EXIT
    width=0 failed=()
    for step in "$@"; do (( ${#step} > width )) && width=${#step}; done
    for step in "$@"; do
        read -ra command <<< "$step"
        printf 'check  %-*s  ' "$width" "$step"
        start=$EPOCHREALTIME
        run=(just --justfile {{ quote(justfile()) }} "${command[@]}")
        if [[ -t 1 ]]; then run=(script -qefc "${run[*]@Q}" /dev/null); fi
        if "${run[@]}" < /dev/null > "$log" 2>&1; then status=ok; else status=FAIL; failed+=("$step"); fi
        printf '%-4s  %7.1fs\n' "$status" "$(LC_NUMERIC=C awk -v a="$start" -v b="$EPOCHREALTIME" 'BEGIN { print b - a }')"
        if [[ "$status" == FAIL ]]; then sed 's/\r$//; s/^/    /' "$log"; fi
    done
    if (( ${#failed[@]} )); then printf '%d of %d failed: %s\n' "${#failed[@]}" "$#" "${failed[*]}"; exit 1; fi
    printf 'all %d passed\n' "$#"

[private]
markdown *args:
    rumdl {{ args }} --disable MD001,MD013,MD024,MD025,MD026,MD031,MD032,MD033,MD034,MD036,MD041,MD058 --config 'MD060.enabled=true' --config 'MD060.style="aligned"' --config 'MD003.style="atx"' --config 'MD004.style="dash"' --config 'MD029.style="ordered"' --config 'MD046.style="fenced"' --config 'MD048.style="backtick"' --config 'MD049.style="asterisk"' --config 'MD050.style="asterisk"' --config 'MD055.style="leading_and_trailing"'
