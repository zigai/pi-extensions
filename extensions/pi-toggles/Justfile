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

# Generate config schema and README settings documentation
config-generate:
    npm run config:generate

# Check generated settings artifacts
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

# Run all non-mutating quality checks
check:
    npm run check

# Run tests with coverage
coverage:
    npm run coverage

# Apply automatic lint fixes and format code
fix:
    npm run lint:fix
    npm run format

# Remove coverage and temporary output
clean:
    rm -rf coverage dist

alias cov := coverage
alias fmt := format
alias tsc := typecheck
