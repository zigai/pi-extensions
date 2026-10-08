_:
    @just help

# List available commands
help:
    @just --list

# Format code
format:
    npm run format

# Check code for lint issues
lint:
    npm run lint

# Run tests
test:
    npm test

# Static type check with TypeScript
typecheck:
    npm run typecheck

# Run informational TUI benchmarks
benchmark:
    npm run benchmark:tui

# Run a short informational TUI benchmark sample
benchmark-quick:
    npm run benchmark:tui -- --quick

# Run all non-mutating checks
check:
    npm run check

# Run tests with coverage
coverage:
    npm run coverage

# Apply automatic fixes
fix:
    npm run lint:fix
    npm run format

# Remove coverage and temporary output
clean:
    rm -rf coverage dist

alias cov := coverage
alias fmt := format
alias tsc := typecheck

# Install the extension into Pi
install:
    pi install .

# Build the actual distribution (also used by package verification)
build:
    npm run build

# Native process-independent properties, including existing streaming properties
property:
    npm run test:properties

# Finite preview-cache operation histories, with fast-check shrinking
model:
    npm run test:model

# Real in-process Pi/xterm composition; not the external PTY lane
integration:
    npm run test:xterm

# Real Pi CLI in a native PTY, using the existing offline provider
e2e:
    npm run test:pty


# Real Pi CLI in a native PTY, using the compiled dist bundle
e2e-dist:
    npm run test:pty:dist
# Published protocol consumer plus current package layout/build checks
contract:
    npm run test:package

# Behavioral filesystem-boundary checks, not a general security scanner
security:
    npm exec --no -- vitest run test/tools/built-in/preimage-boundary.test.ts

# Check manifest/lock declarations before repairing the lock with npm
lock-contract:
    npm exec --no -- vitest run test/package.test.ts -t "keeps manifest and lockfile root"

# Registration and import isolation, in fresh credential-free processes
registration-contract:
    npm exec --no -- vitest run test/pi/index-lifecycle.test.ts -t "keeps settings unchanged"

# Deterministic clear-during-await histories
concurrency:
    npm exec --no -- vitest run test/tools/built-in/preimage-boundary.test.ts -t "does not repopulate session"
