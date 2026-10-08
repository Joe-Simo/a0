/*
 * The native `a0` driver (built by tools/native-check.ts into dist/native/a0). The front end is
 * the self-hosted one: compiler/check.a0 (with parse.a0 and lex.a0) compiled by A0's C
 * backend into checker.c, entries `checkio` (diagnostic only) and `irio` (diagnostic and the
 * checked word IR of DESIGN.md 7a). This file is the host side only: it reads and links the
 * source files, calls the front end, and evaluates the IR it returns. No Node, no C compiler
 * and no code generation at run time.
 *
 *   a0 check <file.a0>                 ok, or the diagnostic; exit code = diagnostic code
 *   a0 run <file.a0> <function> <args> the result, printed as the TypeScript CLI prints it
 *   a0 bench <file.a0> <function> <n>  n calls on xorshift32 inputs: "ns-per-call checksum"
 *   a0 calls <file.a0>                 calls from stdin, the test-driver protocol of
 *                                      tools/verify.ts: "index args... [n input...]" per line
 *
 * Linking: `use "path"` lines are resolved as src/link.ts resolves them (relative to the using
 * file, symlinks followed, inside the project root: the nearest ancestor with a package.json,
 * each file once, dependencies first, cycles rejected); the use lines are blanked and the
 * files joined with a newline. `run`, `bench` and `calls` need the joined text within the front end's
 * 131072 bytes; `check` has no such limit (chunked check below).
 *
 * Evaluation: the reference semantics of src/core.ts `run`. Every value is flat: a u32 or
 * bool is one word, io none (one token exists per call; its state is global), an array or
 * record its elements' words in order. Every function has one static frame (A0 calls only
 * functions defined above, so no function is active twice): its parameters, then one slot per
 * node. A `set`/`put` whose aggregate operand is not used after it (and is not the result)
 * writes that operand's slot in place; everything else copies, as value semantics say.
 */
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#ifdef _WIN32
#include <direct.h>
#include <fcntl.h>
#include <io.h>
/* realpath for Windows: the full path with forward slashes, NULL when the file does not exist
   (symbolic links are not followed). */
static char *realpath(const char *p, char *out) {
  if (_fullpath(out, p, PATH_MAX) == NULL || access(out, 0) != 0) return NULL;
  for (char *c = out; *c; c++)
    if (*c == '\\') *c = '/';
  return out;
}
#include <windows.h>
/* clock_gettime(CLOCK_MONOTONIC) of the C runtime is not always linkable here. */
static int a0_clock(struct timespec *t) {
  LARGE_INTEGER f, c;
  QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&c);
  t->tv_sec = (time_t)(c.QuadPart / f.QuadPart);
  t->tv_nsec = (long)((c.QuadPart % f.QuadPart) * 1000000000LL / f.QuadPart);
  return 0;
}
#define clock_gettime(id, t) a0_clock(t)
#endif
#include "checker.c"

#define SRC_LIMIT A0_FRONT_END_LIMIT
#define MAX_FILES 4096

static a0_io io;
static const char *const KINDS[] = {"ok", "parse", "structure", "type", "limit"};

static void die(int code, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fputs("a0: ", stderr);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
  exit(code);
}

/* ------------------------------------------------------------------ linking */

typedef struct {
  char path[PATH_MAX];
  char *text;
  size_t len;
} File;

static File files[MAX_FILES];
static int nfiles;
static char visiting[MAX_FILES][PATH_MAX];
static int nvisiting;
static char root[PATH_MAX];
static char entry_abs[PATH_MAX];
static bool root_ready;

static char *read_all(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) return NULL;
  size_t cap = 1 << 14, n = 0;
  char *buf = malloc(cap + 1);
  for (;;) {
    if (n == cap) buf = realloc(buf, (cap *= 2) + 1);
    size_t got = fread(buf + n, 1, cap - n, f);
    n += got;
    if (got == 0) break;
  }
  int bad = ferror(f);
  fclose(f);
  if (bad) {
    free(buf);
    return NULL;
  }
  buf[n] = '\0';
  *len = n;
  return buf;
}

static void dir_of(const char *path, char *out) {
  strcpy(out, path);
  char *slash = strrchr(out, '/');
  if (slash == NULL) strcpy(out, ".");
  else if (slash == out) out[1] = '\0';
  else *slash = '\0';
}

/* The nearest ancestor of the entry's directory holding package.json, else that directory. */
static void project_root(const char *entry_abs) {
  char dir[PATH_MAX], probe[PATH_MAX + 16];
  dir_of(entry_abs, dir);
  strcpy(root, dir);
  for (;;) {
    snprintf(probe, sizeof probe, "%s/package.json", dir);
    if (access(probe, F_OK) == 0) {
      strcpy(root, dir);
      return;
    }
    if (strcmp(dir, "/") == 0) return;
    char up[PATH_MAX];
    dir_of(dir, up);
    if (strcmp(up, dir) == 0 || strcmp(up, ".") == 0 || (strlen(up) < 3 && up[1] == ':')) return;
    strcpy(dir, up);
  }
}

static bool inside_root(const char *abs) {
  /* Found on the first `use` only: a file without one never looks for the project root. */
  if (!root_ready) {
    project_root(entry_abs);
    root_ready = true;
  }
  size_t n = strlen(root);
  if (strcmp(root, "/") == 0) return true;
  return strncmp(abs, root, n) == 0 && (abs[n] == '/' || abs[n] == '\0');
}

/* A line without its `#` comment (outside double quotes), trimmed: [*b, *e). */
static void clean_line(const char *s, const char *end, const char **b, const char **e) {
  const char *p = s;
  bool quoted = false;
  for (; p < end; p++) {
    if (*p == '"') quoted = !quoted;
    else if (*p == '#' && !quoted) break;
  }
  while (s < p && (*s == ' ' || *s == '\t' || *s == '\r')) s++;
  while (p > s && (p[-1] == ' ' || p[-1] == '\t' || p[-1] == '\r')) p--;
  *b = s;
  *e = p;
}

static void visit(const char *path, const char *from) {
  const char *abs = path; /* canonical: the entry and every use target went through realpath */
  for (int i = 0; i < nfiles; i++)
    if (strcmp(files[i].path, abs) == 0) return;
  for (int i = 0; i < nvisiting; i++)
    if (strcmp(visiting[i], abs) == 0)
      die(2, "use cycle: %s is already being linked (from %s)", abs, from);
  if (nvisiting == MAX_FILES || nfiles == MAX_FILES) die(4, "more than %d files", MAX_FILES);
  strcpy(visiting[nvisiting++], abs);
  size_t len = 0;
  char *text = read_all(abs, &len);
  if (text == NULL) die(64, "cannot read %s", abs);
  char dir[PATH_MAX];
  dir_of(abs, dir);
  /* Leading `use "path"` lines (before the first other non-empty line) are resolved and
     blanked; any other line is left to the front end, which reports it. */
  char *line = text, *end = text + len;
  while (line < end) {
    char *nl = memchr(line, '\n', (size_t)(end - line));
    char *le = nl == NULL ? end : nl;
    const char *b, *e;
    clean_line(line, le, &b, &e);
    if (b < e) {
      size_t n = (size_t)(e - b);
      if (!(n >= 7 && strncmp(b, "use", 3) == 0 && (b[3] == ' ' || b[3] == '\t'))) break;
      const char *q = b + 3;
      while (q < e && (*q == ' ' || *q == '\t')) q++;
      if (!(q < e && *q == '"' && e[-1] == '"' && e - q >= 3)) break;
      const char *t0 = q + 1, *t1 = e - 1;
      bool plain = true;
      for (const char *c = t0; c < t1; c++)
        if (*c == '"' || *c == '\\') plain = false;
      if (!plain) break;
      char rel[PATH_MAX], target[PATH_MAX * 2 + 2], canon[PATH_MAX];
      snprintf(rel, sizeof rel, "%.*s", (int)(t1 - t0), t0);
      if (rel[0] == '/') snprintf(target, sizeof target, "%s", rel);
      else snprintf(target, sizeof target, "%s/%s", dir, rel);
      if (realpath(target, canon) == NULL) die(64, "cannot read %s (use in %s)", target, abs);
      size_t cn = strlen(canon);
      if (cn < 3 || strcmp(canon + cn - 3, ".a0") != 0 || !inside_root(canon))
        die(2, "use target %s is not an .a0 file inside the project root (in %s)", canon, abs);
      visit(canon, abs);
      memset(line, ' ', (size_t)(le - line));
    }
    line = le + 1;
  }
  nvisiting--;
  strcpy(files[nfiles].path, abs);
  files[nfiles].text = text;
  files[nfiles].len = len;
  nfiles++;
}

