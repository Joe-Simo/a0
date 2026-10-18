#!/bin/sh
# Internal stage proof after development preparation. Requires only a C
# compiler, pthreads, POSIX shell tools and SHA256; no Node, Bun or A0 host.
# Usage: CC=gcc sh tools/c-arena-stage.sh prepared-directory output-directory
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: c-arena-stage.sh prepared-directory output-directory" >&2
  exit 64
fi
prepared=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
if [ "$prepared" = "$out" ]; then
  echo "prepared and output directories must differ" >&2
  exit 64
fi
CC=${CC:-cc}
CFLAGS=${CFLAGS:--std=c11 -O2 -Wall -Wextra -Werror -Wno-unused-parameter}
suffix=
entry_flags=
case $(uname -s) in
  MINGW* | MSYS* | CYGWIN*)
    # GCC uses the Windows temporary directory; MSYS may not export one.
    if [ -z "${TMP:-}" ] && [ -z "${TEMP:-}" ]; then
      TMP=$(cygpath -w "$out")
      TEMP=$TMP
      export TMP TEMP
    fi ;;
esac
"$CC" -dM -E -x c - < /dev/null > "$out/compiler-defines.txt"
if grep -q '^#define _WIN32 ' "$out/compiler-defines.txt"; then
  suffix=.exe
  entry_flags=-municode
elif grep -Eq '^#define __(CYGWIN|MSYS)__ ' "$out/compiler-defines.txt"; then
  suffix=.exe
fi

hash_files() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$@"
  elif command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$@"
  else
    echo "sha256sum or shasum is required" >&2
    return 64
  fi
}

mkdir -p "$out/shim" "$out/stage1"
for file in c_arena_stage.c arena_runtime.c arena_runtime.h; do
  cp "$prepared/$file" "$out/shim/$file"
done
cp "$prepared/compiler-source.a0" "$out/compiler-source.a0"
cp "$prepared/module.c" "$out/stage1/module.c"
"$CC" --version > "$out/compiler-version.txt"
printf 'CC=%s\nCFLAGS=%s\nentry/thread flags=-pthread %s\n' "$CC" "$CFLAGS" "$entry_flags" \
  > "$out/build-flags.txt"
printf '%s\n' 'arenaWords=100000000 outputWords=100000000 quantum=97 resumes=10000000' \
  'inputCapacity=1 outputCapacity=1 flags=0 stackBytes=1073741824' > "$out/resources.txt"

build_stage() {
  # CFLAGS is the conventional caller-supplied whitespace-separated flag list.
  # Neither the generated module nor the original source is rewritten.
  "$CC" $CFLAGS -pthread $entry_flags -I "$out/$1" -I "$out/shim" \
    "$out/shim/c_arena_stage.c" "$out/shim/arena_runtime.c" \
    -o "$out/$1/stage$suffix" > "$out/$1/build.stdout.log" 2> "$out/$1/build.stderr.log"
}

build_stage stage1
stage=2
while [ "$stage" -le 4 ]; do
  previous=$((stage - 1))
  mkdir -p "$out/stage$stage"
  "$out/stage$previous/stage$suffix" "$out/compiler-source.a0" "$out/stage$stage/module.c" \
    100000000 100000000 97 10000000 1 1 0 1073741824 \
    > "$out/stage$stage/run.stdout.log" 2> "$out/stage$stage/run.stderr.log"
  if [ "$stage" -gt 2 ]; then
    cmp "$out/stage$previous/module.c" "$out/stage$stage/module.c"
  fi
  build_stage "stage$stage"
  stage=$((stage + 1))
done
cmp "$prepared/compiler-source.a0" "$out/compiler-source.a0"
for file in c_arena_stage.c arena_runtime.c arena_runtime.h; do
  cmp "$prepared/$file" "$out/shim/$file"
done
(cd "$out" && hash_files compiler-source.a0 shim/* stage2/module.c stage3/module.c stage4/module.c) \
  > "$out/proof.sha256"
echo "C arena stage: stages 2, 3 and 4 emitted identical C and all built with $CC"
