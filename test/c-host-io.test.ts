import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { A0Error, formatTrap, makeIo, parseAndValidate, run } from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';

const SOURCE = `fn transfer (u32,io) u32 -> (u32,io)
sum at p0 0
token at p0 1
input read token
value at input 0
next at input 1
total add sum value
written write next value
out rec total written
ret out
end
fn stream io u32 -> (u32,io)
initial rec 0 p0
out fold transfer p1 initial
ret out
end
fn message io -> io
text text "λ"
out puts p0 text
ret out
end
`;
const clang = findClang();
for (const strict of [false, true])
  for (const optimize of [false, true])
    test(`C host streams preserve words, tokens and input semantics: strict=${strict}, optimize=${optimize}`, {
      skip: clang.path === undefined ? 'clang is unavailable' : false,
    }, async () => {
      assert.ok(clang.path);
      const program = parseAndValidate(`${strict ? 'profile strict\n' : ''}${SOURCE}`);
      const stream = program.byName.get('stream');
      assert.ok(stream);
      const inputs = Array.from({ length: 1500 }, (_, i) => (0xffffffff - i) >>> 0);
      const token = makeIo(inputs);
      const expected = run(stream, [token, inputs.length]) as [number, typeof token];
      assert.strictEqual(expected[1], token);
      assert.deepEqual(token.output, inputs);
      let shortExpected: number | undefined;
      let shortTrap: string | undefined;
      try {
        shortExpected = (
          run(stream, [makeIo(inputs.slice(0, 1499)), 1500]) as [number, unknown]
        )[0];
      } catch (error) {
        assert.ok(error instanceof A0Error && error.trap);
        shortTrap = formatTrap(error.trap);
      }
      const driver = `#include <stdio.h>
#include <stdbool.h>
#include <stdint.h>
struct a0_io { void *context; bool (*read)(void *, uint32_t *); void (*write)(void *, uint32_t); };
#define A0_IO_READ(t, out) ((t)->read((t)->context, (out)))
#define A0_IO_WRITE(t, word) ((t)->write((t)->context, (word)))
#include "module.c"
typedef struct { uint32_t position, limit, count, sum; } stream_state;
static bool read_word(void *context, uint32_t *out) {
  stream_state *s = context;
  if (s->position == s->limit) { *out = 123456789u; return false; }
  *out = 0xffffffffu - s->position++; return true;
}
static void write_word(void *context, uint32_t value) {
  stream_state *s = context; s->count++; s->sum += value;
}
int main(int argc, char **argv) {
  (void)argv;
  stream_state s = {0, argc > 1 ? 1499u : 1500u, 0, 0};
  a0_io token = { &s, read_word, write_word };
  a0t_r2_u_io out = a0_stream(&token, 1500u);
  if (out.f1 != &token || s.count != 1500u || s.sum != out.f0) return 9;
  printf("%u\\n", out.f0);
  s.count = 0; s.sum = 0;
  if (a0_message(&token) != &token || s.count != 3u || s.sum != 395u) return 10;
  return 0;
}
`;
      await withTempDir(async (dir) => {
        await writeFile(
          join(dir, 'module.c'),
          compile(program, 'c', { optimize, cIo: 'host' }).text,
        );
        await writeFile(join(dir, 'driver.c'), driver);
        for (const level of ['-O0', '-O2']) {
          const built = runTool(
            clang.path as string,
            [
              '-std=c11',
              level,
              '-Wall',
              '-Wextra',
              '-Wno-unused-parameter',
              '-Werror',
              '-fsanitize=undefined',
              '-fno-sanitize-recover=all',
              'driver.c',
              '-o',
              'driver',
            ],
            { cwd: dir },
          );
          assert.ok(built.ok, built.stderr);
          const full = runTool(join(dir, 'driver'), [], { cwd: dir });
          assert.ok(full.ok, `${full.stderr}\n${full.stdout}`);
          assert.equal(full.stdout, `${expected[0]}\n`);
          const short = runTool(join(dir, 'driver'), ['short'], { cwd: dir });
          if (strict) {
            assert.equal(short.status, 3);
            assert.equal(short.stderr.trim(), shortTrap);
          } else {
            assert.ok(short.ok, short.stderr);
            assert.equal(short.stdout, `${shortExpected}\n`);
          }
        }
      });
    });
