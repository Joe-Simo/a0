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
 * files joined with a newline. The joined text must fit the front end's 16384 bytes.
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
    strcpy(dir, up);
  }
}

static bool inside_root(const char *abs) {
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
  char abs[PATH_MAX];
  if (realpath(path, abs) == NULL) die(64, "cannot read %s", path);
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

/* The linked source into the front end's input: n, then the n bytes. */
static void load(const char *entry) {
  char abs[PATH_MAX];
  if (realpath(entry, abs) == NULL) die(64, "cannot read %s", entry);
  project_root(abs);
  visit(abs, entry);
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

/* Report the front end's diagnostic (output words 1..3) and return its code. */
static int diagnose(const char *file, uint32_t code) {
  if (code == 0) return 0;
  const char *kind = code < 5u ? KINDS[code] : "unknown";
  if (io.output[2] == 0xffffffffu)
    fprintf(stderr, "%s: %s error %u at token %u\n", file, kind, code, io.output[3]);
  else
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

static uint32_t front(const char *file, bool ir) {
  load(file);
  uint32_t code = ir ? a0_irio(&io) : a0_checkio(&io);
  if (code == 0 && ir) build();
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

static void usage(void) {
  fputs("usage:\n  a0 check <file.a0>\n  a0 run <file.a0> <function> <args...>\n"
        "  a0 bench <file.a0> <function> <iterations>\n  a0 calls <file.a0>   # calls on stdin\n",
        stderr);
  exit(64);
}

int main(int argc, char **argv) {
  if (argc < 3) usage();
  const char *cmd = argv[1], *file = argv[2];
  if (strcmp(cmd, "check") == 0 && argc == 3) {
    uint32_t code = front(file, false);
    if (code == 0) {
      puts("ok");
      return 0;
    }
    return diagnose(file, code);
  }
  if (strcmp(cmd, "run") == 0 && argc >= 4) return cmd_run(file, argv[3], argc - 4, argv + 4);
  if (strcmp(cmd, "bench") == 0 && argc == 5) return cmd_bench(file, argv[3], argv[4]);
  if (strcmp(cmd, "calls") == 0 && argc == 3) return cmd_calls(file);
  usage();
  return 64;
}
