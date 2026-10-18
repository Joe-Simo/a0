/* Internal stage: raw file bytes, generic arena transport, and atomic output.
 * Source grammar, verification, scheduling, C emission and FINISH live in A0.
 * The same shim includes verbatim legacy-seed or arena-generated module.c. */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <wchar.h>
#include <windows.h>
typedef wchar_t stage_path;
#else
#include <unistd.h>
typedef char stage_path;
#endif
#include "arena_runtime.h"

/* a0_io is an opaque pointer under the existing host-IO hooks. Neither the
 * generated buffered layout nor generated aggregate names are part of this ABI. */
#define A0_COMPILER_READ(t) a0_runtime_read((a0_arena_session *)(t))
#define A0_COMPILER_WRITE(t, v) a0_runtime_write((a0_arena_session *)(t), (v))
#define A0_IO_READ(t, out) (*(out) = A0_COMPILER_READ(t), true)
#define A0_IO_WRITE(t, v) A0_COMPILER_WRITE(t, v)
#include "module.c"

static a0_arena_session *session;
static a0_io *returned;
static uint32_t handle, length, options[5];

static bool number(const stage_path *text, uint32_t *out) {
  stage_path *end;
  if (!*text || *text < '0' || *text > '9') return false;
  errno = 0;
#ifdef _WIN32
  uintmax_t n = wcstoumax(text, &end, 10);
#else
  uintmax_t n = strtoumax(text, &end, 10);
#endif
  if (errno || *end || n > UINT32_MAX) return false;
  *out = (uint32_t)n;
  return true;
}

static void cstage_send(uint32_t op, uint32_t count, const uint32_t *words) {
  a0_runtime_write(session, op);
  a0_runtime_write(session, count);
  for (uint32_t i = 0; i < count; i++) a0_runtime_write(session, words[i]);
}

static uint32_t reply(uint32_t count) {
  uint32_t status = a0_runtime_read(session);
  uint32_t n = a0_runtime_read(session);
  if (status) return status;
  return n == count ? 0 : A0_ARENA_PROTOCOL;
}

static uint32_t upload(const unsigned char *bytes) {
  uint32_t n = length ? length : 1;
  cstage_send(A0_ARENA_ALLOC, 1, &n);
  uint32_t code = reply(1);
  if (code) return code;
  handle = a0_runtime_read(session);
  for (uint32_t i = 0; i < length;) {
    n = length - i > A0_ARENA_BULK_MAX ? A0_ARENA_BULK_MAX : length - i;
    uint32_t words[3 + A0_ARENA_BULK_MAX] = {handle, i, n};
    for (uint32_t j = 0; j < n; j++) words[3 + j] = bytes[i + j];
    cstage_send(A0_ARENA_STORE, n + 3, words);
    code = reply(0);
    if (code) return code;
    i += n;
  }
  return 0;
}

static void *run(void *unused) {
  (void)unused;
  returned = a0_arena_c_stage((a0_io *)session, handle, length,
    options[0], options[1], options[2], options[3], options[4]);
  return NULL;
}

