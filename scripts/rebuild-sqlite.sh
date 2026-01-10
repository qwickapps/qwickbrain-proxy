#!/bin/bash
set -e

echo "Rebuilding better-sqlite3 native bindings..."

# Ensure Python has setuptools (needed for node-gyp with Python 3.13+)
python3 -m pip install --quiet setuptools --break-system-packages 2>/dev/null || true

# Navigate to monorepo root and rebuild better-sqlite3
cd "$(dirname "$0")/../../.."

# Rebuild better-sqlite3 for the entire monorepo
pnpm exec node-gyp rebuild --directory node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 --release 2>/dev/null || {
    # Fallback: find and rebuild better-sqlite3 directly
    SQLITE_DIR=$(find node_modules/.pnpm -type d -path "*/better-sqlite3@*/node_modules/better-sqlite3" -print -quit)
    if [ -n "$SQLITE_DIR" ]; then
        echo "Building in: $SQLITE_DIR"
        cd "$SQLITE_DIR"
        npm run build-release
    else
        echo "Warning: Could not find better-sqlite3 to rebuild"
        exit 1
    fi
}

echo "✓ better-sqlite3 rebuilt successfully"
