#!/bin/sh
# Install the a0 binary from GitHub Releases.
#   curl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh | sh
# Environment:
#   A0_VERSION      release tag to install (e.g. v0.8.15); default: latest
#   A0_INSTALL_DIR  destination directory; default: $HOME/.local/bin
#   A0_RELEASE_URL  base URL holding the assets and checksums.txt (overrides A0_VERSION; for mirrors)
set -eu

repo="Joe-Simo/a0"
install_dir="${A0_INSTALL_DIR:-$HOME/.local/bin}"

err() { echo "a0 install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) err "unsupported OS $(uname -s); on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) err "unsupported architecture $(uname -m)" ;;
esac
# A shell running under Rosetta reports x86_64; prefer the native binary.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
asset="a0-$os-$arch"

if [ -n "${A0_RELEASE_URL:-}" ]; then
  base="${A0_RELEASE_URL%/}"
elif [ -n "${A0_VERSION:-}" ]; then
  base="https://github.com/$repo/releases/download/$A0_VERSION"
else
  base="https://github.com/$repo/releases/latest/download"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https,http' -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  err "curl or wget is required"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  err "sha256sum or shasum is required"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "a0 install: downloading $asset from $base"
fetch "$base/$asset" "$tmp/$asset" || err "download failed: $base/$asset"
fetch "$base/checksums.txt" "$tmp/checksums.txt" || err "download failed: $base/checksums.txt"

expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/checksums.txt")
[ -n "$expected" ] || err "no checksum for $asset in checksums.txt"
actual=$(sha256 "$tmp/$asset")
[ "$expected" = "$actual" ] || err "checksum mismatch for $asset: expected $expected, got $actual"
echo "a0 install: sha256 verified ($actual)"

mkdir -p "$install_dir"
chmod 755 "$tmp/$asset"
mv -f "$tmp/$asset" "$install_dir/a0"
echo "a0 install: installed $install_dir/a0"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "a0 install: add $install_dir to your PATH, e.g. export PATH=\"$install_dir:\$PATH\"" ;;
esac
