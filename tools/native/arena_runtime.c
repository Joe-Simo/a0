#include "arena_runtime.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

enum {
  ARGUMENT_MAX = 3 + A0_ARENA_BULK_MAX,
  /* The largest reply (2+128 words), followed by one protocol-error frame. */
  RESPONSE_MAX = 2 + A0_ARENA_BULK_MAX + 2
};

typedef struct {
  uint32_t *words;
  uint32_t length;
} allocation;

struct a0_arena_session {
  uint32_t max_words;
  uint32_t max_output_words;
  allocation *allocations;
  uint32_t allocation_count;
  uint32_t allocation_capacity;
  uint32_t allocated_words;
  uint32_t *output;
  uint32_t output_count;
  uint32_t output_capacity;
  uint32_t request_op;
  uint32_t argument_count;
  uint32_t arguments_received;
  uint32_t arguments[ARGUMENT_MAX];
  unsigned request_phase; /* 0 op, 1 argumentCount, 2 arguments */
  uint32_t response[RESPONSE_MAX];
  uint32_t response_count;
  uint32_t response_position;
  bool protocol_failed;
  bool finished;
  uint32_t finish_code;
};

static void release_allocations(a0_arena_session *s) {
  for (uint32_t i = 0; i < s->allocation_count; i++)
    free(s->allocations[i].words);
  free(s->allocations);
  s->allocations = NULL;
  s->allocation_count = 0;
  s->allocation_capacity = 0;
  s->allocated_words = 0;
}

static void response(a0_arena_session *s, uint32_t status,
                     const uint32_t *payload, uint32_t count) {
  assert(s->response_position == s->response_count);
  assert(count <= A0_ARENA_BULK_MAX);
  s->response[0] = status;
  s->response[1] = count;
  if (count != 0)
    memcpy(s->response + 2, payload, (size_t)count * sizeof(uint32_t));
  s->response_position = 0;
  s->response_count = count + 2;
}

static void protocol_failure(a0_arena_session *s) {
  if (s->protocol_failed) return;
  s->protocol_failed = true;
  s->request_phase = 0;
  s->arguments_received = 0;
  const uint32_t unread = s->response_count - s->response_position;
  if (unread != 0)
    memmove(s->response, s->response + s->response_position,
            (size_t)unread * sizeof(uint32_t));
  assert(unread + 2 <= RESPONSE_MAX);
  s->response[unread] = A0_ARENA_PROTOCOL;
  s->response[unread + 1] = 0;
  s->response_position = 0;
  s->response_count = unread + 2;
}

static bool arguments_shape(uint32_t op, uint32_t count) {
  switch (op) {
    case A0_ARENA_ALLOC:
    case A0_ARENA_FINISH:
      return count == 1;
    case A0_ARENA_LOAD:
      return count == 3;
    case A0_ARENA_STORE:
      return count >= 3 && count <= ARGUMENT_MAX;
    case A0_ARENA_EMIT:
      return count >= 1 && count <= 1 + A0_ARENA_BULK_MAX;
    default:
      return false;
  }
}

static bool reserve_allocation_slot(a0_arena_session *s) {
  if (s->allocation_count < s->allocation_capacity) return true;
  uint64_t capacity = s->allocation_capacity == 0
                          ? 8
                          : (uint64_t)s->allocation_capacity * 2;
  if (capacity > s->max_words) capacity = s->max_words;
  if (capacity <= s->allocation_count ||
      capacity > SIZE_MAX / sizeof(allocation))
    return false;
  allocation *next = realloc(s->allocations, (size_t)capacity * sizeof(allocation));
  if (next == NULL) return false;
  s->allocations = next;
  s->allocation_capacity = (uint32_t)capacity;
  return true;
}

static void allocate_words(a0_arena_session *s, uint32_t count) {
  if (count == 0) {
    response(s, A0_ARENA_RANGE, NULL, 0);
    return;
  }
  if (count > s->max_words - s->allocated_words ||
#if SIZE_MAX <= UINT32_MAX
      (uint64_t)count > SIZE_MAX / sizeof(uint32_t) ||
#endif
      s->allocation_count == UINT32_MAX || !reserve_allocation_slot(s)) {
    response(s, A0_ARENA_ALLOCATION, NULL, 0);
    return;
  }
  uint32_t *words = calloc((size_t)count, sizeof(uint32_t));
  if (words == NULL) {
    response(s, A0_ARENA_ALLOCATION, NULL, 0);
    return;
  }
  allocation *slot = s->allocations + s->allocation_count;
  slot->words = words;
  slot->length = count;
  s->allocation_count++;
  s->allocated_words += count;
  response(s, A0_ARENA_OK, &s->allocation_count, 1);
}

static void access_words(a0_arena_session *s, bool store) {
  const uint32_t handle = s->arguments[0];
  const uint32_t offset = s->arguments[1];
  const uint32_t count = s->arguments[2];
  if (store && (uint64_t)s->argument_count != UINT64_C(3) + count) {
    protocol_failure(s);
    return;
  }
  if (count > A0_ARENA_BULK_MAX) {
    response(s, A0_ARENA_RANGE, NULL, 0);
    return;
  }
  if (handle == 0 || handle > s->allocation_count) {
    response(s, A0_ARENA_HANDLE, NULL, 0);
    return;
  }
  allocation *slot = s->allocations + (handle - 1);
  if (offset > slot->length || count > slot->length - offset) {
    response(s, A0_ARENA_RANGE, NULL, 0);
    return;
  }
  if (store) {
    if (count != 0)
      memcpy(slot->words + offset, s->arguments + 3,
             (size_t)count * sizeof(uint32_t));
    response(s, A0_ARENA_OK, NULL, 0);
  } else {
    response(s, A0_ARENA_OK, slot->words + offset, count);
  }
}

