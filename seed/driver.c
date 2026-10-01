/*
 * The seed driver: compiles the A0 compiler's own source with a built stage executable, using
 * nothing but a C library. It replays tools/bootstrap.ts `emitChunked` over the chunk plan in
 * seed/plan.txt (written by tools/seed.ts): for each chunk it feeds the stage the chunk source and
 * the iteration bounds of the earlier chunks it calls, and appends the C the stage writes.
 *
 *   a0seed-driver <stage-exe> <seed-dir> <out.c>
 *
 * plan.txt: one line per chunk, `chunk FILE HEAD STRICT BEFORE OWN`; BEFORE and OWN are comma lists
 * of function names or `-`; the name `a0boottypes` (the header prelude) has bound 0.
 * Stage protocol (compiler/boot.a0 `emitchunkio`, tools/bootstrap.ts `stageMain`): stdin is
 * little-endian 4-byte words: n, the n source bytes, head, strict, k, k bounds; stdout is the C
 * bytes, then the trailer: the bounds of the chunk's own functions, then their count, as 4-byte
 * words. Exit status 0 is success.
 */
#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAX_NAMES 4096
#define MAX_NAME 80
#define MAX_PATH 4096
#define MAX_LIST (1 << 16)

static char names[MAX_NAMES][MAX_NAME];
static uint32_t bounds[MAX_NAMES];
static int nnames;

static void die(const char *what, const char *detail) {
  fprintf(stderr, "a0seed-driver: %s%s%s\n", what, detail[0] ? ": " : "", detail);
  exit(1);
}

static unsigned char *slurp(const char *path, size_t *n) {
  FILE *f = fopen(path, "rb");
  if (!f) die("cannot read", path);
  size_t cap = 1 << 16, len = 0;
  unsigned char *b = malloc(cap + 1);
  if (!b) die("out of memory", "");
  size_t got;
  while ((got = fread(b + len, 1, cap - len, f)) > 0) {
    len += got;
    if (len == cap) {
      cap *= 2;
      b = realloc(b, cap + 1);
      if (!b) die("out of memory", "");
    }
  }
  fclose(f);
  b[len] = 0;
  *n = len;
  return b;
}

static int find(const char *name) {
  for (int i = 0; i < nnames; i++)
    if (strcmp(names[i], name) == 0) return i;
  return -1;
}

static void put32(unsigned char *p, uint32_t v) {
  p[0] = (unsigned char)v;
  p[1] = (unsigned char)(v >> 8);
  p[2] = (unsigned char)(v >> 16);
  p[3] = (unsigned char)(v >> 24);
}

static uint32_t get32(const unsigned char *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

/* Split "a,b,c" (or "-") in place into pieces. */
static int split(char *list, char **out, int max) {
  int n = 0;
  if (strcmp(list, "-") == 0) return 0;
  for (char *p = strtok(list, ","); p; p = strtok(NULL, ",")) {
    if (n == max) die("too many names", "");
    out[n++] = p;
  }
  return n;
}

int main(int argc, char **argv) {
  if (argc != 4) die("usage: a0seed-driver <stage-exe> <seed-dir> <out.c>", "");
  const char *exe = argv[1], *dir = argv[2], *outc = argv[3];
  char path[MAX_PATH], inpath[MAX_PATH], outpath[MAX_PATH];
  snprintf(path, sizeof path, "%s/plan.txt", dir);
  snprintf(inpath, sizeof inpath, "%s.in", outc);
  snprintf(outpath, sizeof outpath, "%s.out", outc);
  size_t plan_n;
  unsigned char *plan = slurp(path, &plan_n);
  FILE *result = fopen(outc, "wb");
  if (!result) die("cannot write", outc);
  int chunks = 0;
  static char file[MAX_PATH], before[MAX_LIST], own[MAX_LIST];
  static char *before_names[MAX_NAMES], *own_names[MAX_NAMES];
  char *cur = (char *)plan;
  while (*cur) {
    char *nl = strchr(cur, '\n');
    size_t len = nl ? (size_t)(nl - cur) : strlen(cur);
    static char copy[2 * MAX_LIST + MAX_PATH];
    if (len >= sizeof copy) die("plan line too long", "");
    memcpy(copy, cur, len);
    copy[len] = 0;
    cur += len + (nl ? 1 : 0);
    if (len == 0) continue;
    int head, strict;
    if (sscanf(copy, "chunk %4095s %d %d %65535s %65535s", file, &head, &strict, before, own) != 5)
      die("bad plan line", copy);
    char src_path[MAX_PATH];
    snprintf(src_path, sizeof src_path, "%s/%s", dir, file);
    size_t n;
    unsigned char *src = slurp(src_path, &n);
    int nbefore = split(before, before_names, MAX_NAMES);
    int nown = split(own, own_names, MAX_NAMES);
    size_t words = 1 + n + 3 + (size_t)nbefore;
    unsigned char *in = malloc(words * 4);
    if (!in) die("out of memory", "");
    size_t w = 0;
    put32(in + 4 * w++, (uint32_t)n);
    for (size_t i = 0; i < n; i++) put32(in + 4 * w++, src[i]);
    put32(in + 4 * w++, (uint32_t)head);
    put32(in + 4 * w++, (uint32_t)strict);
    put32(in + 4 * w++, (uint32_t)nbefore);
    for (int i = 0; i < nbefore; i++) {
      uint32_t b = 0;
      if (strcmp(before_names[i], "a0boottypes") != 0) {
        int at = find(before_names[i]);
        if (at < 0) die("no bound for", before_names[i]);
        b = bounds[at];
      }
      put32(in + 4 * w++, b);
    }
    FILE *f = fopen(inpath, "wb");
    if (!f || fwrite(in, 4, words, f) != words) die("cannot write", inpath);
    fclose(f);
    free(in);
    free(src);
    pid_t pid = fork();
    if (pid < 0) die("fork failed", "");
    if (pid == 0) {
      if (!freopen(inpath, "rb", stdin) || !freopen(outpath, "wb", stdout)) _exit(127);
      execl(exe, exe, (char *)NULL);
      _exit(127);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
      char code[MAX_PATH + 64];
      snprintf(code, sizeof code, "chunk %s, status %d", file, WIFEXITED(status) ? WEXITSTATUS(status) : -1);
      die("the stage failed on", code);
    }
    size_t on;
    unsigned char *out = slurp(outpath, &on);
    if (on < 4) die("empty stage output for", file);
    uint32_t k = get32(out + on - 4);
    if ((size_t)k != (size_t)nown || on < 4 * ((size_t)k + 1)) die("bound count differs from the plan for", file);
    size_t c = on - 4 * ((size_t)k + 1);
    for (uint32_t i = 0; i < k; i++) {
      if (nnames == MAX_NAMES || strlen(own_names[i]) >= MAX_NAME) die("name table full", "");
      strcpy(names[nnames], own_names[i]);
      bounds[nnames++] = get32(out + c + 4 * (size_t)i);
    }
    if (fwrite(out, 1, c, result) != c) die("cannot write", outc);
    free(out);
    chunks++;
  }
  fclose(result);
  remove(inpath);
  remove(outpath);
  fprintf(stderr, "a0seed-driver: %d chunks -> %s\n", chunks, outc);
  return 0;
}