/* Link the entry and everything it uses into files[] (dependencies first). */
static void link_entry(const char *entry) {
  char abs[PATH_MAX];
  if (realpath(entry, abs) == NULL) die(64, "cannot read %s", entry);
  strcpy(entry_abs, abs);
  visit(abs, entry);
}

/* The linked source into the front end's input: n, then the n bytes. */
static void load(const char *entry) {
  link_entry(entry);
  size_t n = 0;
  for (int i = 0; i < nfiles; i++) n += files[i].len + (i > 0 ? 1 : 0);
  if (n > SRC_LIMIT)
    die(65, "%s: the linked program is %zu bytes, over the front end's %u-byte limit", entry, n,
        (unsigned)SRC_LIMIT);
  size_t k = 1;
  for (int i = 0; i < nfiles; i++) {
    if (i > 0) io.input[k++] = '\n';
    for (size_t j = 0; j < files[i].len; j++) io.input[k++] = (unsigned char)files[i].text[j];
  }
  io.input[0] = (uint32_t)n;
  io.ninput = (uint32_t)n + 1u;
  io.position = 0;
  io.noutput = 0;
}

/* An unknown name: ask suggestio about the rejected token and print its table row and the guess
   (the line of src/diagnostics.ts: `A0102 unknown callee 'mull': did you mean 'mul'?`). */
static void suggest(uint32_t tok) {
  static const struct { unsigned rule; const char *text; } rules[] = {
      {1u, "unknown type"}, {101u, "undefined node"}, {102u, "unknown callee"},
      {103u, "unknown fold or loop body"}, {104u, "unknown loop predicate"}};
  uint32_t n = io.input[0];
  io.input[n + 1] = tok;
  io.ninput = n + 2u;
  io.position = 0u;
  io.noutput = 0u;
  a0_suggestio(&io);
  uint32_t rule = io.output[0], mode = io.output[1], len = io.output[2];
  uint32_t start = io.output[3], nlen = io.output[4];
  if (rule == 0u) return;
  const char *text = "unknown name";
  for (size_t k = 0; k < sizeof rules / sizeof rules[0]; k++)
    if (rules[k].rule == rule) text = rules[k].text;
  fprintf(stderr, "A%04u %s '", rule, text);
  for (uint32_t k = 0; k < nlen; k++) fputc((int)io.input[1u + start + k], stderr);
  fputc('\'', stderr);
  if (mode == 1u) {
    fputs(": did you mean '", stderr);
    for (uint32_t k = 0; k < len; k++) fputc((int)io.output[5 + k], stderr);
    fputs("'?", stderr);
  } else if (mode == 2u) {
    fputs(": defined later, so move it above", stderr);
  }
  fputc('\n', stderr);
}

/* Report the front end's diagnostic (output words 1..3) and return its code. */
static int diagnose(const char *file, uint32_t code) {
  if (code == 0) return 0;
  const char *kind = code < 5u ? KINDS[code] : "unknown";
  if (io.output[2] == 0xffffffffu) {
    uint32_t tok = io.output[3];
    fprintf(stderr, "%s: %s error %u at token %u\n", file, kind, code, tok);
    if (code == 1u || code == 2u) suggest(tok);
  } else
    fprintf(stderr, "%s: %s error %u in function %u at node %u\n", file, kind, code,
            io.output[2], io.output[3]);
  return (int)code;
}

/* ------------------------------------------------------------------ the IR */

typedef struct {
  uint32_t kind, v, w;
} Opd; /* kind 1 node slot offset, 2 param slot offset, 3 immediate; w its width in words */

typedef struct {
  uint32_t op, dst, w, na, first, callee, pred;
  uint32_t len, ew; /* get/set: array length, element width; at/put: field offset; puts: length */
  bool inplace;
} Ins;

typedef struct {
  uint32_t name, nparams, tfirst, result, nfirst, nnodes, ret;
  uint32_t frame_words, *frame, *poff, *pw, ins0;
  Opd retop;
  uint32_t retw;
  bool *mutparam;
} Fn;

static const uint32_t *types, *tlist, *ntys, *pool, *sym, *fnw, *nodew, *argw;
static uint32_t ntypes, ntlist, nnodes_all, npool, nsym, nfns, nargs;
static uint32_t *wid;
static Fn *fns;
static Ins *ins;
static Opd *opds;
static uint32_t *arena;

static uint32_t width(uint32_t t) {
  if (wid[t] != UINT32_MAX) return wid[t];
  uint32_t tag = types[3 * t], a = types[3 * t + 1], b = types[3 * t + 2], w = 0;
  if (tag == 1 || tag == 2) w = 1;
  else if (tag == 4) w = a * width(b);
  else if (tag == 5)
    for (uint32_t k = 0; k < b; k++) w += width(tlist[a + k]);
  return wid[t] = w;
}

/* Offset of field k of record type t. */
static uint32_t field_offset(uint32_t t, uint32_t k) {
  uint32_t a = types[3 * t + 1], off = 0;
  for (uint32_t j = 0; j < k; j++) off += width(tlist[a + j]);
  return off;
}

static uint32_t argtype(const Fn *f, uint32_t kind, uint32_t v) {
  return kind == 1 ? ntys[f->nfirst + v] : kind == 2 ? tlist[f->tfirst + v] : 0;
}

/* Words of the front end's output after the header: each table is its count, then words. */
static const uint32_t *table(uint32_t *pos, uint32_t *count) {
  *count = io.output[(*pos)++];
  const uint32_t *t = io.output + *pos;
  *pos += *count;
  return t;
}

