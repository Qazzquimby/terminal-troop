# terminal-troop task runner

default:
    @just --list

# Install dependencies
[group('dev')]
install:
    pnpm install

# Start the Vite dev server
[group('dev')]
dev:
    pnpm dev

# Start the dev server on the one-screen dev square world, for testing
[group('dev')]
dev-square:
    pnpm dev:square

# Production build
[group('dev')]
build:
    pnpm build

# Serve the production build locally
[group('dev')]
preview:
    pnpm preview

# Format everything
[group('dev')]
format:
    pnpm format

# Typecheck
[group('check')]
typecheck:
    pnpm typecheck

# Run tests once
[group('check')]
test:
    pnpm test

# Run tests in watch mode
[group('check')]
test-watch:
    pnpm test:watch

# Lint everything
[group('check')]
lint:
    pnpm lint

# Unused exports/files/deps check
[group('check')]
knip:
    pnpm knip

# Textual-duplication check
[group('check')]
dupes:
    pnpm dupes

# Import boundaries between modules (dependency-cruiser)
[group('check')]
boundaries:
    pnpm boundaries

# Check formatting without writing
[group('check')]
format-check:
    pnpm format-check

# The gate: typecheck, lint, test, knip, dupes, boundaries, format-check
[group('check')]
check:
    pnpm check
