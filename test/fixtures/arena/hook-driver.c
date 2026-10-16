#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "arena_runtime.h"
static a0_arena_session *compiler_session;
#define A0_COMPILER_READ(t) ((void)(t), a0_runtime_read(compiler_session))
#define A0_COMPILER_WRITE(t, v) ((void)(t), a0_runtime_write(compiler_session, (v)))
#include "module.c"

static int check(a0_arena_session *s) {
  a0_io io, before;
  memset(&io, 0xa5, sizeof io);
  io.ninput = 0;
  io.position = 123;
  io.noutput = 999;
  memcpy(&before, &io, sizeof io);
  compiler_session = s;
  uint32_t (*entry)(a0_io *) = a0_arena_probe;
  if (entry(&io) != 0u) return 1;
  if (memcmp(&before, &io, sizeof io) != 0) return 2;
  if (!a0_arena_is_complete(s)) return 3;
  if (a0_arena_finish_code(s) != 17u) return 4;
  if (a0_arena_allocated_words(s) != 0u || a0_arena_allocation_count(s) != 0u) return 5;
  if (a0_arena_output_count(s) != 131u) return 6;
  const uint32_t *out = a0_arena_output(s);
  for (uint32_t i = 0; i < 128u; i++) {
    const uint32_t expected = (uint32_t)((uint64_t)i * UINT32_C(2654435761)) ^ UINT32_MAX;
    if (out[i] != expected) return 7;
  }
  if (out[128] != 17u || out[129] != UINT32_MAX || out[130] != 65536u) return 8;
  return 0;
}
static int check_checked(void) {
  compiler_session = a0_arena_create(1u, 0u);
  if (compiler_session == NULL) return 91;
  const uint32_t hello[] = {0u, 2u, A0_ARENA_MAGIC, A0_ARENA_VERSION};
  for (uint32_t i = 0; i < 4u; i++)
    if (a0_runtime_read(compiler_session) != hello[i]) return 92;
  const uint32_t allocate[] = {1u, 1u, 1u};
  for (uint32_t i = 0; i < 3u; i++) a0_runtime_write(compiler_session, allocate[i]);
  if (a0_runtime_read(compiler_session) != 0u || a0_runtime_read(compiler_session) != 1u) return 93;
  const uint32_t handle = a0_runtime_read(compiler_session);
  const uint32_t store[] = {3u, 4u, handle, 0u, 1u, UINT32_MAX};
  for (uint32_t i = 0; i < 6u; i++) a0_runtime_write(compiler_session, store[i]);
  if (a0_runtime_read(compiler_session) != 0u || a0_runtime_read(compiler_session) != 0u) return 94;
  const uint32_t load[] = {2u, 3u, handle, 0u, 1u};
  for (uint32_t i = 0; i < 5u; i++) a0_runtime_write(compiler_session, load[i]);
  a0_io io;
  memset(&io, 0, sizeof io);
  const uint32_t result = a0_checked_transport(&io);
  const bool complete = a0_arena_is_complete(compiler_session);
  const uint32_t code = a0_arena_finish_code(compiler_session);
  a0_arena_destroy(compiler_session);
  return result == 0u && complete && code == 7u ? 0 : 95;
}
int main(void) {
  a0_arena_session *a = a0_arena_create(70008u, 256u);
  a0_arena_session *b = a0_arena_create(70008u, 256u);
  if (a == NULL || b == NULL) return 90;
  int code = check(a);
  if (code == 0) code = check(b);
  if (code == 0 && (a0_arena_output_count(a) != 131u || a0_arena_finish_code(a) != 17u)) code = 9;
  a0_arena_reset(a);
  if (code == 0) code = check(a);
  a0_arena_destroy(a);
  a0_arena_destroy(b);
  if (code == 0) code = check_checked();
  if (code != 0) fprintf(stderr, "A0 arena integration failed: %d\n", code);
  return code;
}