static void build(void) {
  uint32_t pos = 4, n;
  types = table(&pos, &n);
  ntypes = n / 3;
  tlist = table(&pos, &ntlist);
  ntys = table(&pos, &nnodes_all);
  pool = table(&pos, &npool);
  sym = table(&pos, &n);
  nsym = n / 2;
  fnw = table(&pos, &n);
  nfns = n / 7;
  nodew = table(&pos, &n);
  argw = table(&pos, &n);
  nargs = n / 2;
  wid = malloc(sizeof *wid * (ntypes + 1));
  for (uint32_t t = 0; t < ntypes; t++) wid[t] = UINT32_MAX;
  fns = calloc(nfns + 1, sizeof *fns);
  ins = calloc(nnodes_all + 1, sizeof *ins);
  opds = calloc(nargs + 1, sizeof *opds);
  size_t total = 0;
  for (uint32_t i = 0; i < nfns; i++) {
    Fn *f = &fns[i];
    const uint32_t *w = fnw + 7 * i;
    f->name = w[0];
    f->nparams = w[1];
    f->tfirst = w[2];
    f->result = w[3];
    f->nfirst = w[4];
    f->nnodes = w[5];
    f->ret = w[6];
    f->poff = malloc(sizeof(uint32_t) * (f->nparams + 1));
    f->pw = malloc(sizeof(uint32_t) * (f->nparams + 1));
    f->mutparam = calloc(f->nparams + 1, sizeof(bool));
    uint32_t off = 0;
    for (uint32_t k = 0; k < f->nparams; k++) {
      f->poff[k] = off;
      f->pw[k] = width(tlist[f->tfirst + k]);
      off += f->pw[k];
    }
    /* Last use of every node and parameter operand, for the in-place updates. */
    uint32_t *last_node = malloc(sizeof(uint32_t) * (f->nnodes + 1));
    uint32_t *last_param = malloc(sizeof(uint32_t) * (f->nparams + 1));
    for (uint32_t j = 0; j < f->nnodes; j++) last_node[j] = j;
    for (uint32_t k = 0; k < f->nparams; k++) last_param[k] = 0;
    uint32_t retk = f->ret >> 28, retv = f->ret & 0x0fffffffu;
    for (uint32_t j = 0; j < f->nnodes; j++) {
      const uint32_t *nd = nodew + 6 * (f->nfirst + j);
      for (uint32_t a = 0; a < nd[2]; a++) {
        uint32_t kind = argw[2 * (nd[3] + a)], v = argw[2 * (nd[3] + a) + 1];
        if (kind == 1) last_node[v] = j;
        if (kind == 2) last_param[v] = j;
      }
    }
    uint32_t *slot = malloc(sizeof(uint32_t) * (f->nnodes + 1));
    for (uint32_t j = 0; j < f->nnodes; j++) {
      uint32_t g = f->nfirst + j;
      const uint32_t *nd = nodew + 6 * g;
      Ins *in = &ins[g];
      in->op = nd[1];
      in->na = nd[2];
      in->first = nd[3];
      in->callee = nd[4];
      in->pred = nd[5];
      in->w = width(ntys[g]);
      for (uint32_t a = 0; a < in->na; a++) {
        uint32_t kind = argw[2 * (in->first + a)], v = argw[2 * (in->first + a) + 1];
        Opd *o = &opds[in->first + a];
        o->kind = kind == 1 ? 1 : kind == 2 ? 2 : 3;
        o->v = kind == 1 ? slot[v] : kind == 2 ? f->poff[v] : v;
        o->w = kind >= 3 ? 1 : width(argtype(f, kind, v));
      }
      if (in->op == 25 || in->op == 26) {
        uint32_t t = argtype(f, argw[2 * in->first], argw[2 * in->first + 1]);
        in->len = types[3 * t + 1];
        in->ew = width(types[3 * t + 2]);
      }
      if (in->op == 27 || in->op == 28) {
        uint32_t t = argtype(f, argw[2 * in->first], argw[2 * in->first + 1]);
        in->len = field_offset(t, argw[2 * (in->first + 1) + 1]);
      }
      if (in->op == 31)
        in->len = types[3 * argtype(f, argw[2 * (in->first + 1)], argw[2 * (in->first + 1) + 1]) + 1];
      /* In place: the aggregate operand of set/put dies here (not used later, not the
         result), so this node takes its slot. */
      if (in->op == 26 || in->op == 28) {
        uint32_t kind = argw[2 * in->first], v = argw[2 * in->first + 1];
        bool dead = kind == 1 ? last_node[v] == j && !(retk == 1 && retv == v)
                    : kind == 2 ? last_param[v] == j && !(retk == 2 && retv == v)
                                : false;
        if (dead) {
          in->inplace = true;
          slot[j] = kind == 1 ? slot[v] : f->poff[v];
          if (kind == 2) f->mutparam[v] = true;
        }
      }
      if (!in->inplace) {
        slot[j] = off;
        off += in->w;
      }
      in->dst = slot[j];
    }
    f->retop.kind = retk == 1 ? 1 : retk == 2 ? 2 : 3;
    f->retop.v = retk == 1 ? slot[retv] : retk == 2 ? f->poff[retv] : retv;
    f->retw = width(f->result);
    f->frame_words = off;
    f->ins0 = f->nfirst;
    total += off;
    free(last_node);
    free(last_param);
    free(slot);
  }
  arena = calloc(total + 1, sizeof(uint32_t));
  if (arena == NULL) die(4, "cannot allocate the frames");
  size_t base = 0;
  for (uint32_t i = 0; i < nfns; i++) {
    fns[i].frame = arena + base;
    base += fns[i].frame_words;
  }
}

/* ------------------------------------------------------------------ evaluation */

typedef struct {
  const uint32_t *input;
  uint32_t ninput, position;
  uint32_t *output;
  uint32_t noutput, cap;
} Io;
static Io rt;

static void emit_word(uint32_t v) {
  if (rt.noutput == rt.cap) {
    rt.cap = rt.cap == 0 ? 1024 : rt.cap * 2;
    rt.output = realloc(rt.output, sizeof(uint32_t) * rt.cap);
  }
  rt.output[rt.noutput++] = v;
}

#define VAL(fr, o) ((o).kind == 3 ? (o).v : (fr)[(o).v])
#define PTR(fr, o) ((fr) + (o).v)

static void exec(uint32_t fi);

/* Copy the operands of a call, fold or loop into the parameters of g, from parameter `from`. */
static void pass_args(Fn *g, const uint32_t *fr, const Opd *o, uint32_t n, uint32_t from) {
  for (uint32_t k = 0; k < n; k++) {
    uint32_t p = from + k;
    if (o[k].kind == 3) g->frame[g->poff[p]] = o[k].v;
    else memcpy(g->frame + g->poff[p], fr + o[k].v, sizeof(uint32_t) * o[k].w);
  }
}

static const uint32_t *result_of(Fn *g) {
  return g->retop.kind == 3 ? &g->retop.v : g->frame + g->retop.v;
}

static void exec(uint32_t fi) {
  Fn *f = &fns[fi];
  uint32_t *fr = f->frame;
  for (uint32_t j = 0; j < f->nnodes; j++) {
    const Ins *in = &ins[f->ins0 + j];
    const Opd *o = opds + in->first;
    uint32_t *d = fr + in->dst;
    switch (in->op) {
    case 1: /* mov */
      if (o[0].kind == 3) *d = o[0].v;
      else memmove(d, PTR(fr, o[0]), sizeof(uint32_t) * in->w);
      break;
    case 2: *d = VAL(fr, o[0]) + VAL(fr, o[1]); break;
    case 3: *d = VAL(fr, o[0]) - VAL(fr, o[1]); break;
    case 4: *d = VAL(fr, o[0]) * VAL(fr, o[1]); break;
    case 5: *d = VAL(fr, o[0]) & VAL(fr, o[1]); break;
    case 6: *d = VAL(fr, o[0]) | VAL(fr, o[1]); break;
    case 7: *d = VAL(fr, o[0]) ^ VAL(fr, o[1]); break;
    case 8: *d = VAL(fr, o[0]) << (VAL(fr, o[1]) & 31u); break;
    case 9: *d = VAL(fr, o[0]) >> (VAL(fr, o[1]) & 31u); break;
    case 10: {
      uint32_t b = VAL(fr, o[1]);
      *d = b == 0 ? 0xffffffffu : VAL(fr, o[0]) / b;
      break;
    }
    case 11: {
      uint32_t a = VAL(fr, o[0]), b = VAL(fr, o[1]);
      *d = b == 0 ? a : a % b;
      break;
    }
    case 12: *d = VAL(fr, o[0]) == VAL(fr, o[1]); break;
    case 13: *d = VAL(fr, o[0]) != VAL(fr, o[1]); break;
    case 14: *d = VAL(fr, o[0]) < VAL(fr, o[1]); break;
    case 15: *d = VAL(fr, o[0]) <= VAL(fr, o[1]); break;
    case 16: *d = VAL(fr, o[0]) > VAL(fr, o[1]); break;
    case 17: *d = VAL(fr, o[0]) >= VAL(fr, o[1]); break;
    case 18: { /* select */
      const Opd *s = VAL(fr, o[0]) ? &o[1] : &o[2];
      if (s->kind == 3) *d = s->v;
      else memmove(d, PTR(fr, *s), sizeof(uint32_t) * in->w);
      break;
    }
    case 19: { /* call */
      Fn *g = &fns[in->callee];
      pass_args(g, fr, o, in->na, 0);
      exec(in->callee);
      memcpy(d, result_of(g), sizeof(uint32_t) * in->w);
      break;
    }
    case 20:
    case 21: { /* fold, loop: count, init, extras */
      Fn *b = &fns[in->callee];
      Fn *p = in->op == 21 ? &fns[in->pred] : NULL;
      uint32_t count = VAL(fr, o[0]), nx = in->na - 2;
      uint32_t *state = b->frame + b->poff[0];
      if (o[1].kind == 3) *state = o[1].v;
      else memcpy(state, PTR(fr, o[1]), sizeof(uint32_t) * in->w);
      bool bx = false, px = false;
      for (uint32_t k = 0; k < nx; k++) {
        bx = bx || b->mutparam[k + 2];
        if (p != NULL) px = px || p->mutparam[k + 2];
      }
      pass_args(b, fr, o + 2, nx, 2);
      if (p != NULL) pass_args(p, fr, o + 2, nx, 2);
      for (uint32_t i = 0; i < count; i++) {
        if (p != NULL) {
          if (i > 0 && px) pass_args(p, fr, o + 2, nx, 2);
          if (p != b) memcpy(p->frame + p->poff[0], state, sizeof(uint32_t) * in->w);
          p->frame[p->poff[1]] = i;
          exec(in->pred);
          if (*result_of(p) == 0) break;
          if (p == b) {
            memcpy(state, p->frame + p->poff[0], sizeof(uint32_t) * in->w);
            pass_args(b, fr, o + 2, nx, 2);
          }
        }
        if (i > 0 && bx) pass_args(b, fr, o + 2, nx, 2);
        b->frame[b->poff[1]] = i;
        exec(in->callee);
        const uint32_t *r = result_of(b);
        if (r != state) memmove(state, r, sizeof(uint32_t) * in->w);
      }
      memcpy(d, state, sizeof(uint32_t) * in->w);
      break;
    }
    case 22:
    case 23:
    case 24: { /* arr, rec, text: the operands' words in order */
      uint32_t off = 0;
      for (uint32_t k = 0; k < in->na; k++) {
        if (o[k].kind == 3) d[off] = o[k].v;
        else memcpy(d + off, PTR(fr, o[k]), sizeof(uint32_t) * o[k].w);
        off += o[k].w;
      }
      break;
    }
    case 25: { /* get */
      uint32_t i = VAL(fr, o[1]) % in->len;
      memmove(d, PTR(fr, o[0]) + i * in->ew, sizeof(uint32_t) * in->w);
      break;
    }
    case 26: { /* set */
      if (!in->inplace) memmove(d, PTR(fr, o[0]), sizeof(uint32_t) * in->w);
      uint32_t i = VAL(fr, o[1]) % in->len;
      if (o[2].kind == 3) d[i * in->ew] = o[2].v;
      else memmove(d + i * in->ew, PTR(fr, o[2]), sizeof(uint32_t) * in->ew);
      break;
    }
    case 27: /* at */
      memmove(d, PTR(fr, o[0]) + in->len, sizeof(uint32_t) * in->w);
      break;
    case 28: /* put */
      if (!in->inplace) memmove(d, PTR(fr, o[0]), sizeof(uint32_t) * in->w);
      if (o[2].kind == 3) d[in->len] = o[2].v;
      else memmove(d + in->len, PTR(fr, o[2]), sizeof(uint32_t) * o[2].w);
      break;
    case 29: /* read: (u32, io) */
      *d = rt.position < rt.ninput ? rt.input[rt.position++] : 0;
      break;
    case 30: /* write */
      emit_word(VAL(fr, o[1]));
      break;
    case 31: { /* puts: the length, then every element */
      const uint32_t *e = PTR(fr, o[1]);
      emit_word(in->len);
      for (uint32_t k = 0; k < in->len; k++) emit_word(e[k]);
      break;
    }
    default:
      die(70, "unknown operation %u in the IR", in->op);
    }
  }
}

