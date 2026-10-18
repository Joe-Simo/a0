#include "arena_runtime.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>

static uint64_t checks;

#define CHECK(condition)                                                        \
  do {                                                                          \
    checks++;                                                                   \
    if (!(condition)) {                                                         \
      fprintf(stderr, "reply wire failure at %s:%d: %s\n", __FILE__, __LINE__,   \
              #condition);                                                      \
      exit(1);                                                                  \
    }                                                                           \
  } while (0)

static void send(a0_arena_session *s, uint32_t op, const uint32_t *args,
                 uint32_t count) {
  a0_runtime_write(s, op);
  a0_runtime_write(s, count);
  for (uint32_t i = 0; i < count; i++) a0_runtime_write(s, args[i]);
}

static void empty(a0_arena_session *s, uint32_t status) {
  CHECK(a0_runtime_read(s) == status);
  CHECK(a0_runtime_read(s) == 0);
}

static void hello(a0_arena_session *s) {
  CHECK(a0_runtime_read(s) == 0);
  CHECK(a0_runtime_read(s) == 2);
  CHECK(a0_runtime_read(s) == UINT32_C(0x41304152));
  CHECK(a0_runtime_read(s) == 1);
  CHECK(!a0_arena_protocol_failed(s));
  CHECK(!a0_arena_is_finished(s));
  CHECK(!a0_arena_is_complete(s));
  CHECK(a0_arena_allocated_words(s) == 0);
  CHECK(a0_arena_allocation_count(s) == 0);
  CHECK(a0_arena_output_count(s) == 0);
}

static uint32_t allocate(a0_arena_session *s, uint32_t size) {
  send(s, 1, &size, 1);
  CHECK(a0_runtime_read(s) == 0);
  CHECK(a0_runtime_read(s) == 1);
  const uint32_t handle = a0_runtime_read(s);
  CHECK(handle != 0);
  return handle;
}

static void finish(a0_arena_session *s) {
  const uint32_t code = UINT32_MAX;
  send(s, 5, &code, 1);
  empty(s, 0);
  CHECK(a0_arena_is_finished(s));
  CHECK(a0_arena_is_complete(s));
  CHECK(a0_arena_finish_code(s) == UINT32_MAX);
  CHECK(a0_arena_allocated_words(s) == 0);
  CHECK(a0_arena_allocation_count(s) == 0);
}

static void clean_after_reset(a0_arena_session *s) {
  a0_arena_reset(s);
  hello(s);
  const uint32_t handle = allocate(s, 1);
  CHECK(handle == 1);
  const uint32_t args[] = {handle, 0, 1};
  send(s, 2, args, 3);
  CHECK(a0_runtime_read(s) == 0);
  CHECK(a0_runtime_read(s) == 1);
  CHECK(a0_runtime_read(s) == 0);
  finish(s);
}

/* The expected wire frame is built directly from the stored values, without
 * inspecting runtime storage, pointers, reply buffers or cursor state. Every
 * payload size and every boundary in its status/count/payload are exercised. */
static void test_load_reply_splits(void) {
  uint32_t values[128];
  for (uint32_t i = 0; i < 128; i++)
    values[i] = UINT32_C(0x9e3779b9) * i ^ UINT32_C(0xc001d00d);
  values[0] = 0;
  values[127] = UINT32_MAX;
  for (uint32_t count = 0; count <= 128; count++) {
    uint32_t expected[130] = {0, count};
    for (uint32_t i = 0; i < count; i++) expected[2 + i] = values[i];
    const uint32_t length = count + 2;
    for (uint32_t split = 0; split <= length; split++) {
      for (uint32_t action = 0; action < 3; action++) {
        a0_arena_session *s = a0_arena_create(129, 1);
        CHECK(s != NULL);
        hello(s);
        const uint32_t handle = allocate(s, 129);
        uint32_t store[] = {handle, 1, 128, 0};
        uint32_t packet[131] = {handle, 1, 128};
        for (uint32_t i = 0; i < 128; i++) packet[3 + i] = values[i];
        send(s, 3, packet, 131);
        empty(s, 0);
        /* Zero-length LOAD at exactly the allocation end is valid. */
        const uint32_t args[] = {handle, count == 0 ? 129 : 1, count};
        send(s, 2, args, 3);
        for (uint32_t i = 0; i < split; i++)
          CHECK(a0_runtime_read(s) == expected[i]);
        if (action == 0) {
          if (split < length) {
            /* None of STORE, FINISH or EMIT may execute while a reply is
             * pending, even after the first write makes the error sticky. */
            store[2] = 1;
            store[3] = UINT32_MAX;
            send(s, 3, store, 4);
            const uint32_t code = 7;
            send(s, 5, &code, 1);
            const uint32_t emit[] = {1, 42};
            send(s, 4, emit, 2);
            CHECK(a0_arena_protocol_failed(s));
            CHECK(!a0_arena_is_finished(s));
            CHECK(!a0_arena_is_complete(s));
            CHECK(a0_arena_allocated_words(s) == 129);
            CHECK(a0_arena_allocation_count(s) == 1);
            CHECK(a0_arena_output_count(s) == 0);
            for (uint32_t i = split; i < length; i++)
              CHECK(a0_runtime_read(s) == expected[i]);
            empty(s, 1);
            send(s, 5, &code, 1);
            empty(s, 1);
            CHECK(!a0_arena_is_finished(s));
          } else {
            /* A fully drained LOAD allows a mutation and another LOAD. The
             * next response must observe the new value rather than stale data. */
            store[2] = 1;
            store[3] = UINT32_MAX;
            send(s, 3, store, 4);
            empty(s, 0);
            const uint32_t next[] = {handle, 1, 1};
            send(s, 2, next, 3);
            CHECK(a0_runtime_read(s) == 0);
            CHECK(a0_runtime_read(s) == 1);
            CHECK(a0_runtime_read(s) == UINT32_MAX);
            finish(s);
          }
          clean_after_reset(s);
        } else if (action == 1) {
          /* Reset may discard a header, payload or completely drained view. */
          clean_after_reset(s);
        }
        /* Destroy must also release allocations with a pending view. */
        a0_arena_destroy(s);
      }
    }
  }
}

/* Non-LOAD replies still have the same retention rule, including the initial
 * greeting, the one-word allocation result, ordinary errors and FINISH. */
static void test_other_reply_splits(void) {
  for (uint32_t kind = 0; kind < 4; kind++) {
    const uint32_t lengths[] = {4, 3, 2, 2};
    const uint32_t frames[][4] = {
        {0, 2, UINT32_C(0x41304152), 1}, {0, 1, 1, 0}, {2, 0, 0, 0}, {0, 0, 0, 0}};
    for (uint32_t split = 0; split < lengths[kind]; split++) {
      a0_arena_session *s = a0_arena_create(1, 1);
      CHECK(s != NULL);
      if (kind != 0) hello(s);
      if (kind == 1) {
        const uint32_t size = 1;
        send(s, 1, &size, 1);
      } else if (kind == 2) {
        const uint32_t invalid[] = {0, 0, 0};
        send(s, 2, invalid, 3);
      } else if (kind == 3) {
        (void)allocate(s, 1);
        const uint32_t code = UINT32_MAX;
        send(s, 5, &code, 1);
      }
      for (uint32_t i = 0; i < split; i++)
        CHECK(a0_runtime_read(s) == frames[kind][i]);
      a0_runtime_write(s, 5);
      CHECK(a0_arena_protocol_failed(s));
      for (uint32_t i = split; i < lengths[kind]; i++)
        CHECK(a0_runtime_read(s) == frames[kind][i]);
      empty(s, 1);
      empty(s, 1);
      CHECK(a0_arena_is_finished(s) == (kind == 3));
      clean_after_reset(s);
      a0_arena_destroy(s);
    }
  }
}

static void test_request_splits(void) {
  uint32_t packets[7][133] = {
      {1, 1, 1}, {2, 3, 1, 0, 128}, {3, 131, 1, 0, 128},
      {4, 129, 128}, {5, 1, UINT32_MAX}, {3, 3, 1, 129, 0}, {4, 1, 0}};
  const uint32_t lengths[] = {3, 5, 133, 131, 3, 5, 3};
  for (uint32_t i = 0; i < 128; i++) {
    packets[2][5 + i] = i ^ UINT32_MAX;
    packets[3][3 + i] = i;
  }
  for (uint32_t kind = 0; kind < 7; kind++) {
    for (uint32_t split = 0; split < lengths[kind]; split++) {
      a0_arena_session *s = a0_arena_create(129, 128);
      CHECK(s != NULL);
      hello(s);
      (void)allocate(s, 129);
      for (uint32_t i = 0; i < split; i++) a0_runtime_write(s, packets[kind][i]);
      /* Reading any incomplete request is an error, with no partial effect. */
      empty(s, 1);
      CHECK(a0_arena_protocol_failed(s));
      CHECK(!a0_arena_is_finished(s));
      CHECK(a0_arena_allocated_words(s) == 129);
      CHECK(a0_arena_allocation_count(s) == 1);
      CHECK(a0_arena_output_count(s) == 0);
      for (uint32_t i = split; i < lengths[kind]; i++)
        a0_runtime_write(s, packets[kind][i]);
      empty(s, 1);
      clean_after_reset(s);
      a0_arena_destroy(s);
    }
  }
}

int main(void) {
  test_load_reply_splits();
  test_other_reply_splits();
  test_request_splits();
  printf("arena reply wire: %" PRIu64 " checks passed\n", checks);
  return 0;
}
