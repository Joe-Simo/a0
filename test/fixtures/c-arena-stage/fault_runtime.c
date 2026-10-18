/* Test-only transport corruption. Production stage/shim have no fault mode. */
#define a0_runtime_read storage_read
#define a0_runtime_write storage_write
#include "arena_runtime.c"
#undef a0_runtime_read
#undef a0_runtime_write
#include <string.h>

static uint32_t phase, op, count, at, allocations, injected[2], cursor = 2;
static bool used;
static const char *fault(void) {
  const char *value = getenv("A0_STAGE_FAULT");
  return value ? value : "";
}
uint32_t a0_runtime_read(a0_arena_session *s) {
  return cursor < 2 ? injected[cursor++] : storage_read(s);
}
void a0_runtime_write(a0_arena_session *s, uint32_t word) {
  bool done = false;
  if (!phase) { op = word; phase = 1; }
  else if (phase == 1) { count = word; at = 0; phase = count ? 2 : 0; done = !count; }
  else {
    /* EMIT argument zero is its count; argument one is the first byte. */
    if (!used && op == A0_ARENA_EMIT && at == 1 && !strcmp(fault(), "nonbyte")) {
      word = 256; used = true;
    }
    done = ++at == count;
    if (done) phase = 0;
  }
  storage_write(s, word);
  if (!done) return;
  if (op == A0_ARENA_ALLOC) allocations++;
  bool load = op == A0_ARENA_LOAD && !strcmp(fault(), "load");
  bool alloc = op == A0_ARENA_ALLOC && allocations == 2 && !strcmp(fault(), "alloc");
  bool finish = op == A0_ARENA_FINISH && !strcmp(fault(), "finish");
  if (!used && (load || alloc || finish)) {
    (void)storage_read(s);
    uint32_t n = storage_read(s);
    for (uint32_t i = 0; i < n; i++) (void)storage_read(s);
    injected[0] = finish ? 0 : alloc ? 4 : 5;
    injected[1] = finish ? 1 : 0;
    cursor = 0; used = true;
  }
}