/* ------------------------------------------------------------------ commands */

#ifdef A0_PROFILE
static double now_us(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e6 + t.tv_nsec / 1e3;
}
#define MARK(name) do { double n_ = now_us(); fprintf(stderr, "  %-10s %8.1f us\n", name, n_ - last_); last_ = n_; } while (0)
static double last_;
#else
#define MARK(name) ((void)0)
#endif

static uint32_t front(const char *file, bool ir) {
  load(file);
  MARK("load");
  uint32_t code = ir ? a0_irio(&io) : a0_checkio(&io);
  MARK("frontend");
  if (code == 0 && ir) build();
  MARK("build");
  return code;
}

static bool sym_is(uint32_t s, const char *name) {
  uint32_t start = sym[2 * s], len = sym[2 * s + 1];
  if (strlen(name) != len) return false;
  for (uint32_t k = 0; k < len; k++)
    if (pool[start + k] != (unsigned char)name[k]) return false;
  return true;
}

static uint32_t find_fn(const char *name) {
  for (uint32_t i = 0; i < nfns; i++)
    if (sym_is(fns[i].name, name)) return i;
  die(1, "unknown function '%s'", name);
  return 0;
}

static uint32_t tag_of(uint32_t t) { return types[3 * t]; }

/* A value as the TypeScript CLI prints it: String() of the reference value. */
static void print_value(uint32_t t, const uint32_t *v, bool *first) {
  uint32_t tag = tag_of(t), a = types[3 * t + 1], b = types[3 * t + 2];
  if (tag == 1 || tag == 2) {
    if (!*first) putchar(',');
    *first = false;
    if (tag == 1) printf("%u", *v);
    else fputs(*v ? "true" : "false", stdout);
  } else if (tag == 4) {
    uint32_t ew = width(b);
    for (uint32_t k = 0; k < a; k++) print_value(b, v + k * ew, first);
  } else if (tag == 5) {
    uint32_t off = 0;
    for (uint32_t k = 0; k < b; k++) {
      uint32_t ft = tlist[a + k];
      print_value(ft, v + off, first);
      off += width(ft);
    }
  } else {
    if (!*first) putchar(',');
    *first = false;
    fputs("[object Object]", stdout);
  }
}

/* A scalar argument as src/cli.ts parseValue and checkArgument accept it. */
static uint32_t parse_arg(const char *s, uint32_t t, uint32_t k) {
  uint32_t tag = tag_of(t);
  const char *want = tag == 1 ? "u32" : tag == 2 ? "bool" : tag == 3 ? "io token" : "aggregate";
  if (strcmp(s, "true") == 0 || strcmp(s, "false") == 0) {
    if (tag != 2) die(1, "p%u: expected %s", k, want);
    return s[0] == 't';
  }
  bool digits = s[0] != '\0' && (s[0] != '0' || s[1] == '\0');
  for (const char *c = s; *c; c++) digits = digits && *c >= '0' && *c <= '9';
  if (!digits) die(1, "invalid argument '%s'", s);
  if (tag != 1 || strlen(s) > 10 || strtoull(s, NULL, 10) > 0xffffffffull)
    die(1, "p%u: expected %s", k, want);
  return (uint32_t)strtoul(s, NULL, 10);
}

static int cmd_run(const char *file, const char *name, int argc, char **argv) {
  uint32_t code = front(file, true);
  if (code != 0) return diagnose(file, code);
  uint32_t fi = find_fn(name);
  Fn *f = &fns[fi];
  if ((uint32_t)argc != f->nparams)
    die(1, "%s: expected %u arguments, got %d", name, f->nparams, argc);
  for (uint32_t k = 0; k < f->nparams; k++)
    f->frame[f->poff[k]] = parse_arg(argv[k], tlist[f->tfirst + k], k);
  exec(fi);
  MARK("exec");
  bool first = true;
  print_value(f->result, result_of(f), &first);
  putchar('\n');
  return 0;
}

static bool scalar(uint32_t t) { return tag_of(t) == 1 || tag_of(t) == 2; }

static int cmd_bench(const char *file, const char *name, const char *iters) {
  uint32_t code = front(file, true);
  if (code != 0) return diagnose(file, code);
  uint32_t fi = find_fn(name);
  Fn *f = &fns[fi];
  for (uint32_t k = 0; k < f->nparams; k++)
    if (!scalar(tlist[f->tfirst + k])) die(1, "bench: %s has a parameter that is not u32 or bool", name);
  if (!scalar(f->result)) die(1, "bench: %s does not return u32 or bool", name);
  long n = atol(iters);
  uint32_t s = 0x9e3779b9u, acc = 0;
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  for (long i = 0; i < n; i++) {
    for (uint32_t k = 0; k < f->nparams; k++) {
      s ^= s << 13;
      s ^= s >> 17;
      s ^= s << 5;
      f->frame[f->poff[k]] = tag_of(tlist[f->tfirst + k]) == 2 ? s != 0 : s;
    }
    exec(fi);
    acc ^= *result_of(f);
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);
  double ns = ((t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec)) / (double)(n > 0 ? n : 1);
  printf("%.4f %u\n", ns, acc);
  return 0;
}

