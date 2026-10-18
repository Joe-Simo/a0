/* Standalone control: requires actual 32-bit size_t, never a simulated macro. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include "arena_runtime.h"
_Static_assert(SIZE_MAX == UINT32_MAX, "this control requires actual 32-bit size_t");
int main(void) {
  a0_arena_session *s = a0_arena_create(UINT32_MAX, 1);
  assert(s);
  assert(a0_runtime_read(s) == 0 && a0_runtime_read(s) == 2);
  assert(a0_runtime_read(s) == A0_ARENA_MAGIC && a0_runtime_read(s) == A0_ARENA_VERSION);
  a0_runtime_write(s, A0_ARENA_ALLOC);
  a0_runtime_write(s, 1);
  a0_runtime_write(s, UINT32_MAX / sizeof(uint32_t) + 1);
  assert(a0_runtime_read(s) == A0_ARENA_ALLOCATION && a0_runtime_read(s) == 0);
  assert(a0_arena_allocation_count(s) == 0 && a0_arena_allocated_words(s) == 0);
  a0_runtime_write(s, A0_ARENA_ALLOC);
  a0_runtime_write(s, 1);
  a0_runtime_write(s, 1);
  assert(a0_runtime_read(s) == 0 && a0_runtime_read(s) == 1 && a0_runtime_read(s) == 1);
  a0_runtime_write(s, A0_ARENA_FINISH);
  a0_runtime_write(s, 1);
  a0_runtime_write(s, 0);
  assert(a0_runtime_read(s) == 0 && a0_runtime_read(s) == 0 && a0_arena_is_complete(s));
  assert(a0_arena_allocation_count(s) == 0 && a0_arena_allocated_words(s) == 0);
  a0_arena_destroy(s);
  puts("actual 32-bit allocation overflow/refusal and small allocation/FINISH passed");
}
