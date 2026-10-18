/* Trusted read-only host views of generic arena allocations. No source interpretation. */
#include <stdint.h>
#include "arena_runtime.c"

uintptr_t a0_memory_view(a0_arena_session *session, uint32_t handle) {
  if (!session || !handle || handle > session->allocation_count) return 0;
  return (uintptr_t)session->allocations[handle - 1].words;
}

uint32_t a0_memory_view_length(a0_arena_session *session, uint32_t handle) {
  if (!session || !handle || handle > session->allocation_count) return 0;
  return session->allocations[handle - 1].length;
}
