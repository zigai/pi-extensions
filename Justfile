_:
    @just help

# List available commands
help:
    @just --list

# Install dependencies and Git hooks, then verify the project
setup:
    npm install
    pre-commit install
    npm run check


# Install the extension into Pi
install:
    pi install .
# Format code
format:
    npm run format

# Generate config schemas and README sections
config-generate:
    npm run config:generate

# Check generated config artifacts
config-check:
    npm run config:check

# Check code for lint issues
lint:
    npm run lint

# Run tests
test:
    npm test

# Static type check with TypeScript
typecheck:
    npm run typecheck

# Run all non-mutating checks
check:
    npm run check

# Release a new version
release:
    npm run release

# Run a dry-run release
release-dry-run:
    npm run release:dry-run

# Run tests with coverage
coverage:
    npm run coverage

# Apply automatic fixes
fix:
    npm run lint:fix
    npm run format
# Remove coverage and temporary output
clean:
    node scripts/workspace-tasks.ts clean

alias cov := coverage
alias fmt := format
