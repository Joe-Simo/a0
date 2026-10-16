#include "arena_runtime.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t checks;

#define CHECK(condition)                                                        \
  do {                                                                          \
    checks++;                                                                   \
    if (!(condition)) {                                                         \
      fprintf(stderr, "arena test failure at %s:%d: %s\n", __FILE__, __LINE__,    \
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

static void expect(a0_arena_session *s, uint32_t status, const uint32_t *payload,
                   uint32_t count) {
  CHECK(a0_runtime_read(s) == status);
  CHECK(a0_runtime_read(s) == count);
  for (uint32_t i = 0; i < count; i++) CHECK(a0_runtime_read(s) == payload[i]);
}

static void hello(a0_arena_session *s) {
  const uint32_t payload[] = {UINT32_C(0x41304152), 1};
  expect(s, A0_ARENA_OK, payload, 2);
  CHECK(!a0_arena_protocol_failed(s));
  CHECK(!a0_arena_is_finished(s));
  CHECK(!a0_arena_is_complete(s));
  CHECK(a0_arena_allocated_words(s) == 0);
  CHECK(a0_arena_allocation_count(s) == 0);
  CHECK(a0_arena_output_count(s) == 0);
}

static uint32_t allocate(a0_arena_session *s, uint32_t count) {
  send(s, A0_ARENA_ALLOC, &count, 1);
  CHECK(a0_runtime_read(s) == A0_ARENA_OK);
  CHECK(a0_runtime_read(s) == 1);
  const uint32_t handle = a0_runtime_read(s);
  CHECK(handle != 0);
  return handle;
}

static void load(a0_arena_session *s, uint32_t handle, uint32_t offset,
                 const uint32_t *expected, uint32_t count) {
  const uint32_t args[] = {handle, offset, count};
  send(s, A0_ARENA_LOAD, args, 3);
  expect(s, A0_ARENA_OK, expected, count);
}

static void store(a0_arena_session *s, uint32_t handle, uint32_t offset,
                  const uint32_t *words, uint32_t count) {
  uint32_t args[3 + 128] = {handle, offset, count};
  for (uint32_t i = 0; i < count; i++) args[3 + i] = words[i];
  send(s, A0_ARENA_STORE, args, 3 + count);
  expect(s, A0_ARENA_OK, NULL, 0);
}

static void emit(a0_arena_session *s, const uint32_t *words, uint32_t count,
                 uint32_t status) {
  uint32_t args[1 + 128] = {count};
  for (uint32_t i = 0; i < count; i++) args[1 + i] = words[i];
  send(s, A0_ARENA_EMIT, args, 1 + count);
  expect(s, status, NULL, 0);
}

static void test_storage(void) {
  a0_arena_session *s = a0_arena_create(257, 512);
  CHECK(s != NULL);
  hello(s);
  const uint32_t h = allocate(s, 256);
  CHECK(a0_arena_allocated_words(s) == 256);
  uint32_t model[256] = {0};
  load(s, h, 0, model, 128);
  load(s, h, 128, model + 128, 128);

  for (uint32_t i = 0; i < 128; i++)
    model[i] = UINT32_C(0x9e3779b9) * (i + 1) ^ UINT32_MAX;
  store(s, h, 0, model, 128);
  model[128] = 0;
  model[255] = UINT32_MAX;
  store(s, h, 128, model + 128, 128);
  load(s, h, 0, model, 128);
  load(s, h, 128, model + 128, 128);
  store(s, h, 256, NULL, 0);
  load(s, h, 256, NULL, 0);

  const uint32_t bad_loads[][3] = {
      {0, 0, 1}, {UINT32_MAX, 0, 1}, {h, UINT32_MAX, 1},
      {h, 256, 1}, {h, 257, 0}, {h, 0, 129}, {h, 0, UINT32_MAX}};
  const uint32_t statuses[] = {2, 2, 3, 3, 3, 3, 3};
  for (uint32_t i = 0; i < sizeof(statuses) / sizeof(statuses[0]); i++) {
    send(s, A0_ARENA_LOAD, bad_loads[i], 3);
    expect(s, statuses[i], NULL, 0);
    CHECK(!a0_arena_protocol_failed(s));
  }
  const uint32_t invalid_store[] = {h, 255, 2, 17, 18};
  send(s, A0_ARENA_STORE, invalid_store, 5);
  expect(s, A0_ARENA_RANGE, NULL, 0);
  load(s, h, 254, model + 254, 2);
  const uint32_t invalid_handle_store[] = {0, 0, 1, 42};
  send(s, A0_ARENA_STORE, invalid_handle_store, 4);
  expect(s, A0_ARENA_HANDLE, NULL, 0);

  uint32_t size = 0;
  send(s, A0_ARENA_ALLOC, &size, 1);
  expect(s, A0_ARENA_RANGE, NULL, 0);
  size = 2;
  send(s, A0_ARENA_ALLOC, &size, 1);
  expect(s, A0_ARENA_ALLOCATION, NULL, 0);
  size = UINT32_MAX;
  send(s, A0_ARENA_ALLOC, &size, 1);
  expect(s, A0_ARENA_ALLOCATION, NULL, 0);
  const uint32_t tail = allocate(s, 1);
  CHECK(tail != h);
  CHECK(a0_arena_allocation_count(s) == 2);
  CHECK(a0_arena_allocated_words(s) == 257);
  size = 1;
  send(s, A0_ARENA_ALLOC, &size, 1);
  expect(s, A0_ARENA_ALLOCATION, NULL, 0);
  load(s, h, 0, model, 128);
  a0_arena_destroy(s);
}

static uint32_t random_word(uint32_t *state) {
  uint32_t x = *state;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  *state = x;
  return x;
}

static void test_over_65536_words(void) {
  a0_arena_session *s = a0_arena_create(70008, 128);
  CHECK(s != NULL);
  hello(s);
  const uint32_t large = allocate(s, 70000);
  const uint32_t small = allocate(s, 8);
  CHECK(a0_arena_allocated_words(s) == 70008);
  uint32_t values[128];
  for (uint32_t i = 0; i < 128; i++)
    values[i] = (i << 24) ^ UINT32_C(0xa5c39e17);
  store(s, large, 65472, values, 128); /* Spans the 65536-word boundary. */
  load(s, large, 65472, values, 128);
  const uint32_t zero = 0;
  load(s, large, 69999, &zero, 1);
  store(s, small, 0, values, 8);
  load(s, small, 0, values, 8);
  const uint32_t tail = UINT32_MAX;
  store(s, large, 69999, &tail, 1);
  load(s, large, 69999, &tail, 1);
  const uint32_t oversized_span[] = {large, UINT32_MAX - 63, 128};
  send(s, A0_ARENA_LOAD, oversized_span, 3);
  expect(s, A0_ARENA_RANGE, NULL, 0);
  const uint32_t size = 1;
  send(s, A0_ARENA_ALLOC, &size, 1);
  expect(s, A0_ARENA_ALLOCATION, NULL, 0);
  emit(s, values, 128, A0_ARENA_OK);
  CHECK(memcmp(a0_arena_output(s), values, sizeof(values)) == 0);
  CHECK(!a0_arena_protocol_failed(s));
  a0_arena_destroy(s);
}

/* The oracle is a plain independently maintained collection of arrays. Every
 * successful write is observed through loads, including cross-page requests. */
static void test_many_handles_and_model(void) {
  a0_arena_session *s = a0_arena_create(32 * 257, 0);
  CHECK(s != NULL);
  hello(s);
  uint32_t handles[32];
  uint32_t model[32][257] = {{0}};
  for (uint32_t i = 0; i < 32; i++) {
    handles[i] = allocate(s, 257);
    for (uint32_t j = 0; j < i; j++) CHECK(handles[i] != handles[j]);
  }
  CHECK(a0_arena_allocated_words(s) == 32 * 257);
  uint32_t random = UINT32_C(0xc001d00d);
  for (uint32_t trip = 0; trip < 2000; trip++) {
    const uint32_t which = random_word(&random) % 32;
    const uint32_t count = random_word(&random) % 129;
    const uint32_t offset = random_word(&random) % (258 - count);
    uint32_t values[128];
    for (uint32_t i = 0; i < count; i++) values[i] = random_word(&random);
    store(s, handles[which], offset, values, count);
    for (uint32_t i = 0; i < count; i++) model[which][offset + i] = values[i];
    const uint32_t read_count = random_word(&random) % 129;
    const uint32_t read_offset = random_word(&random) % (258 - read_count);
    load(s, handles[which], read_offset, model[which] + read_offset, read_count);
  }
  for (uint32_t i = 0; i < 32; i++) {
    load(s, handles[i], 0, model[i], 128);
    load(s, handles[i], 128, model[i] + 128, 128);
    load(s, handles[i], 256, model[i] + 256, 1);
  }
  CHECK(!a0_arena_protocol_failed(s));
  a0_arena_destroy(s);
}

static void test_output_and_finish(void) {
  a0_arena_session *s = a0_arena_create(8, 257);
  CHECK(s != NULL);
  hello(s);
  (void)allocate(s, 8);
  uint32_t values[128];
  for (uint32_t i = 0; i < 128; i++) values[i] = UINT32_MAX - i;
  emit(s, NULL, 0, A0_ARENA_OK);
  emit(s, values, 128, A0_ARENA_OK);
  emit(s, values, 128, A0_ARENA_OK);
  CHECK(a0_arena_output_count(s) == 256);
  CHECK(memcmp(a0_arena_output(s), values, sizeof(values)) == 0);
  CHECK(memcmp(a0_arena_output(s) + 128, values, sizeof(values)) == 0);
  emit(s, values, 2, A0_ARENA_ALLOCATION);
  CHECK(a0_arena_output_count(s) == 256);
  emit(s, values, 1, A0_ARENA_OK);
  CHECK(a0_arena_output_count(s) == 257);
  CHECK(a0_arena_output(s)[256] == UINT32_MAX);
  emit(s, values, 1, A0_ARENA_ALLOCATION);

  uint32_t code = UINT32_MAX;
  send(s, A0_ARENA_FINISH, &code, 1);
  CHECK(!a0_arena_is_complete(s)); /* FINISH reply has not been consumed. */
  expect(s, A0_ARENA_OK, NULL, 0);
  CHECK(a0_arena_is_finished(s));
  CHECK(a0_arena_is_complete(s));
  CHECK(a0_arena_finish_code(s) == UINT32_MAX);
  CHECK(a0_arena_allocated_words(s) == 0);
  CHECK(a0_arena_allocation_count(s) == 0);
  CHECK(a0_arena_output_count(s) == 257);
  code = 0;
  send(s, A0_ARENA_FINISH, &code, 1);
  expect(s, A0_ARENA_FINISHED, NULL, 0);
  send(s, A0_ARENA_ALLOC, &code, 1);
  expect(s, A0_ARENA_FINISHED, NULL, 0);
  const uint32_t post_finish_load[] = {1, 0, 1};
  send(s, A0_ARENA_LOAD, post_finish_load, 3);
  expect(s, A0_ARENA_FINISHED, NULL, 0);
  emit(s, values, 1, A0_ARENA_FINISHED);
  CHECK(a0_arena_finish_code(s) == UINT32_MAX);
  CHECK(a0_arena_output_count(s) == 257);
  CHECK(!a0_arena_protocol_failed(s));
  CHECK(a0_arena_is_complete(s));
  a0_runtime_write(s, A0_ARENA_LOAD);
  CHECK(!a0_arena_is_complete(s)); /* Trailing partial frame after FINISH. */
  a0_arena_reset(s);
  hello(s);
  CHECK(a0_arena_finish_code(s) == 0);
  CHECK(a0_arena_output(s) == NULL);
  a0_arena_destroy(s);
}

static void test_protocol_errors(void) {
  a0_arena_session *s = a0_arena_create(256, 256);
  CHECK(s != NULL);
  hello(s);
  const uint32_t malformed_headers[][2] = {
      {0, 0}, {UINT32_MAX, 1}, {1, 0}, {1, 2}, {2, 2}, {2, 4},
      {3, 2}, {3, 132}, {4, 0}, {4, 130}, {5, 0}, {5, 2}, {3, UINT32_MAX}};
  for (uint32_t i = 0;
       i < sizeof(malformed_headers) / sizeof(malformed_headers[0]); i++) {
    a0_runtime_write(s, malformed_headers[i][0]);
    a0_runtime_write(s, malformed_headers[i][1]);
    expect(s, A0_ARENA_PROTOCOL, NULL, 0);
    CHECK(a0_arena_protocol_failed(s));
    const uint32_t suppressed_emit[] = {1, 123};
    send(s, A0_ARENA_EMIT, suppressed_emit, 2);
    CHECK(a0_arena_output_count(s) == 0);
    expect(s, A0_ARENA_PROTOCOL, NULL, 0);
    a0_arena_reset(s);
    hello(s);
  }

  const uint32_t bad_payloads[][6] = {
      {3, 3, 1, 0, 1, 0},      /* count 1 but no data word */
      {3, 4, 1, 0, 0, 999},    /* count 0 but a data word */
      {3, 4, 1, 0, UINT32_MAX, 9},
      {4, 1, 1, 0, 0, 0},      /* count 1 but no data word */
      {4, 2, 0, 999, 0, 0},    /* count 0 but a data word */
      {4, 2, UINT32_MAX, 9, 0, 0}};
  for (uint32_t i = 0;
       i < sizeof(bad_payloads) / sizeof(bad_payloads[0]); i++) {
    (void)allocate(s, 4);
    const uint32_t *frame = bad_payloads[i];
    send(s, frame[0], frame + 2, frame[1]);
    expect(s, A0_ARENA_PROTOCOL, NULL, 0);
    CHECK(a0_arena_protocol_failed(s));
    CHECK(a0_arena_allocated_words(s) == 4);
    CHECK(a0_arena_output_count(s) == 0);
    a0_arena_reset(s);
    hello(s);
  }

  /* Read with no response is an explicit error frame, and remains detectable. */
  expect(s, A0_ARENA_PROTOCOL, NULL, 0);
  CHECK(a0_arena_protocol_failed(s));
  expect(s, A0_ARENA_PROTOCOL, NULL, 0);
  a0_arena_reset(s);
  hello(s);

  /* Both truncated header and truncated payload fail on the attempted read. */
  a0_runtime_write(s, A0_ARENA_ALLOC);
  expect(s, A0_ARENA_PROTOCOL, NULL, 0);
  a0_arena_reset(s);
  hello(s);
  a0_runtime_write(s, A0_ARENA_STORE);
  a0_runtime_write(s, 4);
  a0_runtime_write(s, 1);
  a0_runtime_write(s, 0);
  a0_runtime_write(s, 1);
  expect(s, A0_ARENA_PROTOCOL, NULL, 0);
  CHECK(a0_arena_output_count(s) == 0);
  a0_arena_reset(s);
  hello(s);
  a0_arena_destroy(s);
}

static void test_unread_responses(void) {
  a0_arena_session *s = a0_arena_create(128, 1);
  CHECK(s != NULL);
  /* The initial hello is retained before the appended error frame. */
  a0_runtime_write(s, A0_ARENA_ALLOC);
  const uint32_t greeting[] = {A0_ARENA_MAGIC, A0_ARENA_VERSION};
  expect(s, A0_ARENA_OK, greeting, 2);
  expect(s, A0_ARENA_PROTOCOL, NULL, 0);
  CHECK(a0_arena_protocol_failed(s));
  CHECK(a0_arena_allocation_count(s) == 0);
  a0_arena_reset(s);
  hello(s);

  const uint32_t h = allocate(s, 128);
  uint32_t values[128];
  for (uint32_t i = 0; i < 128; i++) values[i] = i * UINT32_C(0x9e3779b9);
  store(s, h, 0, values, 128);
  const uint32_t args[] = {h, 0, 128};
  send(s, A0_ARENA_LOAD, args, 3);
  a0_runtime_write(s, A0_ARENA_EMIT);
  expect(s, A0_ARENA_OK, values, 128);
  expect(s, A0_ARENA_PROTOCOL, NULL, 0);
  CHECK(a0_arena_output_count(s) == 0);
  a0_arena_reset(s);
  hello(s);

  /* A partially consumed response keeps exactly its unread tail. */
  const uint32_t h2 = allocate(s, 1);
  const uint32_t one = UINT32_MAX;
  store(s, h2, 0, &one, 1);
  const uint32_t args2[] = {h2, 0, 1};
  send(s, A0_ARENA_LOAD, args2, 3);
  CHECK(a0_runtime_read(s) == 0);
  a0_runtime_write(s, A0_ARENA_FINISH);
  CHECK(a0_runtime_read(s) == 1);
  CHECK(a0_runtime_read(s) == UINT32_MAX);
  expect(s, A0_ARENA_PROTOCOL, NULL, 0);
  CHECK(!a0_arena_is_finished(s));
  a0_arena_destroy(s);
}

static void test_reset_and_isolation(void) {
  a0_arena_session *a = a0_arena_create(4, 4);
  a0_arena_session *b = a0_arena_create(4, 4);
  CHECK(a != NULL && b != NULL);
  hello(a);
  hello(b);
  const uint32_t ha = allocate(a, 4), hb = allocate(b, 4);
  const uint32_t av[] = {0, 1, UINT32_MAX, 13};
  const uint32_t bv[] = {99, 0, 12, UINT32_MAX};
  store(a, ha, 0, av, 4);
  store(b, hb, 0, bv, 4);
  emit(a, av, 4, A0_ARENA_OK);
  emit(b, bv, 4, A0_ARENA_OK);
  load(a, ha, 0, av, 4);
  load(b, hb, 0, bv, 4);
  a0_arena_reset(a);
  hello(a);
  CHECK(a0_arena_output_count(b) == 4);
  CHECK(memcmp(a0_arena_output(b), bv, sizeof(bv)) == 0);
  load(b, hb, 0, bv, 4);

  /* Reset discards partially received headers/payloads and pending replies. */
  for (uint32_t phase = 0; phase < 5; phase++) {
    const uint32_t prefix[] = {A0_ARENA_STORE, 4, 1, 0, 1};
    for (uint32_t i = 0; i < phase; i++) a0_runtime_write(a, prefix[i]);
    a0_arena_reset(a);
    hello(a);
    const uint32_t h = allocate(a, 4);
    const uint32_t zeros[4] = {0};
    load(a, h, 0, zeros, 4);
    a0_arena_reset(a);
    hello(a);
  }
  uint32_t size = 1;
  send(a, A0_ARENA_ALLOC, &size, 1);
  a0_arena_reset(a);
  hello(a);
  a0_arena_destroy(a);
  a0_arena_destroy(b);

  a0_arena_session *zero = a0_arena_create(0, 0);
  CHECK(zero != NULL);
  hello(zero);
  send(zero, A0_ARENA_ALLOC, &size, 1);
  expect(zero, A0_ARENA_ALLOCATION, NULL, 0);
  emit(zero, NULL, 0, A0_ARENA_OK);
  emit(zero, &size, 1, A0_ARENA_ALLOCATION);
  a0_arena_destroy(zero);
  a0_arena_destroy(NULL);
}

int main(void) {
  test_storage();
  test_over_65536_words();
  test_many_handles_and_model();
  test_output_and_finish();
  test_protocol_errors();
  test_unread_responses();
  test_reset_and_isolation();
  printf("arena runtime: %" PRIu32 " checks passed\n", checks);
  return 0;
}
