#!/bin/sh
# Release artifacts for one version, into a clean release/ directory:
#   a0-darwin-arm64 a0-darwin-x64 a0-linux-arm64 a0-linux-x64 a0-windows-x64.exe   standalone binaries
#                                         (the compiler with its runtime embedded; no Node or Bun needed)
#   a0-mcp-<os>-<arch>.mcpb               one MCP Bundle per binary
#   server.json                           the registry manifest with the bundles' URLs and SHA-256
#   checksums.txt                         SHA-256 of the five binaries and the five bundles
# Usage: sh tools/release.sh <version>      e.g. sh tools/release.sh 0.8.16
# Fails when a version file disagrees with <version>, when any artifact is missing or empty, or
# when the binary built for this host does not report <version>. macOS binaries are ad-hoc signed
# when built on macOS.
set -eu
cd "$(dirname "$0")/.."

version=${1:-}
version=${version#v}
case $version in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "usage: sh tools/release.sh <version, e.g. 0.8.16>" >&2; exit 2 ;;
esac

bun tools/set-version.ts --check "$version"
bun run build

rm -rf release
mkdir release
binaries="a0-darwin-arm64 a0-darwin-x64 a0-linux-arm64 a0-linux-x64 a0-windows-x64.exe"
for name in $binaries; do
  target=${name#a0-}
  target=${target%.exe}
  bun build --compile --target="bun-$target" --minify dist/src/cli.js --outfile "release/$name"
done

if [ "$(uname -s)" = Darwin ]; then
  for name in a0-darwin-arm64 a0-darwin-x64; do
    codesign -s - --force "release/$name"
    codesign --verify "release/$name"
  done
fi

for name in $binaries; do
  [ -s "release/$name" ] || { echo "release: missing or empty release/$name" >&2; exit 1; }
done

# The binary for this machine must run and report the release version.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) host=a0-darwin-arm64 ;;
  Darwin-x86_64) host=a0-darwin-x64 ;;
  Linux-aarch64 | Linux-arm64) host=a0-linux-arm64 ;;
  Linux-x86_64) host=a0-linux-x64 ;;
  *) host= ;;
esac
if [ -n "$host" ]; then
  reported=$("release/$host" --version)
  case $reported in
    "a0 $version ("*) echo "release: $host reports: $reported" ;;
    *) echo "release: $host reports '$reported', expected 'a0 $version'" >&2; exit 1 ;;
  esac
fi

# MCP Bundles and release/server.json.
node dist/tools/mcpb.js "$version"
rm -rf release/mcpb
bundles="a0-mcp-darwin-arm64.mcpb a0-mcp-darwin-x64.mcpb a0-mcp-linux-arm64.mcpb a0-mcp-linux-x64.mcpb a0-mcp-windows-x64.mcpb"
for name in $bundles server.json; do
  [ -s "release/$name" ] || { echo "release: missing or empty release/$name" >&2; exit 1; }
done

# Sorted, so the file is the same on every run for the same artifacts.
if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$@"; }; else sha() { shasum -a 256 "$@"; }; fi
(cd release && sha $(printf '%s\n' $binaries $bundles | LC_ALL=C sort) > checksums.txt)
[ "$(wc -l < release/checksums.txt | tr -d ' ')" = 10 ] || { echo "release: checksums.txt must list 10 files" >&2; exit 1; }
cat release/checksums.txt
ls -la release
