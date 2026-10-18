import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAndValidate } from '../../../dist/src/core.js';
import { link } from '../../../dist/src/link.js';
import { runTool } from '../../../dist/src/toolchain.js';
import { nativeEmit } from './transport.mjs';

const root = process.argv[2],
  work = `${root}/build/host-io`,
  clang = process.argv[3],
  runtime = resolve('tools/native');
assert.ok(root && clang);
mkdirSync(work, { recursive: true });
const results = [];
let serial = 0;

// Always compile the native A0 emitter's bytes verbatim. Only the including
// caller selects hooks; neither the fixture nor TS rewrites generated C.
function target(text, before, main, level, extra = [], failure = false) {
  const stem = `${work}/target-${serial++}`;
  writeFileSync(`${stem}.module.c`, text);
  writeFileSync(
    `${stem}.c`,
    `#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
${before}
#include "${stem.split('/').at(-1)}.module.c"
${main}
`,
  );
  const built = runTool(
    clang,
    [
      '-std=c11',
      `-O${level}`,
      '-Wall',
      '-Wextra',
      '-Wno-unused-parameter',
      '-Werror',
      '-fsanitize=undefined',
      '-fno-sanitize-recover=all',
      '-I',
      runtime,
      `${stem}.c`,
      ...extra,
      '-o',
      stem,
    ],
    { timeoutMs: 120000 },
  );
  if (failure) {
    assert.equal(built.ok, false, 'an incomplete public hook pair must not compile');
    assert.match(built.stderr, /host I\/O requires A0_IO_READ/);
    return;
  }
  assert.ok(built.ok, built.stderr);
  const ran = runTool(stem, [], { timeoutMs: 120000 });
  assert.ok(ran.ok, ran.stderr);
}

const stream = parseAndValidate(`fn hookecho u32 -> u32
ret p0
end
fn f u32 io -> io
a read p1
v at a 0
t at a 1
b read t
w at b 0
u at b 1
c read u
x at c 0
y at c 1
d read y
z at d 0
last at d 1
q arr v w x z p0 0 4294967295
o puts last q
r write o 27
ret r
end
`);
const customStream = `struct a0_io {
  uint32_t input[2], count, position, reads, output[16], writes, tag;
};
uint32_t a0_hookecho(uint32_t);
static struct a0_io *expected;
static bool host_read(struct a0_io *t, uint32_t *out) {
  assert(t == expected && t->tag == 123456789u);
  assert(a0_hookecho(t->tag) == t->tag);
  t->reads++;
  if (t->position == t->count) { *out = 3735928559u; return false; }
  *out = t->input[t->position++];
  return true;
}
static void host_write(struct a0_io *t, uint32_t word) {
  assert(t == expected && t->tag == 123456789u);
  assert(a0_hookecho(word) == word);
  assert(t->writes < 16);
  t->output[t->writes++] = word;
}
#define A0_IO_READ(t, out) host_read((t), (out))
#define A0_IO_WRITE(t, word) host_write((t), (word))
// A complete public pair must take precedence over compiler compatibility hooks.
#define A0_COMPILER_READ(t) (assert(0), 0u)
#define A0_COMPILER_WRITE(t, word) assert(0)
`;
const streamMain = `int main(void) {
  a0_io streams[3] = {0};
  for (uint32_t n = 0; n < 3; n++) {
    a0_io *io = streams + n;
    io->input[0] = 0; io->input[1] = UINT32_MAX;
    io->count = n; io->tag = 123456789u; expected = io;
    assert(a0_f(77u, io) == io);
    const uint32_t words[] = {7u, 0u, n == 2 ? UINT32_MAX : 0u,
                             0u, 0u, 77u, 0u, UINT32_MAX, 27u};
    assert(io->reads == 4 && io->position == n && io->writes == 9);
    assert(memcmp(io->output, words, sizeof words) == 0);
    assert(io->tag == 123456789u);
  }
}
`;
const bufferedMain = `int main(void) {
  const uint32_t counts[] = {0u, 1u, 2u, 9u};
  for (uint32_t i = 0; i < 4; i++) {
    a0_io io = {0};
    io.ninput = counts[i]; io.input[0] = 0; io.input[1] = UINT32_MAX;
    assert(a0_f(77u, &io) == &io);
    assert(io.position == (counts[i] < 2 ? counts[i] : 2));
    assert(io.noutput == 3);
    assert(io.output[0] == 7 && io.output[1] == 0);
    assert(io.output[2] == (counts[i] >= 2 ? UINT32_MAX : 0));
    assert(io.ninput == counts[i]);
  }
}
`;
const strict = parseAndValidate(`profile strict
fn f io -> (u32,io)
r read p0
ret r
end
`);
const arena = await link(resolve('compiler/arena.a0'), (path) => readFileSync(path, 'utf8'));