/* The protocol of tools/verify.ts cDriver: "index args... [n input...]" in, "result [out...]". */
static int cmd_calls(const char *file) {
  uint32_t code = front(file, true);
  if (code != 0) return diagnose(file, code);
  static char line[1 << 20];
  static char *tok[1 << 16];
  uint32_t *input = malloc(sizeof(uint32_t) * (1 << 16));
  while (fgets(line, sizeof line, stdin)) {
    int n = 0;
    for (char *p = strtok(line, " \n"); p && n < (1 << 16); p = strtok(NULL, " \n")) tok[n++] = p;
    if (n < 1) continue;
    uint32_t fi = (uint32_t)atoi(tok[0]);
    int m = n - 1;
    if (fi >= nfns) {
      puts("?");
      continue;
    }
    Fn *f = &fns[fi];
    bool io_last = f->nparams > 0 && tag_of(tlist[f->tfirst + f->nparams - 1]) == 3;
    uint32_t ns = io_last ? f->nparams - 1 : f->nparams;
    bool callable = scalar(f->result);
    for (uint32_t k = 0; k < ns; k++) callable = callable && scalar(tlist[f->tfirst + k]);
    if (!callable) {
      puts("skip");
      continue;
    }
    if ((uint32_t)m < ns + (io_last ? 1 : 0)) {
      puts("?");
      continue;
    }
    for (uint32_t k = 0; k < ns; k++) {
      uint32_t v = (uint32_t)strtoul(tok[1 + k], NULL, 10);
      f->frame[f->poff[k]] = tag_of(tlist[f->tfirst + k]) == 2 ? tok[1 + k][0] == '1' : v;
    }
    rt.ninput = 0;
    rt.position = 0;
    rt.noutput = 0;
    if (io_last) {
      uint32_t want = (uint32_t)strtoul(tok[1 + ns], NULL, 10), avail = (uint32_t)m - ns - 1;
      rt.ninput = want < avail ? want : avail;
      if (rt.ninput > (1u << 16)) rt.ninput = 1u << 16;
      for (uint32_t k = 0; k < rt.ninput; k++) input[k] = (uint32_t)strtoul(tok[2 + ns + k], NULL, 10);
      rt.input = input;
    }
    exec(fi);
    printf("%u", *result_of(f));
    for (uint32_t k = 0; k < rt.noutput; k++) printf(" %u", rt.output[k]);
    putchar('\n');
  }
  return 0;
}

/* ------------------------------------------------------------------ chunked check */

/*
 * `a0 check` on a program of any size. The front end holds at most 131072 source bytes, 16384
 * tokens, 820 functions and 2730 nodes at once (compiler/parse.a0 `fecap`), so a larger linked
 * program is cut at function boundaries, as tools/bootstrap.ts planChunks cuts the compiler for
 * the seed: a chunk is the stubs of the earlier functions its functions call (the signature and
 * `ret 0`, not checked) followed by its own functions as written; `chunkio` (compiler/native.a0)
 * checks only the own ones, given the iteration bounds of the stubs. The chunks are consecutive,
 * greedy to a margin below the capacities; a chunk the front end still refuses (limit, parse
 * phase) is halved, and one function over a capacity is "unsupported" (exit 65: use the
 * TypeScript checker). The first diagnostic is the one src/core.ts reports: the first parse-phase
 * error in program order, else the first checker error. Programs the chunks cannot represent
 * exactly (a `profile` line, a function defined twice across chunks) are unsupported too.
 */

#define CHUNK_BYTES 120000u
#define CHUNK_TOKENS 15000u
#define CHUNK_NODES 2500u
#define CHUNK_FNS 760u
#define NO_FN 0xffffffffu
#define MAX_SOURCE_BYTES (1u << 20)

/*
 * `a0 check --chunk-bytes=N FILE` sets the byte margin of a chunk (the other margins stay); N = 0
 * plans the whole program as one chunk, which is the unchunked check whenever the front end takes
 * it (the front end then refuses a program over its capacities, and the driver halves it as it
 * halves any chunk it refuses). Tests compare the two plans with the TypeScript checker. With
 * A0_CHUNK_TRACE set, every chunk is announced on stderr as "chunk ua..ub: N bytes, S stubs".
 */
static size_t plan_bytes = CHUNK_BYTES;
static bool plan_whole = false;

typedef struct {
  char *p;
  size_t n, cap;
} Buf;

static void bput(Buf *b, const char *s, size_t n) {
  if (b->n + n + 1 > b->cap) {
    b->cap = (b->n + n + 1) * 2;
    b->p = realloc(b->p, b->cap);
  }
  memcpy(b->p + b->n, s, n);
  b->n += n;
  b->p[b->n] = '\0';
}
static void bputs(Buf *b, const char *s) { bput(b, s, strlen(s)); }
static void bnum(Buf *b, uint32_t v) {
  char t[16];
  int k = snprintf(t, sizeof t, "%u", v);
  bput(b, t, (size_t)k);
}

static const uint32_t K256[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

#define ROR(x, k) (((x) >> (k)) | ((x) << (32 - (k))))

static void sha_block(uint32_t h[8], const uint8_t *p) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++)
    w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 |
           (uint32_t)p[4 * i + 3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t s1 = ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25);
    uint32_t ch = (e & f) ^ (~e & g);
    uint32_t t1 = hh + s1 + ch + K256[i] + w[i];
    uint32_t s0 = ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22);
    uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = s0 + mj;
    hh = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
  h[4] += e;
  h[5] += f;
  h[6] += g;
  h[7] += hh;
}

/* The first 12 hex digits of the SHA-256 of the bytes (src/edit.ts revision). */
static void sha256_hex12(const uint8_t *data, size_t len, char out[13]) {
  uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  size_t i = 0;
  for (; i + 64 <= len; i += 64) sha_block(h, data + i);
  uint8_t tail[128];
  size_t rest = len - i;
  memcpy(tail, data + i, rest);
  tail[rest++] = 0x80;
  size_t total = rest <= 56 ? 64 : 128;
  memset(tail + rest, 0, total - rest);
  uint64_t bits = (uint64_t)len * 8;
  for (int k = 0; k < 8; k++) tail[total - 1 - k] = (uint8_t)(bits >> (8 * k));
  sha_block(h, tail);
  if (total == 128) sha_block(h, tail + 64);
  for (int k = 0; k < 6; k++) snprintf(out + 2 * k, 3, "%02x", (h[k / 4] >> (24 - 8 * (k % 4))) & 255);
  out[12] = '\0';
}

/* -- the linked source and its functions -- */

typedef struct {
  size_t a, b;   /* [a,b) of the linked source: what precedes the function, then it, to its end line */
  size_t ha, hb; /* the header line, without its newline */
  size_t na;
  uint32_t nlen; /* the name */
  uint32_t toks, nodes, bound;
} Unit;

static char *joined;
static size_t jlen;
static size_t file_off[MAX_FILES];
static Unit *units;
static uint32_t nunits;
static int *htab;
static uint32_t hmask;
static bool has_dup;
static uint32_t dup_unit; /* the first function defined a second time */

static uint32_t hash_name(const char *s, uint32_t n) {
  uint32_t h = 2166136261u;
  for (uint32_t i = 0; i < n; i++) h = (h ^ (unsigned char)s[i]) * 16777619u;
  return h;
}

/* The unit that defines the name, or -1. */
static int find_unit(const char *s, uint32_t n) {
  for (uint32_t h = hash_name(s, n) & hmask;; h = (h + 1) & hmask) {
    int u = htab[h];
    if (u < 0) return -1;
    if (units[u].nlen == n && memcmp(joined + units[u].na, s, n) == 0) return u;
  }
}

typedef struct {
  const char *p;
  uint32_t n;
} Word;

/* The first `max` words of the cleaned line [b,e). */
static int words_of(const char *b, const char *e, Word *w, int max) {
  int k = 0;
  while (b < e && k < max) {
    while (b < e && (*b == ' ' || *b == '\t')) b++;
    if (b >= e) break;
    const char *s = b;
    while (b < e && *b != ' ' && *b != '\t') b++;
    w[k].p = s;
    w[k].n = (uint32_t)(b - s);
    k++;
  }
  return k;
}

static bool word_is(Word w, const char *s) { return w.n == strlen(s) && memcmp(w.p, s, w.n) == 0; }

/* Tokens of the lexer (compiler/lex.a0) in [a,b), counted without producing them. */
static uint32_t count_tokens(size_t a, size_t b) {
  uint32_t t = 0;
  size_t i = a;
  while (i < b) {
    unsigned char c = (unsigned char)joined[i];
    if (c == ' ' || c == '\t' || c == '\r') i++;
    else if (c == '\n') {
      t++;
      i++;
    } else if (c == '#') {
      while (i < b && joined[i] != '\n') i++;
    } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
      while (i < b) {
        unsigned char d = (unsigned char)joined[i];
        if (!((d >= 'a' && d <= 'z') || (d >= '0' && d <= '9') || d == '_')) break;
        i++;
      }
      t++;
    } else if (c == '"') {
      i++;
      while (i < b && joined[i] != '"') i += joined[i] == '\\' ? 2 : 1;
      i++;
      t++;
    } else if (c == '-' && i + 1 < b && joined[i + 1] == '>') {
      i += 2;
      t++;
    } else {
      i++;
      t++;
    }
  }
  return t;
}

