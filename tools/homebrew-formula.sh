#!/bin/sh
# Set the version and the four sha256 values of Formula/a0.rb from a release's checksums.txt.
# Only those values change, plus one `a0 --version` assertion in the test block; the rest is edited by hand.
# Usage: sh tools/homebrew-formula.sh <version-without-v> <checksums.txt> [formula]
# Fails when a checksum is missing, or when the formula does not carry the expected stanzas.
set -eu
version=${1:?usage: homebrew-formula.sh <version> <checksums.txt> [formula]}
sums=${2:?usage: homebrew-formula.sh <version> <checksums.txt> [formula]}
formula=${3:-Formula/a0.rb}
version=${version#v}
case $version in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "not a release version: $version" >&2; exit 2 ;;
esac

# asset=sha256 pairs, one per binary the formula downloads.
pairs=
for asset in a0-darwin-arm64 a0-darwin-x64 a0-linux-arm64 a0-linux-x64; do
  s=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$sums")
  case $s in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) echo "missing checksum for $asset in $sums" >&2; exit 1 ;;
  esac
  [ ${#s} -eq 64 ] || { echo "checksum for $asset is not a SHA-256: $s" >&2; exit 1; }
  pairs="$pairs $asset=$s"
done

# From 0.8.16 the binary has --version: the test block asserts it (added once, kept by later runs).
hasver=0
grep -q -e '--version' "$formula" && hasver=1
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT INT TERM
awk -v version="$version" -v pairs="$pairs" -v hasver="$hasver" '
  BEGIN {
    n = split(pairs, kv, " ")
    for (i = 1; i <= n; i++) { split(kv[i], p, "="); sum[p[1]] = p[2] }
  }
  /^  version "/ { print "  version \"" version "\""; v++; next }
  /^ +url "/ { asset = $2; sub(/.*\//, "", asset); sub(/"$/, "", asset); print; next }
  /^ +sha256 "/ {
    if (!(asset in sum)) { print "formula: no checksum for asset " asset > "/dev/stderr"; bad = 1; exit 1 }
    sub(/"[0-9a-f]*"/, "\"" sum[asset] "\""); print; s++; asset = ""; next
  }
  /^    assert_equal "144"/ && !hasver { print "    assert_match version.to_s, shell_output(\"#{bin}/a0 --version\")"; hasver = 1 }
  { print }
  END { if (!bad && (v != 1 || s != 4)) { print "formula: expected 1 version and 4 sha256 lines, found " v " and " s > "/dev/stderr"; exit 1 } }
' "$formula" > "$tmp"
cat "$tmp" > "$formula"
echo "updated $formula to v$version"