for (const level of [0, 2]) {
  const emitted = nativeEmit(stream, level, 2, 3);
  assert.equal(emitted.code, 0);
  target(emitted.text, customStream, streamMain, level);
  results.push({
    level,
    name: 'public-stream-eof-puts-token-identity-and-local-reentry',
    cases: 3,
  });
  target(emitted.text, '', bufferedMain, level);
  results.push({ level, name: 'buffered-capacity-eof-and-dropped-output', cases: 4 });
  for (const [name, macro] of [
    ['read-only', '#define A0_IO_READ(t, out) ((void)(t), *(out) = 0u, false)'],
    ['write-only', '#define A0_IO_WRITE(t, word) ((void)(t), (void)(word))'],
  ]) {
    target(emitted.text, `struct a0_io { uint32_t custom; };\n${macro}`, '', level, [], true);
    results.push({ level, name: `public-${name}-refused`, cases: 1 });
  }
  target(
    emitted.text,
    '#define A0_COMPILER_READ(t) ((void)(t), 9u)',
    `int main(void) {
      a0_io io = {0};
      assert(a0_f(77u, &io) == &io);
      assert(io.position == 0 && io.noutput == 3);
      assert(io.output[0] == 7 && io.output[1] == 9 && io.output[2] == 9);
    }`,
    level,
  );
  results.push({ level, name: 'legacy-read-only-buffered-write', cases: 1 });
  target(
    emitted.text,
    `static uint32_t legacy_words[16], legacy_count;
#define A0_COMPILER_WRITE(t, word) ((void)(t), legacy_words[legacy_count++] = (word))`,
    `int main(void) {
      a0_io io = {0}; io.ninput = 2; io.input[0] = 0; io.input[1] = UINT32_MAX;
      assert(a0_f(77u, &io) == &io);
      const uint32_t words[] = {7u, 0u, UINT32_MAX, 0u, 0u, 77u, 0u, UINT32_MAX, 27u};
      assert(io.position == 2 && io.noutput == 0 && legacy_count == 9);
      assert(memcmp(legacy_words, words, sizeof words) == 0);
    }`,
    level,
  );
  results.push({ level, name: 'legacy-write-only-buffered-read', cases: 1 });

  const refused = nativeEmit(strict, level, 1, 1);
  assert.equal(refused.code, 9);
  assert.equal(refused.text, '');
  assert.equal(refused.status.resultHandle, 0);
  assert.equal(refused.status.resultLength, 0);
  assert.equal(refused.status.outputCount, 0);
  results.push({ level, name: 'strict-read-refused-without-output', cases: 1 });

  // This is a checked-IR emitter component test, not source-frontend evidence:
  // native A0 c_emit emits the repository's real arena protocol helpers.
  const service = nativeEmit(arena.program, level, 1, 1);
  assert.equal(service.code, 0);
  const type = (name) => {
    const found = new RegExp(`^(a0t_[A-Za-z0-9_]+) a0_${name}\\(`, 'm').exec(service.text)?.[1];
    assert.ok(found, `native emitted return type for ${name}`);
    return found;
  };
  const api = [
    ...['hello', 'alloc', 'store', 'load', 'emit', 'finish'].map(
      (name) => `#define ${name.toUpperCase()}_RESULT ${type(`arena_${name}`)}`,
    ),
    `#define PAGE ${type('arena_zero')}`,
  ].join('\n');
  target(
    service.text,
    `#include "arena_runtime.h"
struct a0_io {
  a0_arena_session *session;
  uint32_t reads, writes, read_run, write_run, max_read, max_write, tag;
};
static struct a0_io *expected;
static bool host_read(struct a0_io *t, uint32_t *out) {
  assert(t == expected && t->tag == 987654321u);
  t->reads++; t->read_run++; t->write_run = 0;
  if (t->read_run > t->max_read) t->max_read = t->read_run;
  *out = a0_runtime_read(t->session);
  return true;
}
static void host_write(struct a0_io *t, uint32_t word) {
  assert(t == expected && t->tag == 987654321u);
  t->writes++; t->write_run++; t->read_run = 0;
  if (t->write_run > t->max_write) t->max_write = t->write_run;
  a0_runtime_write(t->session, word);
}
#define A0_IO_READ(t, out) host_read((t), (out))
#define A0_IO_WRITE(t, word) host_write((t), (word))`,
    `${api}
static uint32_t source_word(uint32_t round, uint32_t index) {
  if (index == 0) return 0;
  if (index == 128) return UINT32_MAX;
  return index * 2654435761u + round * 101u;
}
int main(void) {
  a0_io tokens[2] = {0};
  for (uint32_t round = 0; round < 2; round++) {
    a0_io *io = tokens + round;
    io->session = a0_arena_create(4096, 385);
    assert(io->session); io->tag = 987654321u; expected = io;
    HELLO_RESULT hello = a0_arena_hello(io);
    assert(hello.f0 == 0 && hello.f1 == io);
    ALLOC_RESULT allocated = a0_arena_alloc(io, 385);
    assert(allocated.f0 == 0 && allocated.f1 != 0 && allocated.f2 == io);
    const uint32_t handle = allocated.f1;
    assert(a0_arena_allocated_words(io->session) == 385);
    for (uint32_t offset = 0; offset < 385;) {
      const uint32_t count = 385 - offset < 128 ? 385 - offset : 128;
      PAGE page = a0_arena_zero();
      for (uint32_t i = 0; i < count; i++) page.e[i] = source_word(round, offset + i);
      const PAGE before = page;
      STORE_RESULT stored = a0_arena_store(io, handle, offset, count, page);
      assert(stored.f0 == 0 && stored.f1 == io);
      assert(memcmp(&page, &before, sizeof page) == 0);
      offset += count;
    }
    for (uint32_t pass = 0; pass < 2; pass++) {
      for (uint32_t offset = 0; offset < 385;) {
        const uint32_t count = 385 - offset < 128 ? 385 - offset : 128;
        LOAD_RESULT loaded = a0_arena_load(io, handle, offset, count);
        assert(loaded.f0 == 0 && loaded.f2 == io);
        for (uint32_t i = 0; i < 128; i++)
          assert(loaded.f1.e[i] == (i < count ? source_word(round, offset + i) : 0));
        if (pass == 0) {
          const PAGE before = loaded.f1;
          EMIT_RESULT emitted = a0_arena_emit(io, count, loaded.f1);
          assert(emitted.f0 == 0 && emitted.f1 == io);
          assert(memcmp(&loaded.f1, &before, sizeof before) == 0);
        }
        offset += count;
      }
    }
    assert(a0_arena_output_count(io->session) == 385);
    const uint32_t *output = a0_arena_output(io->session);
    for (uint32_t i = 0; i < 385; i++) assert(output[i] == source_word(round, i));
    FINISH_RESULT finished = a0_arena_finish(io, 0);
    assert(finished.f0 == 0 && finished.f1 == io);
    assert(a0_arena_is_complete(io->session));
    assert(a0_arena_finish_code(io->session) == 0);
    assert(a0_arena_allocated_words(io->session) == 0);
    assert(a0_arena_allocation_count(io->session) == 0);
    assert(!a0_arena_protocol_failed(io->session));
    assert(io->reads > 385 && io->writes > 385);
    assert(io->max_read == 130 && io->max_write == 133);
    assert(io->tag == 987654321u);
    assert(a0_arena_output_count(io->session) == 385);
    for (uint32_t i = 0; i < 385; i++) assert(output[i] == source_word(round, i));
    a0_arena_destroy(io->session);
  }
}
`,
    level,
    [`${runtime}/arena_runtime.c`],
  );
  results.push({ level, name: 'real-arena-service-tiny-buffer-host-transport', cases: 2 });
}

writeFileSync(`${root}/native-host-io.json`, `${JSON.stringify({ results }, null, 2)}\n`);
console.log({ passed: results.length });
