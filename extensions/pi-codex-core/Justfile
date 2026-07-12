_:
    @just help

# List available commands
help:
    @just --list

# Format code
fmt:
    npm run format

# Check code for lint issues
lint:
    @npm run --silent lint

# Run tests
test:
    npm test

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

alias cov := coverage
