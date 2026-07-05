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
    npm run lint

# Run tests
test:
    npm test --if-present

# Run all non-mutating checks
check:
    npm run check

# Apply automatic fixes
fix:
    npm run lint:fix
    npm run format
