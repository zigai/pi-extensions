_:
    @just help

# List available commands
help:
    @just --list

# Install dependencies, then verify the project
setup:
    npm install
    npm run check

# Type-check the extension
typecheck:
    npm run typecheck

# Format the project
fmt:
    npm run format

# Check code for lint issues
lint:
    npm run lint

# Run tests
test:
    npm test

# Run tests with coverage
coverage:
    npm run coverage

# Check the platform-smoke harness without running remote targets
platform-check:
    npm run check:platform-smoke

# Check Crabbox platform-smoke prerequisites
platform-doctor:
    npm run smoke:platform:doctor

# Run the complete macOS, Ubuntu, and native Windows platform gate
platform-smoke:
    npm run smoke:platform:all

# Run all local non-mutating quality checks
check:
    npm run check

# Apply automatic lint fixes and format the project
fix:
    npm run lint:fix
    npm run format

alias cov := coverage
alias verify := check
alias smoke := platform-smoke
