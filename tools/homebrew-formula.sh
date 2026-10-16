#!/bin/sh
# Set the binary URLs/checksums and optional LICENSE/NOTICE resources in Formula/a0.rb
# from a release's checksums.txt. The URLs carry the version; brew audit rejects a redundant `version` line.
# Legacy manifests without both notices keep the marked resource block empty.
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

# Reject incomplete, duplicate or malformed entries before changing the formula.
validate_checksum() {
  [ -n "$2" ] || { echo "missing checksum for $1 in $sums" >&2; exit 1; }
  case $2 in
    *[!0-9a-f]*) echo "checksum for $1 is not a SHA-256: $2" >&2; exit 1 ;;
  esac
  [ ${#2} -eq 64 ] || { echo "checksum for $1 is not a SHA-256: $2" >&2; exit 1; }
}

# asset=sha256 pairs, one per binary the formula downloads.
pairs=
for asset in a0-darwin-arm64 a0-darwin-x64 a0-linux-arm64 a0-linux-x64; do
  s=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$sums")
  validate_checksum "$asset" "$s"
  pairs="$pairs $asset=$s"
done

# Notice assets were added after the original five-binary and ten-binary/bundle manifests.
# They are optional as a pair so updating an older release never invents download URLs.
license=$(awk '$2 == "LICENSE" || $2 == "*LICENSE" { print $1 }' "$sums")
notice=$(awk '$2 == "NOTICE" || $2 == "*NOTICE" { print $1 }' "$sums")
notices=0
if [ -n "$license" ] || [ -n "$notice" ]; then
  validate_checksum LICENSE "$license"
  validate_checksum NOTICE "$notice"
  notices=1
fi

# From 0.8.16 the binary has --version: the test block asserts it (added once, kept by later runs).
hasver=0
grep -q -e '--version' "$formula" && hasver=1
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT INT TERM
awk -v version="$version" -v pairs="$pairs" -v hasver="$hasver" \
    -v notices="$notices" -v license="$license" -v notice="$notice" '
  BEGIN {
    n = split(pairs, kv, " ")
    for (i = 1; i <= n; i++) { split(kv[i], p, "="); sum[p[1]] = p[2] }
  }
  /^  # BEGIN RELEASE NOTICES$/ {
    if (begun++) { print "formula: duplicate notice resource block" > "/dev/stderr"; bad = 1; exit 1 }
    in_notices = 1
    print
    if (notices) {
      print "  resource \"license\" do"
      print "    url \"https://github.com/Joe-Simo/a0/releases/download/v" version "/LICENSE\""
      print "    sha256 \"" license "\""
      print "  end"
      print ""
      print "  resource \"notice\" do"
      print "    url \"https://github.com/Joe-Simo/a0/releases/download/v" version "/NOTICE\""
      print "    sha256 \"" notice "\""
      print "  end"
    }
    next
  }
  /^  # END RELEASE NOTICES$/ {
    if (!in_notices || ended++) { print "formula: unmatched notice resource block" > "/dev/stderr"; bad = 1; exit 1 }
    in_notices = 0
    print
    next
  }
  in_notices { next } # Resources do not count as the four binary URL/checksum stanzas.
  /^  version "/ { next } # the URL carries the version
  /^ +url "/ {
    asset = $2; sub(/.*\//, "", asset); sub(/"$/, "", asset)
    sub(/\/download\/v[^\/]*\//, "/download/v" version "/"); print; u++; next
  }
  /^ +sha256 "/ {
    if (!(asset in sum)) { print "formula: no checksum for asset " asset > "/dev/stderr"; bad = 1; exit 1 }
    sub(/"[0-9a-f]*"/, "\"" sum[asset] "\""); print; s++; asset = ""; next
  }
  /^    assert_equal "144"/ && !hasver { print "    assert_match version.to_s, shell_output(\"#{bin}/a0 --version\")"; hasver = 1 }
  { print }
  END {
    if (!bad && (begun != 1 || ended != 1 || in_notices)) {
      print "formula: expected one complete notice resource block" > "/dev/stderr"; exit 1
    }
    if (!bad && (u != 4 || s != 4)) {
      print "formula: expected 4 url and 4 sha256 lines, found " u " and " s > "/dev/stderr"; exit 1
    }
  }
' "$formula" > "$tmp"
cat "$tmp" > "$formula"
echo "updated $formula to v$version"
