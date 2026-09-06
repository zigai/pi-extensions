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

# Run a short informational TUI benchmark smoke
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
