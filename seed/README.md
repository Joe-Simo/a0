# Bootstrap seed

A machine with only a C compiler and a POSIX shell can build A0 from this directory, with no Node,
no Bun and no TypeScript:

```sh
sh seed/bootstrap.sh [build-dir]     # CC=cc by default; writes build-dir/a0c
```

The script builds `a0c-seed.c` (the C of the A0 compiler, written by the compiler itself), lets that
stage compile the compiler's own source (`chunks/*.a0`, driven by `driver.c` over `plan.txt`), and
fails unless the C it writes equals `a0c-seed.c` byte for byte (stage 2 equals stage 3) and a second
round reproduces it (stage 4 equals stage 3). `stage-main.c` is the shim: the stdin/stdout main that
turns a stage's C into an executable (`a0c` reads source chunks on stdin and writes C; see
`compiler/boot.a0` and `tools/bootstrap.ts`).

The seed is C text, about 0.56 MB in all. Regenerate it after any change to `compiler/*.a0`:

```sh
bun run seed             # stage 1 (TypeScript C backend + clang) compiles the compiler; writes seed/;
                         # then runs bootstrap.sh under a PATH of /usr/bin:/bin as the proof
bun run seed -- --check  # cheap freshness check (no build), also run by test/seed.test.ts
```

Checked with Apple clang on macOS arm64; other C11 compilers with `-pthread` should work (the stage
main runs the compiler on a 1 GiB thread stack).
