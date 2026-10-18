/* File framing and generic arena storage only. A0 owns compiler decisions. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include "arena_runtime.h"
static FILE *input_file, *output_file;
static a0_arena_session *session;
static uint32_t phase, op, nargs, at, enabled, fault_op, fault_nth, fault_status, fault_kind, seen;
static uint32_t injected[131], injected_at, injected_count;
static uint64_t requests;
static void die(const char *s) { fprintf(stderr, "%s\n", s); exit(2); }
static uint32_t tr_read(void) {
  return injected_at < injected_count ? injected[injected_at++] : a0_runtime_read(session);
}
static void tr_write(uint32_t v) {
  int done = 0;
  if (!phase) { op = v; phase = 1; }
  else if (phase == 1) { nargs = v; at = 0; phase = v ? 2 : 0; done = !v; }
  else if (++at == nargs) { phase = 0; done = 1; }
  a0_runtime_write(session, v);
  if (done) requests++;
  if (done && enabled && fault_kind && op == fault_op && ++seen == fault_nth) {
    (void)a0_runtime_read(session);
    uint32_t n = a0_runtime_read(session), payload[128];
    if (n > 128) die("fault reply size");
    for (uint32_t i = 0; i < n; i++) payload[i] = a0_runtime_read(session);
    injected_at = 0; injected[0] = fault_kind == 2 ? 0 : fault_status;
    injected[1] = fault_kind == 2 && n ? n - 1 : 0; injected_count = 2 + injected[1];
    for (uint32_t i = 0; i < injected[1]; i++) injected[i + 2] = payload[i];
  }
}
#define A0_COMPILER_READ(t) ((void)(t), tr_read())
#define A0_COMPILER_WRITE(t, v) ((void)(t), tr_write(v))
#include "module.c"
#include "api.h"
static uint32_t word(void) {
  unsigned char b[4];
  if (fread(b, 1, 4, input_file) != 4) die("truncated input");
  return (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
}
static void out(uint32_t v) {
  unsigned char b[4] = {(unsigned char)v, (unsigned char)(v >> 8), (unsigned char)(v >> 16), (unsigned char)(v >> 24)};
  if (fwrite(b, 1, 4, output_file) != 4) die("output");
}
static void want(uint32_t v) { if (tr_read() != v) die("storage reply"); }
static void send(uint32_t opcode, uint32_t n, const uint32_t *a) {
  tr_write(opcode); tr_write(n); for (uint32_t i = 0; i < n; i++) tr_write(a[i]);
}
static uint32_t length, quantum, source, code, result[3], e[128], verify[128], metadata[128], binding[128], counts[3], *source_copy;
static uint32_t input_capacity, output_capacity, flags, pending_checks;
static uint64_t resumes;
static a0_io io, before;
static void pending(C_STATE s) {
  C_RESULT r = a0_arena_c_source_result(s);
  if (a0_arena_c_source_status(s.f0) != 7 || r.f0 != 7 || r.f1.f0 || r.f1.f1 || r.f1.f2 || r.f2 != &io)
    die("pending result");
  if (a0_arena_output_count(session)) die("pending output");
  uint64_t old_requests = requests;
  C_STATUSIO published = a0_arena_c_source_publish(s);
  if (published.f0 != 7 || published.f1 != &io || requests != old_requests || a0_arena_output_count(session))
    die("pending publication");
  pending_checks++;
}
static void *worker(void *unused) {
  (void)unused; memset(&io, 0xa5, sizeof io); memcpy(&before, &io, sizeof io); enabled = 1;
  C_STATE s = a0_arena_c_source_begin(&io, source, length, input_capacity, output_capacity, flags);
  if (!a0_arena_c_source_done(s.f0)) {
    pending(s); s = a0_arena_c_source_resume(s, 0);
    if (a0_arena_c_source_done(s.f0)) die("zero-quantum completed verification");
    pending(s);
  }
  while (!a0_arena_c_source_done(s.f0)) {
    pending(s); s = a0_arena_c_source_resume(s, quantum); resumes++;
  }
  memcpy(e, s.f0.e, sizeof e); memcpy(verify, s.f1.f3.f0.e, sizeof verify);
  memcpy(metadata, s.f1.f3.f1.e, sizeof metadata); memcpy(binding, s.f1.f3.f3.e, sizeof binding);
  for (uint32_t i = 0; i < 3; i++) counts[i] = s.f1.f1.e[11 + i];
  if (s.f1.f3.f6 != &io || s.f2.f0 != input_capacity || s.f2.f1 != output_capacity || s.f2.f2 != flags)
    die("token or options identity");
  C_RESULT r = a0_arena_c_source_result(s);
  if (r.f0 != a0_arena_c_source_status(s.f0) || r.f2 != &io) die("terminal result");
  result[0] = r.f1.f0; result[1] = r.f1.f1; result[2] = r.f1.f2;
  if (r.f0 && (result[0] || result[1] || result[2])) die("failed result vector");
  if (!r.f0 && (verify[0] || verify[1] != 11)) die("emitted before ordered verification completed");
  if (a0_arena_output_count(session)) die("output before explicit publication");
  uint64_t old_requests = requests;
  C_STATE terminal = a0_arena_c_source_resume(s, quantum);
  if (requests != old_requests || memcmp(e, terminal.f0.e, sizeof e) ||
      memcmp(s.f1.f0.e, terminal.f1.f0.e, sizeof s.f1.f0.e) ||
      memcmp(s.f1.f1.e, terminal.f1.f1.e, sizeof s.f1.f1.e) ||
      memcmp(s.f1.f2.e, terminal.f1.f2.e, sizeof s.f1.f2.e) ||
      memcmp(verify, terminal.f1.f3.f0.e, sizeof verify) ||
      memcmp(s.f1.f3.f1.e, terminal.f1.f3.f1.e, sizeof s.f1.f3.f1.e) ||
      memcmp(s.f1.f3.f2.e, terminal.f1.f3.f2.e, sizeof s.f1.f3.f2.e) ||
      memcmp(s.f1.f3.f3.e, terminal.f1.f3.f3.e, sizeof s.f1.f3.f3.e) ||
      memcmp(s.f1.f3.f4.e, terminal.f1.f3.f4.e, sizeof s.f1.f3.f4.e) ||
      memcmp(s.f1.f3.f5.e, terminal.f1.f3.f5.e, sizeof s.f1.f3.f5.e) ||
      terminal.f2.f0 != input_capacity || terminal.f2.f1 != output_capacity || terminal.f2.f2 != flags ||
      terminal.f1.f3.f6 != &io)
    die("terminal resume");
  C_RESULT repeated = a0_arena_c_source_result(terminal);
  if (repeated.f0 != r.f0 || repeated.f1.f0 != r.f1.f0 || repeated.f1.f1 != r.f1.f1 ||
      repeated.f1.f2 != r.f1.f2 || repeated.f2 != &io || requests != old_requests)
    die("terminal result changed");
  C_STATUSIO published = a0_arena_c_source_publish(s); code = published.f0;
  if (published.f1 != &io) die("published token identity");
  enabled = 0; if (memcmp(&io, &before, sizeof io)) die("buffered IO changed");
  return NULL;
}
int main(int argc, char **argv) {
  if (argc != 3) die("input/output files required");
  input_file = fopen(argv[1], "rb"); output_file = fopen(argv[2], "wb");
  if (!input_file || !output_file) die("files");
  if (word() != 0x43535243u) die("packet magic");
  uint32_t max = word(), maxout = word(); quantum = word(); length = word();
  fault_op = word(); fault_nth = word(); fault_status = word(); fault_kind = word();
  input_capacity = word(); output_capacity = word(); flags = word();
  if (!quantum || fault_kind > 2) die("protocol quantum/fault");
  session = a0_arena_create(max, maxout); if (!session) die("session allocation");
  want(0); want(2); want(A0_ARENA_MAGIC); want(1);
  if (length) {
    source_copy = malloc((size_t)length * 4); if (!source_copy) die("host source allocation");
    send(1, 1, &length); want(0); want(1); source = tr_read();
    for (uint32_t i = 0; i < length;) {
      uint32_t n = length - i > 128 ? 128 : length - i, a[131] = {source, i, n};
      for (uint32_t j = 0; j < n; j++) source_copy[i + j] = a[j + 3] = word();
      send(3, n + 3, a); want(0); want(0); i += n;
    }
  }
  if (fgetc(input_file) != EOF) die("trailing input");
  pthread_attr_t attr; pthread_t thread;
  if (pthread_attr_init(&attr) || pthread_attr_setstacksize(&attr, (size_t)1u << 30)) die("thread attributes");
  if (pthread_create(&thread, &attr, worker, NULL)) die("thread start");
  pthread_attr_destroy(&attr); if (pthread_join(thread, NULL)) die("thread join");
  if (a0_arena_protocol_failed(session)) die("protocol failure");
  for (uint32_t i = 0; i < length;) {
    uint32_t n = length - i > 128 ? 128 : length - i, a[3] = {source, i, n};
    send(2, 3, a); want(0); want(n);
    for (uint32_t j = 0; j < n; j++) if (tr_read() != source_copy[i + j]) die("source changed");
    i += n;
  }
  uint32_t count = a0_arena_output_count(session), allocated = a0_arena_allocated_words(session);
  const uint32_t *bytes = a0_arena_output(session);
  for (uint32_t i = 0; i < count; i++) if (bytes[i] > 255) die("nonbyte output");
  send(5, 1, &code); want(0); want(0);
  if (!a0_arena_is_complete(session) || a0_arena_finish_code(session) != code || a0_arena_allocated_words(session))
    die("incomplete FINISH");
  out(0x43535243u); out(code); out((uint32_t)resumes); out((uint32_t)(resumes >> 32)); out(pending_checks);
  for (uint32_t i = 0; i < 128; i++) out(e[i]);
  for (uint32_t i = 0; i < 128; i++) out(verify[i]);
  for (uint32_t i = 0; i < 128; i++) out(metadata[i]);
  for (uint32_t i = 0; i < 128; i++) out(binding[i]);
  for (uint32_t i = 0; i < 3; i++) out(counts[i]);
  for (uint32_t i = 0; i < 3; i++) out(result[i]);
  out(allocated); out(count); for (uint32_t i = 0; i < count; i++) out(bytes[i]);
  free(source_copy); a0_arena_destroy(session);
  if (fclose(input_file) || fclose(output_file)) die("close"); return 0;
}