/* Cut the linked source into units, one per `fn ... end`. */
static void cut_units(void) {
  size_t cap = 64;
  units = malloc(cap * sizeof *units);
  size_t pending = 0;
  bool inside = false;
  Unit cur;
  memset(&cur, 0, sizeof cur);
  size_t line = 0;
  while (line < jlen) {
    char *nl = memchr(joined + line, '\n', jlen - line);
    size_t le = nl == NULL ? jlen : (size_t)(nl - joined);
    const char *b, *e;
    clean_line(joined + line, joined + le, &b, &e);
    Word w[3];
    int k = words_of(b, e, w, 3);
    if (!inside) {
      if (k >= 1 && word_is(w[0], "fn")) {
        memset(&cur, 0, sizeof cur);
        cur.a = pending;
        cur.ha = line;
        cur.hb = le > line && joined[le - 1] == '\r' ? le - 1 : le;
        if (k >= 2) {
          cur.na = (size_t)(w[1].p - joined);
          cur.nlen = w[1].n;
        }
        inside = true;
      }
    } else if (k == 1 && word_is(w[0], "end")) {
      cur.b = nl == NULL ? jlen : le + 1;
      if (nunits == cap) units = realloc(units, (cap *= 2) * sizeof *units);
      units[nunits++] = cur;
      pending = cur.b;
      inside = false;
    }
    line = le + 1;
  }
  if (inside) {
    cur.b = jlen;
    units = realloc(units, (nunits + 1) * sizeof *units);
    units[nunits++] = cur;
  } else if (nunits > 0) units[nunits - 1].b = jlen;
  /* per-unit counts and the name table */
  uint32_t sz = 16;
  while (sz < 2 * nunits + 2) sz *= 2;
  htab = malloc(sz * sizeof *htab);
  for (uint32_t i = 0; i < sz; i++) htab[i] = -1;
  hmask = sz - 1;
  for (uint32_t u = 0; u < nunits; u++) {
    Unit *x = &units[u];
    x->toks = count_tokens(x->a, x->b);
    uint32_t lines = 0;
    for (size_t p = x->ha; p < x->b;) {
      char *nl2 = memchr(joined + p, '\n', x->b - p);
      size_t pe = nl2 == NULL ? x->b : (size_t)(nl2 - joined);
      const char *b, *e;
      clean_line(joined + p, joined + pe, &b, &e);
      if (b < e) lines++;
      p = pe + 1;
    }
    x->nodes = lines > 3 ? lines - 3 : 0;
    if (x->nlen == 0) continue;
    uint32_t h = hash_name(joined + x->na, x->nlen) & hmask;
    for (;; h = (h + 1) & hmask) {
      int o = htab[h];
      if (o < 0) {
        htab[h] = (int)u;
        break;
      }
      if (units[o].nlen == x->nlen && memcmp(joined + units[o].na, joined + x->na, x->nlen) == 0) {
        if (!has_dup) dup_unit = u;
        has_dup = true;
        break;
      }
    }
  }
}

/* -- the diagnostic -- */

typedef struct {
  bool set;
  uint32_t code, fn, node, token;
  size_t off;   /* byte of the offending line in the linked source */
  char at[128]; /* a checker error: NAME.ID of the node (NAME alone for a header, NAME.ret) */
} Diag;

/* first_check: the first checker error; first_parse: the first parse-phase error a chunk found;
   pre: a parse-phase error found before the chunks run (`pre_detect`) */
static Diag first_check, first_parse, pre;

/*
 * Parse-phase errors the chunks cannot see, found before they run: a function defined a second
 * time (the first one may sit in an earlier chunk that the second one does not call) and a number
 * above 4294967295 (src/core.ts A0004; the self-hosted lexer keeps the value modulo 2^32).
 * `pre` is the earlier of the two; a chunk that finds an earlier parse-phase error of its own
 * wins over it, anything after it does not matter.
 */
static void pre_detect(void) {
  size_t over = (size_t)-1;
  size_t i = 0;
  while (i < jlen) {
    unsigned char c = (unsigned char)joined[i];
    if (c == '#') {
      while (i < jlen && joined[i] != '\n') i++;
    } else if (c == '"') {
      i++;
      while (i < jlen && joined[i] != '"') i += joined[i] == '\\' ? 2 : 1;
      i++;
    } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
      size_t s = i;
      bool digits = true;
      while (i < jlen) {
        unsigned char d = (unsigned char)joined[i];
        if (!((d >= 'a' && d <= 'z') || (d >= '0' && d <= '9') || d == '_')) break;
        if (d < '0' || d > '9') digits = false;
        i++;
      }
      if (digits && over == (size_t)-1) {
        size_t z = s;
        while (z + 1 < i && joined[z] == '0') z++;
        size_t len = i - z;
        if (len > 10 || (len == 10 && memcmp(joined + z, "4294967295", 10) > 0)) over = s;
      }
    } else i++;
  }
  size_t dup = has_dup ? units[dup_unit].ha : (size_t)-1;
  if (over == (size_t)-1 && dup == (size_t)-1) return;
  pre.set = true;
  pre.fn = NO_FN;
  if (over < dup) {
    pre.code = 4;
    pre.off = over;
  } else {
    pre.code = 1;
    pre.off = dup;
  }
}


static void line_of(size_t off, const char **path, uint32_t *line) {
  int f = 0;
  for (int i = 0; i < nfiles; i++)
    if (file_off[i] <= off) f = i;
  uint32_t l = 1;
  /* the end of the file belongs to its last line, as the TypeScript parser counts it */
  if (off >= jlen && jlen > 0) off = jlen - 1;
  for (size_t i = file_off[f]; i < off && i < jlen; i++)
    if (joined[i] == '\n') l++;
  *path = files[f].path;
  *line = l;
}

/* The offset of the line of node `node` of unit u (the header for NO_FN, the ret line past the nodes). */
static size_t node_line(uint32_t u, uint32_t node, char *at, size_t atn) {
  const Unit *x = &units[u];
  snprintf(at, atn, "%.*s", (int)x->nlen, joined + x->na);
  if (node == NO_FN) return x->ha;
  uint32_t seen = 0;
  size_t last = x->ha;
  for (size_t p = x->hb; p < x->b;) {
    char *nl = memchr(joined + p, '\n', x->b - p);
    size_t pe = nl == NULL ? x->b : (size_t)(nl - joined);
    const char *b, *e;
    clean_line(joined + p, joined + pe, &b, &e);
    Word w[2];
    int k = words_of(b, e, w, 2);
    if (k >= 1) {
      if (word_is(w[0], "end")) return last;
      if (word_is(w[0], "ret")) {
        snprintf(at + strlen(at), atn - strlen(at), ".ret");
        return p;
      }
      if (seen == node) {
        snprintf(at + strlen(at), atn - strlen(at), ".%.*s", (int)w[0].n, w[0].p);
        return p;
      }
      seen++;
      last = p;
    }
    p = pe + 1;
  }
  return last;
}

/* -- one chunk -- */

static Buf chunk_text;
static uint32_t *stub_list;
static uint32_t *stub_mark;
static uint32_t stub_stamp;
static Buf lines_out;
static bool want_lines;

static void give_up(const char *why) {
  fprintf(stderr, "a0: %s: native check unsupported (%s); use the TypeScript checker\n", entry_abs,
          why);
  exit(65);
}

