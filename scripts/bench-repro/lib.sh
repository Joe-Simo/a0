# Sourced by the other scripts in this folder. POSIX sh. Moves to the repository root, builds once.
# Output goes to scripts/bench-repro/out/ (git-ignored); the committed files in results/ are never overwritten
# by speed.sh. tokens.sh and verify.sh write to results/ (the tools do) and restore the committed copy.

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=scripts/bench-repro/out
cd "$ROOT" || exit 1
mkdir -p "$OUT"

# Windows (Git Bash): MSYS2's clang is found by the tools themselves (src/toolchain.ts); adding it to PATH
# also makes `clang --version` below report it.
for d in /c/msys64/clang64/bin /c/msys64/mingw64/bin /c/msys64/usr/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH

have() { command -v "$1" >/dev/null 2>&1; }

build() {
  have bun || { echo "bun not found (CI pins 1.3.4; any recent 1.x works): https://bun.sh" >&2; exit 2; }
  have node || { echo "node not found (22 or newer)" >&2; exit 2; }
  [ -d node_modules ] || bun install --frozen-lockfile
  bun run build
}
