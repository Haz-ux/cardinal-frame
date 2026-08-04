#!/bin/sh
# Install Cardinal Frame git hooks (secret scanning pre-commit).
set -e

HOOKS_DIR=".githooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "Error: $HOOKS_DIR not found. Run from the repo root."
  exit 1
fi

chmod +x "$HOOKS_DIR/pre-commit"
git config core.hooksPath "$HOOKS_DIR"
echo "✅ Git hooks installed (core.hooksPath=$HOOKS_DIR)."
