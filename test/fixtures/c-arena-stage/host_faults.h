/* Test-only OS failure wrappers. Production has no fault environment flag. */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <io.h>
#include <windows.h>
#else
#include <unistd.h>
#endif
#include "arena_runtime.h"

static bool worker_created, worker_joined;
static bool output_flushed, output_committed, output_closed;
static bool host_fault(const char *name) {
  const char *fault = getenv("A0_STAGE_HOST_FAULT");
  return fault && strcmp(fault, name) == 0;
}
static int host_create(pthread_t *thread, const pthread_attr_t *attr,
    void *(*start)(void *), void *argument) {
  if (host_fault("create")) return EAGAIN;
  int code = pthread_create(thread, attr, start, argument);
  worker_created = code == 0;
  return code;
}
static int host_join(pthread_t thread, void **result) {
  if (host_fault("join")) return EINVAL;
  int code = pthread_join(thread, result);
  worker_joined = code == 0;
  return code;
}
static void host_destroy(a0_arena_session *session) {
  /* Freeing after create but before successful join is a lifetime violation. */
  if (worker_created && !worker_joined) _Exit(88);
  a0_arena_destroy(session);
}
static size_t host_write(const void *bytes, size_t size, size_t count, FILE *output) {
  return fwrite(bytes, size, host_fault("write") && count ? count - 1 : count, output);
}
static int host_flush(FILE *output) {
  int code = fflush(output);
  output_flushed = true;
  return host_fault("flush") ? EOF : code;
}
static int host_close(FILE *output) {
  if (worker_joined && !output_committed) _Exit(89);
  int code = fclose(output);
  if (worker_joined) output_closed = true;
  return host_fault("close") && worker_joined ? EOF : code;
}
#ifdef _WIN32
static int host_commit(int fd) {
  if (!output_flushed) _Exit(89);
  output_committed = true;
  return host_fault("commit") ? -1 : _commit(fd);
}
static HANDLE WINAPI host_temporary(LPCWSTR path, DWORD access, DWORD sharing,
    LPSECURITY_ATTRIBUTES security, DWORD creation, DWORD attributes, HANDLE template_file) {
  if (host_fault("temporary")) { SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE; }
  if (creation != CREATE_NEW || sharing != 0) _Exit(89);
  static bool collided;
  if (host_fault("collision") && !collided) {
    HANDLE file = CreateFileW(path, access, sharing, security, creation, attributes, template_file);
    if (file == INVALID_HANDLE_VALUE) _Exit(89);
    DWORD written;
    if (!WriteFile(file, "keep", 4, &written, NULL) || written != 4 || !CloseHandle(file)) _Exit(89);
    collided = true;
    SetLastError(ERROR_FILE_EXISTS);
    return INVALID_HANDLE_VALUE;
  }
  return CreateFileW(path, access, sharing, security, creation, attributes, template_file);
}
static BOOL WINAPI host_replace(LPCWSTR temporary, LPCWSTR path, DWORD flags) {
  if (!output_closed || flags != (MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) _Exit(89);
  if (host_fault("replace")) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
  if (host_fault("locked")) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) _Exit(89);
    BOOL moved = MoveFileExW(temporary, path, flags);
    CloseHandle(file);
    return moved;
  }
  return MoveFileExW(temporary, path, flags);
}
#define _commit host_commit
#define CreateFileW host_temporary
#define MoveFileExW host_replace
#else
static int host_commit(int fd) {
  if (!output_flushed) _Exit(89);
  output_committed = true;
  return host_fault("commit") ? -1 : fsync(fd);
}
static int host_temporary(char *path) {
  if (host_fault("temporary")) { errno = EACCES; return -1; }
  return mkstemp(path);
}
static int host_replace(const char *temporary, const char *path) {
  if (!output_closed) _Exit(89);
  if (host_fault("replace")) { errno = EACCES; return -1; }
  return rename(temporary, path);
}
#define fsync host_commit
#define mkstemp host_temporary
#define rename host_replace
#endif
#define pthread_create host_create
#define pthread_join host_join
#define a0_arena_destroy host_destroy
#define fwrite host_write
#define fflush host_flush
#define fclose host_close
