/* Structured IR transport controls. The production encoder supplies complete schema1
 * tables. Native A0 owns symbols, ordered verification and diagnostic rendering.
 * Including the unchanged runtime permits immutable-allocation snapshots and explicit
 * storage-error injection; no checker or diagnostic catalog lives in this driver. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "arena_runtime.c"

static a0_arena_session *session;
static uint32_t injected;
static uint32_t read_reply(void) {
  if (injected && session->response_position == 0 && session->response_count >= 2) {
    session->response[0] = injected;
    session->response[1] = 0;
    session->response_count = 2;
    injected = 0;
  }
  return a0_runtime_read(session);
}
#define A0_COMPILER_READ(t) ((void)(t), read_reply())
#define A0_COMPILER_WRITE(t, v) ((void)(t), a0_runtime_write(session, (v)))
#include "module.c"
#include "api.h"

static void die(const char *s) { fprintf(stderr, "%s\n", s); exit(1); }
static uint32_t word(FILE *f) {
  unsigned char b[4];
  if (fread(b, 1, 4, f) != 4) die("truncated packet");
  return (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
}
static void out(FILE *f, uint32_t v) {
  unsigned char b[4] = {(unsigned char)v, (unsigned char)(v >> 8),
    (unsigned char)(v >> 16), (unsigned char)(v >> 24)};
  if (fwrite(b, 1, 4, f) != 4) die("write output");
}
static void want(uint32_t v) { if (a0_runtime_read(session) != v) die("storage reply"); }
static void send(uint32_t op, uint32_t n, const uint32_t *a) {
  a0_runtime_write(session, op); a0_runtime_write(session, n);
  for (uint32_t i = 0; i < n; i++) a0_runtime_write(session, a[i]);
}
static uint32_t upload(const uint32_t *data, uint32_t length) {
  if (!length) return 0;
  send(1, 1, &length); want(0); want(1);
  uint32_t handle = a0_runtime_read(session);
  for (uint32_t i = 0; i < length;) {
    uint32_t count = length - i > 128 ? 128 : length - i, args[131] = {handle, i, count};
    memcpy(args + 3, data + i, count * sizeof(uint32_t));
    send(3, count + 3, args); want(0); want(0); i += count;
  }
  return handle;
}
static allocation *snapshot(uint32_t *count) {
  *count = session->allocation_count;
  allocation *copy = calloc(*count ? *count : 1, sizeof *copy);
  if (!copy) die("snapshot directory");
  for (uint32_t i = 0; i < *count; i++) {
    copy[i].length = session->allocations[i].length;
    copy[i].words = malloc((size_t)copy[i].length * sizeof(uint32_t));
    if (!copy[i].words) die("snapshot allocation");
    memcpy(copy[i].words, session->allocations[i].words, (size_t)copy[i].length * sizeof(uint32_t));
  }
  return copy;
}
static void unchanged(allocation *copy, uint32_t count) {
  if (session->allocation_count < count) die("old allocation removed");
  for (uint32_t i = 0; i < count; i++) {
    if (copy[i].length != session->allocations[i].length ||
      memcmp(copy[i].words, session->allocations[i].words, (size_t)copy[i].length * sizeof(uint32_t)))
      die("preexisting allocation changed");
    free(copy[i].words);
  }
  free(copy);
}

static int structured_main(int argc, char **argv) {
  if (argc != 4) die("archive packet output");
  FILE *archive = fopen(argv[1], "rb"), *packet = fopen(argv[2], "rb"), *output = fopen(argv[3], "wb");
  if (!archive || !packet || !output) die("open fixture");
  if (fseek(archive, 0, SEEK_END)) die("seek archive");
  long size = ftell(archive);
  if (size < 0 || (uint64_t)size > UINT32_MAX) die("archive size");
  rewind(archive);
  uint32_t length = (uint32_t)size;
  uint32_t *source = calloc((size_t)length + 1, sizeof(uint32_t));
  if (!source) die("archive allocation");
  for (uint32_t i = 0; i < length; i++) {
    int byte = fgetc(archive); if (byte == EOF) die("read archive"); source[i] = (uint32_t)byte;
  }
  if (fclose(archive)) die("close archive");
  if (word(packet) != 0x41444952u) die("packet magic");
  uint32_t allocated_empty = word(packet);
  session = a0_arena_create(UINT32_MAX, 0);
  if (!session) die("session");
  want(0); want(2); want(A0_ARENA_MAGIC); want(A0_ARENA_VERSION);
  uint32_t handle = upload(source, length ? length : allocated_empty);
  a0_io io, before;
  memset(&io, 0xa5, sizeof io); memcpy(&before, &io, sizeof io);
  IR_STATE state = a0_source_ir_init(&io, handle, length, 0);
  if (state.f0.e[0] || state.f1 != &io) die("IR initialization");
  uint32_t names = word(packet);
  for (uint32_t i = 0; i < names; i++) {
    uint32_t n = word(packet), *bytes = calloc((size_t)n + 1, sizeof(uint32_t));
    if (!bytes) die("symbol allocation");
    for (uint32_t j = 0; j < n; j++) bytes[j] = word(packet);
    uint32_t name = upload(bytes, n);
    IR_SYMBOL symbol = a0_source_ir_symbol(state, name, n);
    if (symbol.f0.e[0] || symbol.f1 != i || symbol.f2 != &io) die("native symbol identity");
    state.f0 = symbol.f0; state.f1 = symbol.f2; free(bytes);
  }
  uint32_t uploads = word(packet), *handles = calloc((size_t)uploads + 1, sizeof(uint32_t));
  if (!handles) die("handle mapping");
  for (uint32_t i = 1; i <= uploads; i++) {
    uint32_t n = word(packet), *words = calloc((size_t)n + 1, sizeof(uint32_t));
    if (!words) die("table allocation");
    for (uint32_t j = 0; j < n; j++) words[j] = word(packet);
    if (i == uploads) {
      if (n != 128 || words[92] != 1) die("spec directory schema");
      words[6] = handle;
      for (uint32_t j = 0; j < 6; j++) words[80 + j] = state.f0.e[62 + j];
    }
    handles[i] = upload(words, n); free(words);
  }
  uint32_t fields = word(packet);
  for (uint32_t i = 0; i < fields; i++) {
    uint32_t slot = word(packet), value = word(packet);
    if (slot >= 128) die("state field range");
    if (slot == 32 || slot == 35 || slot == 38 || slot == 41 || slot == 44 ||
      slot == 47 || slot == 50 || slot == 53 || slot == 56 || slot == 59) {
      if (value > uploads) die("logical handle range"); value = handles[value];
    }
    state.f0.e[slot] = value;
  }
  free(handles);
  uint32_t count; allocation *copy = snapshot(&count);
  IR_STATE original = state;
  VERIFIED checked = a0_arena_verify_begin(&io, state.f0);
  uint32_t rounds = 0;
  while (!checked.f0.e[0] && checked.f0.e[1] != 11) {
    checked = a0_arena_verify_resume(checked, 97);
    if (++rounds > 100000) die("verification watchdog");
  }
  if (checked.f6 != &io || memcmp(&state, &original, sizeof state) || memcmp(&io, &before, sizeof io))
    die("verification input/capability changed");
  unchanged(copy, count);
  out(output, checked.f0.e[0]);
  for (uint32_t i = 0; i < 128; i++) out(output, checked.f1.e[i]);
  uint32_t requests = word(packet); out(output, requests);
  for (uint32_t i = 0; i < requests; i++) {
    uint32_t options = word(packet), fault = word(packet), budget = word(packet);
    IR_STATE current = {checked.f1, &io};
    if (fault == 1 || fault == 21 || fault == 25) current.f0.e[109] = UINT32_MAX;
    if (fault == 2) current.f0.e[109] = current.f0.e[42] / 14;
    /* Explicit transport control, separate from unchanged checker facts: a global
     * diagnostic can retain a physical Unicode span without gaining an owner. */
    if (fault == 3) {
      if (length < 6) die("Unicode span fixture");
      current.f0.e[2] = 1; current.f0.e[3] = 2; current.f0.e[4] = 4;
    }
    IR_STATE saved = current;
    uint32_t max = session->max_words;
    uint64_t cap = (uint64_t)session->allocated_words + budget;
    if (budget != UINT32_MAX) session->max_words = cap > UINT32_MAX ? UINT32_MAX : (uint32_t)cap;
    copy = snapshot(&count);
    if (fault >= 11 && fault <= 15) injected = fault - 10;
    if (fault == 21 || fault == 25) injected = fault - 20;
    DIAG_RESULT result = a0_arena_diagnostic_options(&io, current.f0, options);
    if (injected) die("storage error injection not reached");
    injected = 0;
    if (result.f3 != &io || memcmp(&io, &before, sizeof io) || memcmp(&current, &saved, sizeof current))
      die("diagnostic input/capability changed");
    unchanged(copy, count); session->max_words = max;
    if (a0_arena_protocol_failed(session)) die("protocol failure");
    if (result.f0 && (result.f1.f0 || result.f1.f1 || result.f1.f2)) die("partial refusal view");
    out(output, result.f0);
    for (uint32_t j = 0; j < 128; j++) out(output, result.f2.e[j]);
    out(output, result.f1.f1);
    if (result.f1.f1) {
      if (!result.f1.f0 || result.f1.f0 > session->allocation_count ||
        result.f1.f1 > session->allocations[result.f1.f0 - 1].length) die("output range");
      const uint32_t *json = session->allocations[result.f1.f0 - 1].words;
      for (uint32_t j = 0; j < result.f1.f1; j++) {
        if (json[j] > 255) die("output byte"); out(output, json[j]);
      }
    }
  }
  if (fgetc(packet) != EOF || fclose(packet) || fclose(output)) die("complete packet/output");
  if (length && memcmp(source, session->allocations[handle - 1].words, (size_t)length * sizeof(uint32_t)))
    die("source archive changed");
  free(source);
  uint32_t finish = 0; send(5, 1, &finish); want(0); want(0);
  if (!a0_arena_is_complete(session) || a0_arena_allocated_words(session) ||
    a0_arena_finish_code(session)) die("incomplete FINISH");
  a0_arena_destroy(session); return 0;
}