static bool publish(const stage_path *path) {
  const uint32_t *words = a0_arena_output(session);
  uint32_t n = a0_arena_output_count(session);
  for (uint32_t i = 0; i < n; i++) if (words[i] > 255) return false;
#ifdef _WIN32
  size_t size = wcslen(path), extra = 64;
  if (size > SIZE_MAX / sizeof(stage_path) - extra) return false;
  stage_path *temporary = malloc((size + extra) * sizeof(stage_path));
  if (!temporary) return false;
  memcpy(temporary, path, size * sizeof(stage_path));
  HANDLE file = INVALID_HANDLE_VALUE;
  /* CREATE_NEW never opens an existing file or follows its replacement. Names
   * remain beside the destination; MoveFileEx cannot copy across volumes. */
  for (uint32_t attempt = 0;; attempt++) {
    if (swprintf(temporary + size, extra, L".tmp.%lu.%lu", (unsigned long)GetCurrentProcessId(),
        (unsigned long)attempt) < 0) break;
    file = CreateFileW(temporary, GENERIC_WRITE, 0, NULL, CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL, NULL);
    if (file != INVALID_HANDLE_VALUE || GetLastError() != ERROR_FILE_EXISTS ||
        attempt == UINT32_MAX) break;
  }
  if (file == INVALID_HANDLE_VALUE) { free(temporary); return false; }
  int fd = _open_osfhandle((intptr_t)file, _O_WRONLY | _O_BINARY);
  if (fd < 0) { CloseHandle(file); DeleteFileW(temporary); free(temporary); return false; }
  FILE *output = _fdopen(fd, "wb");
#else
  size_t size = strlen(path);
  if (size > SIZE_MAX - 12) return false;
  stage_path *temporary = malloc(size + 12);
  if (!temporary) return false;
  memcpy(temporary, path, size);
  memcpy(temporary + size, ".tmp.XXXXXX", 12);
  int fd = mkstemp(temporary);
  if (fd < 0) { free(temporary); return false; }
  FILE *output = fdopen(fd, "wb");
#endif
  bool okay = output != NULL;
  if (output) {
    unsigned char bytes[4096];
    for (uint32_t i = 0; okay && i < n;) {
      uint32_t count = n - i > sizeof bytes ? sizeof bytes : n - i;
      for (uint32_t j = 0; j < count; j++) bytes[j] = (unsigned char)words[i + j];
      okay = fwrite(bytes, 1, count, output) == count;
      i += count;
    }
    if (fflush(output)) okay = false;
#ifdef _WIN32
    if (_commit(fd)) okay = false;
#else
    if (fsync(fd)) okay = false;
#endif
    if (fclose(output)) okay = false;
  } else {
#ifdef _WIN32
    _close(fd);
#else
    close(fd);
#endif
  }
#ifdef _WIN32
  if (okay && !MoveFileExW(temporary, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    okay = false;
  if (!okay) DeleteFileW(temporary);
#else
  if (okay && rename(temporary, path)) okay = false;
  if (!okay) unlink(temporary);
#endif
  free(temporary);
  return okay;
}

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
#else
int main(int argc, char **argv) {
#endif
  /* Every resource is caller-selected: arena/output words, quantum, resume
   * calls, generated buffered input/output capacities, flags and stack bytes. */
  uint32_t max_words, max_output, stack_bytes;
  if (argc != 11 || !number(argv[3], &max_words) || !number(argv[4], &max_output) ||
      !number(argv[5], &options[3]) || !number(argv[6], &options[4]) ||
      !number(argv[7], &options[0]) || !number(argv[8], &options[1]) ||
      !number(argv[9], &options[2]) || !number(argv[10], &stack_bytes)) {
    fputs("usage: stage source output arenaWords outputWords quantum resumes inputCapacity outputCapacity flags stackBytes\n", stderr);
    return 64;
  }
#ifdef _WIN32
  FILE *input = _wfopen(argv[1], L"rb");
#else
  FILE *input = fopen(argv[1], "rb");
#endif
  if (!input) return 64;
  unsigned char *bytes = NULL;
  size_t count = 0, capacity = 0;
  int ch;
  while ((ch = fgetc(input)) != EOF) {
    if (count == UINT32_MAX) { free(bytes); fclose(input); return 64; }
    if (count == capacity) {
      size_t next = capacity ? capacity * 2 : 4096;
      if (next < capacity || next > UINT32_MAX) next = UINT32_MAX;
      unsigned char *grown = realloc(bytes, next);
      if (!grown) { free(bytes); fclose(input); return 4; }
      bytes = grown; capacity = next;
    }
    bytes[count++] = (unsigned char)ch;
  }
  bool read_okay = !ferror(input);
  if (fclose(input)) read_okay = false;
  if (!read_okay) { free(bytes); return 64; }
  length = (uint32_t)count;
  session = a0_arena_create(max_words, max_output);
  if (!session) { free(bytes); return 4; }
  uint32_t code = reply(2);
  if (!code && (a0_runtime_read(session) != A0_ARENA_MAGIC ||
                a0_runtime_read(session) != A0_ARENA_VERSION)) code = 1;
  if (!code) code = upload(bytes);
  free(bytes);
  if (code) { a0_arena_destroy(session); return code <= 63 ? (int)code : 65; }
  pthread_attr_t attr;
  pthread_t thread;
  if (pthread_attr_init(&attr)) { a0_arena_destroy(session); return 66; }
  int err = pthread_attr_setstacksize(&attr, stack_bytes);
  if (!err) err = pthread_create(&thread, &attr, run, NULL);
  pthread_attr_destroy(&attr);
  if (err) { a0_arena_destroy(session); return 66; }
  /* A failed join does not prove the worker stopped using the session. Process
   * exit owns cleanup on that path; no output is published. */
  if (pthread_join(thread, NULL)) return 66;
  bool complete = returned == (a0_io *)session && a0_arena_is_complete(session) &&
    a0_arena_allocated_words(session) == 0 && a0_arena_allocation_count(session) == 0;
  code = complete ? a0_arena_finish_code(session) : 65;
  if (!code && !publish(argv[2])) code = 69;
  a0_arena_destroy(session);
  return (int)code;
}
