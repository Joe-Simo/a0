#!/bin/sh
# Bootstrap A0 from the checked-in seed with nothing but a C compiler: no Node, no Bun, no
# TypeScript, no A0 binary. Usage: sh seed/bootstrap.sh [build-dir]   (default: ./a0-seed-build)
#
#   seed/a0c-seed.c   the C of the A0 compiler, written by the A0 compiler itself ("stage 2")
#   seed/stage-main.c the small C main that wraps it as a stdin/stdout stage executable (the shim)
#   seed/driver.c     replays the compiler's chunked self-compilation over seed/plan.txt
#   seed/chunks/*.a0  the compiler's own source (compiler/*.a0), cut at function boundaries
#
# Steps, each checked:
#   1. build the seed C with $CC into a0c (stage 2 executable)
#   2. a0c compiles the compiler source (the chunks) to C ("stage 3")
#   3. the stage 3 C must equal seed/a0c-seed.c byte for byte (the fixed point: the seed reproduces itself)
#   4. build the stage 3 C, compile the source once more ("stage 4") and require it equals stage 3
# The result, build-dir/a0c, reads A0 source chunks on stdin and writes C; see compiler/boot.a0.
# Regenerate the seed after any change to compiler/*.a0 with `bun run seed` (tools/seed.ts).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out=${1:-./a0-seed-build}
CC=${CC:-cc}
CFLAGS=${CFLAGS:--std=c11 -O2 -Wall -Wextra -Wno-unused-parameter}

mkdir -p "$out/stage2" "$out/stage3"
out=$(cd "$out" && pwd)

build_stage() { # build_stage <dir> <c-file>: the stage executable `a0c` from a stage C file
  cp "$2" "$1/emitter.c"
  cp "$here/stage-main.c" "$1/main.c"
  (cd "$1" && $CC $CFLAGS -pthread -o a0c main.c)
}

echo "seed: building the driver"
$CC -std=c11 -O2 -Wall -Wextra -o "$out/a0seed-driver" "$here/driver.c"

echo "seed: building stage 2 from seed/a0c-seed.c"
build_stage "$out/stage2" "$here/a0c-seed.c"

echo "seed: stage 2 compiles the compiler"
"$out/a0seed-driver" "$out/stage2/a0c" "$here" "$out/stage3.c"
if cmp -s "$here/a0c-seed.c" "$out/stage3.c"; then
  echo "seed: stage 2 C equals stage 3 C byte for byte ($(wc -c < "$out/stage3.c" | tr -d ' ') bytes)"
else
  echo "seed: stage 3 C differs from seed/a0c-seed.c: the seed is stale or damaged" >&2
  exit 1
fi

echo "seed: building stage 3 and compiling the compiler again"
build_stage "$out/stage3" "$out/stage3.c"
"$out/a0seed-driver" "$out/stage3/a0c" "$here" "$out/stage4.c"
if cmp -s "$out/stage3.c" "$out/stage4.c"; then
  echo "seed: stage 3 reproduces itself (stage 4 C equals stage 3 C)"
else
  echo "seed: stage 4 C differs from stage 3 C" >&2
  exit 1
fi
cp "$out/stage3/a0c" "$out/a0c"
echo "seed: ok, $out/a0c"
