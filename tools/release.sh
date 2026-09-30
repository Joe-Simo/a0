#!/bin/sh
# Standalone `a0` binaries: the compiler with its runtime embedded, no Node or Bun needed
# on the user's machine. Output: release/a0-<os>-<arch>. macOS binaries are ad-hoc signed.
set -eu
cd "$(dirname "$0")/.."
bun run build
mkdir -p release
for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64; do
  bun build --compile --target="bun-$t" --minify dist/src/cli.js --outfile "release/a0-$t"
done
codesign -s - --force release/a0-darwin-arm64 release/a0-darwin-x64 2>/dev/null || true
ls -la release