/* The stubs [out list, sorted] the own units [ua,ub) need, and their header lines. */
static uint32_t collect_stubs(uint32_t ua, uint32_t ub) {
  uint32_t n = 0;
  stub_stamp++;
  for (uint32_t u = ua; u < ub; u++) {
    const Unit *x = &units[u];
    for (size_t p = x->hb; p < x->b;) {
      char *nl = memchr(joined + p, '\n', x->b - p);
      size_t pe = nl == NULL ? x->b : (size_t)(nl - joined);
      const char *b, *e;
      clean_line(joined + p, joined + pe, &b, &e);
      Word w[4];
      int k = words_of(b, e, w, 4);
      int names = 0;
      if (k >= 3 && (word_is(w[1], "call") || word_is(w[1], "fold"))) names = 1;
      if (k >= 4 && word_is(w[1], "loop")) names = 2;
      for (int j = 0; j < names; j++) {
        int d = find_unit(w[2 + j].p, w[2 + j].n);
        if (d >= 0 && (uint32_t)d < ua && stub_mark[d] != stub_stamp) {
          stub_mark[d] = stub_stamp;
          stub_list[n++] = (uint32_t)d;
        }
      }
      p = pe + 1;
    }
  }
  /* sorted: a plain insertion sort (a chunk has a few hundred stubs at most) */
  for (uint32_t i = 1; i < n; i++) {
    uint32_t v = stub_list[i], j = i;
    while (j > 0 && stub_list[j - 1] > v) {
      stub_list[j] = stub_list[j - 1];
      j--;
    }
    stub_list[j] = v;
  }
  return n;
}

/* The type of the type table entry t, as src/core.ts formatType writes it. */
static void fmt_type(Buf *b, const uint32_t *ty, const uint32_t *tl, uint32_t t) {
  uint32_t tag = ty[3 * t], x = ty[3 * t + 1], y = ty[3 * t + 2];
  if (tag == 1) bputs(b, "u32");
  else if (tag == 2) bputs(b, "bool");
  else if (tag == 3) bputs(b, "io");
  else if (tag == 4) {
    fmt_type(b, ty, tl, y);
    bputs(b, "x");
    bnum(b, x);
  } else {
    bputs(b, "(");
    for (uint32_t k = 0; k < y; k++) {
      if (k > 0) bputs(b, ",");
      fmt_type(b, ty, tl, tl[x + k]);
    }
    bputs(b, ")");
  }
}

static const char *const OPS[] = {"",    "mov",  "add",  "sub",  "mul",  "and",  "or",   "xor",
                                  "shl", "shr",  "div",  "rem",  "eq",   "ne",   "lt",   "le",
                                  "gt",  "ge",   "select", "call", "fold", "loop", "arr", "rec",
                                  "text", "get", "set",  "at",   "put",  "read", "write", "puts",
                                  "cadd", "csub", "cmul", "cdiv", "crem", "cget"};

typedef struct {
  const uint32_t *ty, *tl, *pool, *sym, *fnw, *nodew, *argw;
} Tables;

/* Symbol s: sym 0 is the id of an inline `ret OP` node; the others are (start, length) in the chunk's
   source (chunkio writes them so: no pool is built), whose bytes are io.input[1..]. */
static void put_sym(Buf *b, const Tables *t, uint32_t s) {
  if (s == 0) {
    bputs(b, "retval");
    return;
  }
  uint32_t start = t->sym[2 * s], len = t->sym[2 * s + 1];
  for (uint32_t k = 0; k < len; k++) {
    char c = (char)t->pool[start + k];
    bput(b, &c, 1);
  }
}

static void put_operand(Buf *b, const Tables *t, uint32_t nfirst, uint32_t kind, uint32_t v) {
  if (kind == 1) put_sym(b, t, t->nodew[6 * (nfirst + v)]);
  else if (kind == 2) {
    bputs(b, "p");
    bnum(b, v);
  } else if (kind == 3) bnum(b, v);
  else bputs(b, v ? "true" : "false");
}

/* The line of `a0 check` for function i of the tables: name (params) -> result: N nodes, rev H. */
static void fn_line(Buf *out, const Tables *t, uint32_t i, const char *prefix) {
  const uint32_t *w = t->fnw + 7 * i;
  uint32_t nparams = w[1], tfirst = w[2], result = w[3], nfirst = w[4], nn = w[5], ret = w[6];
  Buf c = {0};
  /* the canonical form: src/core.ts formatFunction */
  bputs(&c, "fn ");
  put_sym(&c, t, w[0]);
  for (uint32_t k = 0; k < nparams; k++) {
    bputs(&c, " ");
    fmt_type(&c, t->ty, t->tl, t->tl[tfirst + k]);
  }
  bputs(&c, " -> ");
  fmt_type(&c, t->ty, t->tl, result);
  bputs(&c, "\n");
  for (uint32_t j = 0; j < nn; j++) {
    const uint32_t *nd = t->nodew + 6 * (nfirst + j);
    put_sym(&c, t, nd[0]);
    if (nd[1] == 24) {
      bputs(&c, " text \"");
      for (uint32_t k = 0; k < nd[2]; k++) {
        uint32_t byte = t->argw[2 * (nd[3] + k) + 1];
        char ch = (char)byte;
        if (ch == '\\') bputs(&c, "\\\\");
        else if (ch == '"') bputs(&c, "\\\"");
        else if (ch == '\n') bputs(&c, "\\n");
        else if (ch == '\t') bputs(&c, "\\t");
        else bput(&c, &ch, 1);
      }
      bputs(&c, "\"\n");
      continue;
    }
    bputs(&c, " ");
    bputs(&c, nd[1] < sizeof OPS / sizeof OPS[0] ? OPS[nd[1]] : "?");
    if (nd[1] == 21) {
      bputs(&c, " ");
      put_sym(&c, t, t->fnw[7 * nd[5]]);
    }
    if (nd[1] == 19 || nd[1] == 20 || nd[1] == 21) {
      bputs(&c, " ");
      put_sym(&c, t, t->fnw[7 * nd[4]]);
    }
    for (uint32_t k = 0; k < nd[2]; k++) {
      bputs(&c, " ");
      put_operand(&c, t, nfirst, t->argw[2 * (nd[3] + k)], t->argw[2 * (nd[3] + k) + 1]);
    }
    bputs(&c, "\n");
  }
  uint32_t rk = ret >> 28, rv = ret & 0x0fffffffu;
  if (rk == 5) {
    rk = t->argw[2 * rv];
    rv = t->argw[2 * rv + 1];
  }
  bputs(&c, "ret ");
  put_operand(&c, t, nfirst, rk, rv);
  bputs(&c, "\nend");
  char hex[13];
  sha256_hex12((const uint8_t *)c.p, c.n, hex);
  free(c.p);
  bputs(out, prefix);
  put_sym(out, t, w[0]);
  bputs(out, " (");
  for (uint32_t k = 0; k < nparams; k++) {
    if (k > 0) bputs(out, ", ");
    fmt_type(out, t->ty, t->tl, t->tl[tfirst + k]);
  }
  bputs(out, ") -> ");
  fmt_type(out, t->ty, t->tl, result);
  bputs(out, ": ");
  bnum(out, nn);
  bputs(out, " nodes, rev ");
  bputs(out, hex);
  bputs(out, "\n");
}

