#!/bin/sh
# Sync project source files to the shared dev folder (viewable in Acode editor).
# Usage: sh sync-to-dev.sh

SRC=/home/cardinal-frame
DST="/storage/emulated/0/Documents/AI_Transfer/Project development/cardinal-frame"

mkdir -p "$DST"
tar -C "$SRC" \
  --exclude=node_modules \
  --exclude='.git' \
  --exclude=test-results \
  --exclude='*.log' \
  -cf - . | tar -C "$DST" -xf -

echo "Synced $SRC -> $DST ($(date '+%H:%M:%S'))"