static bool reserve_output(a0_arena_session *s, uint32_t needed) {
  if (needed <= s->output_capacity) return true;
  uint64_t capacity = s->output_capacity == 0
                          ? A0_ARENA_BULK_MAX
                          : (uint64_t)s->output_capacity * 2;
  if (capacity < needed) capacity = needed;
  if (capacity > s->max_output_words) capacity = s->max_output_words;
  if (capacity < needed || capacity > SIZE_MAX / sizeof(uint32_t)) return false;
  uint32_t *next = realloc(s->output, (size_t)capacity * sizeof(uint32_t));
  if (next == NULL) return false;
  s->output = next;
  s->output_capacity = (uint32_t)capacity;
  return true;
}

static void emit_words(a0_arena_session *s) {
  const uint32_t count = s->arguments[0];
  if ((uint64_t)s->argument_count != UINT64_C(1) + count) {
    protocol_failure(s);
    return;
  }
  if (count > A0_ARENA_BULK_MAX) {
    response(s, A0_ARENA_RANGE, NULL, 0);
    return;
  }
  if (count > s->max_output_words - s->output_count ||
      !reserve_output(s, s->output_count + count)) {
    response(s, A0_ARENA_ALLOCATION, NULL, 0);
    return;
  }
  if (count != 0)
    memcpy(s->output + s->output_count, s->arguments + 1,
           (size_t)count * sizeof(uint32_t));
  s->output_count += count;
  response(s, A0_ARENA_OK, NULL, 0);
}

static void complete_request(a0_arena_session *s) {
  s->request_phase = 0;
  if (s->finished) {
    response(s, A0_ARENA_FINISHED, NULL, 0);
    return;
  }
  switch (s->request_op) {
    case A0_ARENA_ALLOC:
      allocate_words(s, s->arguments[0]);
      break;
    case A0_ARENA_LOAD:
      access_words(s, false);
      break;
    case A0_ARENA_STORE:
      access_words(s, true);
      break;
    case A0_ARENA_EMIT:
      emit_words(s);
      break;
    case A0_ARENA_FINISH:
      s->finish_code = s->arguments[0];
      s->finished = true;
      release_allocations(s);
      response(s, A0_ARENA_OK, NULL, 0);
      break;
    default:
      protocol_failure(s);
      break;
  }
}

a0_arena_session *a0_arena_create(uint32_t max_words,
                                  uint32_t max_output_words) {
  a0_arena_session *s = calloc(1, sizeof(*s));
  if (s == NULL) return NULL;
  s->max_words = max_words;
  s->max_output_words = max_output_words;
  a0_arena_reset(s);
  return s;
}

void a0_arena_reset(a0_arena_session *s) {
  assert(s != NULL);
  release_allocations(s);
  free(s->output);
  s->output = NULL;
  s->output_count = 0;
  s->output_capacity = 0;
  s->request_op = 0;
  s->argument_count = 0;
  s->arguments_received = 0;
  s->request_phase = 0;
  s->response_count = 0;
  s->response_position = 0;
  s->protocol_failed = false;
  s->finished = false;
  s->finish_code = 0;
  const uint32_t hello[] = {A0_ARENA_MAGIC, A0_ARENA_VERSION};
  response(s, A0_ARENA_OK, hello, 2);
}

void a0_arena_destroy(a0_arena_session *s) {
  if (s == NULL) return;
  release_allocations(s);
  free(s->output);
  free(s);
}

uint32_t a0_runtime_read(a0_arena_session *s) {
  assert(s != NULL);
  if (s->request_phase != 0) protocol_failure(s);
  if (s->response_position == s->response_count) {
    if (s->protocol_failed) {
      response(s, A0_ARENA_PROTOCOL, NULL, 0);
    } else {
      protocol_failure(s);
    }
  }
  return s->response[s->response_position++];
}

void a0_runtime_write(a0_arena_session *s, uint32_t word) {
  assert(s != NULL);
  if (s->protocol_failed) return;
  if (s->response_position != s->response_count) {
    protocol_failure(s);
    return;
  }
  if (s->request_phase == 0) {
    s->request_op = word;
    s->request_phase = 1;
    return;
  }
  if (s->request_phase == 1) {
    if (!arguments_shape(s->request_op, word)) {
      protocol_failure(s);
      return;
    }
    s->argument_count = word;
    s->arguments_received = 0;
    s->request_phase = 2;
    return;
  }
  assert(s->arguments_received < s->argument_count);
  assert(s->arguments_received < ARGUMENT_MAX);
  s->arguments[s->arguments_received++] = word;
  if (s->arguments_received == s->argument_count) complete_request(s);
}

bool a0_arena_protocol_failed(const a0_arena_session *s) {
  assert(s != NULL);
  return s->protocol_failed;
}
bool a0_arena_is_finished(const a0_arena_session *s) {
  assert(s != NULL);
  return s->finished;
}
bool a0_arena_is_complete(const a0_arena_session *s) {
  assert(s != NULL);
  return s->finished && !s->protocol_failed && s->request_phase == 0 &&
         s->response_position == s->response_count;
}
uint32_t a0_arena_finish_code(const a0_arena_session *s) {
  assert(s != NULL);
  return s->finish_code;
}
uint32_t a0_arena_allocated_words(const a0_arena_session *s) {
  assert(s != NULL);
  return s->allocated_words;
}
uint32_t a0_arena_allocation_count(const a0_arena_session *s) {
  assert(s != NULL);
  return s->allocation_count;
}
uint32_t a0_arena_output_count(const a0_arena_session *s) {
  assert(s != NULL);
  return s->output_count;
}
const uint32_t *a0_arena_output(const a0_arena_session *s) {
  assert(s != NULL);
  return s->output;
}