/* Check the own units [ua,ub) as one chunk; returns true when a parse-phase error ends the run. */
static bool run_chunk(uint32_t ua, uint32_t ub) {
  uint32_t ns = collect_stubs(ua, ub);
  chunk_text.n = 0;
  if (chunk_text.p != NULL) chunk_text.p[0] = '\0';
  for (uint32_t i = 0; i < ns; i++) {
    const Unit *s = &units[stub_list[i]];
    bput(&chunk_text, joined + s->ha, s->hb - s->ha);
    bputs(&chunk_text, "\nret 0\nend\n");
  }
  size_t stub_bytes = chunk_text.n;
  size_t own_a = ua < ub ? units[ua].a : 0, own_b = ua < ub ? units[ub - 1].b : jlen;
  bput(&chunk_text, joined + own_a, own_b - own_a);
  size_t n = chunk_text.n;
  if (n > SRC_LIMIT) {
    if (ub - ua > 1) {
      uint32_t mid = ua + (ub - ua) / 2;
      return run_chunk(ua, mid) || run_chunk(mid, ub);
    }
    give_up("one function over a front end capacity");
  }
  if (getenv("A0_CHUNK_TRACE") != NULL)
    fprintf(stderr, "chunk %u..%u: %zu bytes, %u stubs\n", ua, ub, n, ns);
  for (size_t i = 0; i < n; i++) io.input[1 + i] = (unsigned char)chunk_text.p[i];
  io.input[0] = (uint32_t)n;
  io.input[n + 1] = ns;
  for (uint32_t i = 0; i < ns; i++) io.input[n + 2 + i] = units[stub_list[i]].bound;
  io.ninput = (uint32_t)n + 2u + ns;
  io.position = 0;
  io.noutput = 0;
#ifdef A0_PROFILE
  double t_chunk = now_us();
#endif
  uint32_t code = a0_chunkio(&io);
#ifdef A0_PROFILE
  fprintf(stderr, "  chunk %u..%u: %zu bytes, %u stubs, %.0f us\n", ua, ub, n, ns, now_us() - t_chunk);
#endif
  uint32_t fn = io.output[2], node = io.output[3], tokstart = io.output[4], nhc = io.output[5];
  if (code == 4u && fn == NO_FN) {
    if (ub - ua > 1) {
      uint32_t mid = ua + (ub - ua) / 2;
      return run_chunk(ua, mid) || run_chunk(mid, ub);
    }
    give_up("one function over a front end capacity");
  }
  if (code != 0u && fn == NO_FN) {
    /* parse phase: the first such error in program order ends the check */
    if (tokstart < stub_bytes) give_up("a diagnostic inside a stub");
    first_parse.set = true;
    first_parse.code = code;
    first_parse.fn = NO_FN;
    first_parse.node = node;
    first_parse.token = node;
    first_parse.off = own_a + (tokstart - stub_bytes);
    return true;
  }
  if (code != 0u) {
    if (!first_check.set) {
      first_check.set = true;
      first_check.code = code;
      first_check.fn = ua + (fn - ns);
      first_check.node = node;
      first_check.off = node_line(ua + (fn - ns), node, first_check.at, sizeof first_check.at);
    }
    return false;
  }
  /* checked: keep the iteration bounds of the own functions, and the lines of `a0 check` */
  const uint32_t *fst = io.output + 6;
  for (uint32_t k = ns; k < nhc; k++)
    if (ua + (k - ns) < nunits) units[ua + (k - ns)].bound = fst[k];
  if (want_lines && !first_check.set) {
    uint32_t pos = 6 + nhc, cnt;
    Tables t;
    t.ty = table(&pos, &cnt);
    t.tl = table(&pos, &cnt);
    table(&pos, &cnt); /* the node types */
    t.pool = io.input + 1;
    t.sym = table(&pos, &cnt);
    t.fnw = table(&pos, &cnt);
    t.nodew = table(&pos, &cnt);
    t.argw = table(&pos, &cnt);
    for (uint32_t k = ns; k < nhc; k++) fn_line(&lines_out, &t, k, "");
  }
  return false;
}

static int cmd_check(const char *file, bool lines) {
  want_lines = lines;
  link_entry(file);
  size_t n = 0;
  for (int i = 0; i < nfiles; i++) {
    if (files[i].len > MAX_SOURCE_BYTES) give_up("a file over 1 MiB");
    n += files[i].len + (i > 0 ? 1 : 0);
  }
  if (n > MAX_SOURCE_BYTES) give_up("a linked program over 1 MiB");
  joined = malloc(n + 1);
  jlen = 0;
  for (int i = 0; i < nfiles; i++) {
    if (i > 0) joined[jlen++] = '\n';
    file_off[i] = jlen;
    memcpy(joined + jlen, files[i].text, files[i].len);
    jlen += files[i].len;
  }
  joined[jlen] = '\0';
  for (size_t p = 0; p < jlen;) {
    char *nl = memchr(joined + p, '\n', jlen - p);
    size_t pe = nl == NULL ? jlen : (size_t)(nl - joined);
    const char *b, *e;
    clean_line(joined + p, joined + pe, &b, &e);
    Word w[1];
    if (words_of(b, e, w, 1) == 1 && word_is(w[0], "profile")) give_up("a profile line");
    p = pe + 1;
  }
  cut_units();
  pre_detect();
  stub_list = malloc((nunits + 1) * sizeof *stub_list);
  stub_mark = calloc(nunits + 1, sizeof *stub_mark);
  /* the plan: consecutive units while a chunk stays under the margins */
  if (nunits == 0) run_chunk(0, 0);
  else {
    uint32_t ua = 0;
    bool stop = false;
    while (ua < nunits && !stop) {
      uint32_t ub = ua;
      size_t bytes = 0;
      uint32_t toks = 0, nodes = 0, fns = 0;
      while (ub < nunits) {
        const Unit *x = &units[ub];
        size_t b2 = bytes + (x->b - x->a);
        uint32_t t2 = toks + x->toks, n2 = nodes + x->nodes, f2 = fns + 1;
        if (!plan_whole && ub > ua &&
            (b2 > plan_bytes || t2 > CHUNK_TOKENS || n2 > CHUNK_NODES || f2 > CHUNK_FNS))
          break;
        bytes = b2;
        toks = t2;
        nodes = n2;
        fns = f2;
        ub++;
      }
      /* the stubs the chunk needs weigh on the margins too: shrink while they overflow */
      for (;;) {
        uint32_t ns = collect_stubs(ua, ub);
        if (!plan_whole && ub - ua > 1 &&
            (bytes + (size_t)ns * 96 > plan_bytes + 6000 || toks + ns * 16 > CHUNK_TOKENS + 800 ||
             fns + ns > CHUNK_FNS + 40)) {
          ub--;
          const Unit *x = &units[ub];
          bytes -= x->b - x->a;
          toks -= x->toks;
          nodes -= x->nodes;
          fns--;
        } else break;
      }
      if (run_chunk(ua, ub)) stop = true;
      /* the chunk that holds the pre-detected error is the last that matters */
      if (pre.set && pre.off < units[ub - 1].b) stop = true;
      ua = ub;
    }
  }
  const Diag *d = NULL;
  if (first_parse.set && (!pre.set || first_parse.off < pre.off)) d = &first_parse;
  else if (pre.set) d = &pre;
  else if (first_check.set) d = &first_check;
  if (d == NULL) {
    if (want_lines) fputs(lines_out.p == NULL ? "" : lines_out.p, stdout);
    else puts("ok");
    return 0;
  }
  const char *path;
  uint32_t line;
  line_of(d->off, &path, &line);
  const char *kind = d->code < 5u ? KINDS[d->code] : "unknown";
  if (d->fn == NO_FN)
    fprintf(stderr, "%s: %s error %u at token %u (%s:%u)\n", file, kind, d->code, d->token, path,
            line);
  else {
    fprintf(stderr, "%s: %s error %u in function %u at node %u (%s:%u)\n", file, kind, d->code,
            d->fn, d->node, path, line);
    fprintf(stderr, "a0-at: %s\n", d->at);
  }
  if (d == &first_parse && (d->code == 1u || d->code == 2u)) suggest(d->token);
  return (int)d->code;
}

static void usage(void) {
  fputs("usage:\n  a0 check [--lines] [--chunk-bytes=N] <file.a0>\n  a0 run <file.a0> <function> <args...>\n"
        "  a0 bench <file.a0> <function> <iterations>\n  a0 calls <file.a0>   # calls on stdin\n",
        stderr);
  exit(64);
}

int main(int argc, char **argv) {
#ifdef A0_PROFILE
  last_ = now_us();
#endif
#ifdef _WIN32
  /* the output is bytes, not text: no LF to CRLF */
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stderr), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
#endif
  if (argc < 3) usage();
  const char *cmd = argv[1], *file = argv[2];
  if (strcmp(cmd, "check") == 0) {
    /* options, then the file: --lines, --chunk-bytes=N (see plan_bytes) */
    bool lines = false;
    int i = 2;
    for (; i < argc - 1; i++) {
      if (strcmp(argv[i], "--lines") == 0) lines = true;
      else if (strncmp(argv[i], "--chunk-bytes=", 14) == 0) {
        char *end = NULL;
        unsigned long v = strtoul(argv[i] + 14, &end, 10);
        if (argv[i][14] == '\0' || *end != '\0' || v > (1ul << 30)) usage();
        plan_whole = v == 0;
        plan_bytes = (size_t)v;
      } else usage();
    }
    if (i != argc - 1) usage();
    return cmd_check(argv[argc - 1], lines);
  }
  if (strcmp(cmd, "run") == 0 && argc >= 4) return cmd_run(file, argv[3], argc - 4, argv + 4);
  if (strcmp(cmd, "bench") == 0 && argc == 5) return cmd_bench(file, argv[3], argv[4]);
  if (strcmp(cmd, "calls") == 0 && argc == 3) return cmd_calls(file);
  usage();
  return 64;
}
