/**
 * The strict profile on the direct native backends (riscv64, arm32, avr): one runtime record and
 * its host contract, shared by the three code generators.
 *
 * A function that can trap (`mayTrapFn`) keeps a frame on a shadow stack, exactly as the C and
 * wasm runtimes do: on entry it pushes its name, a fold or loop whose body can trap names its
 * node and each trip in the frame, and every exit pops it. A node that can trap carries an
 * inline check; a failed check jumps to a module-local stub that records the kind and the top
 * of the stack and hands control to the host symbol `A0_trap`, which never returns. The
 * interpreter's trap line is `kind`, the innermost frame, the innermost marked frame and the
 * whole chain, so the record carries exactly those fields.
 *
 * The runtime symbols use an uppercase `A0_` prefix: A0 function names are lowercase, so no
 * function symbol (`a0_<name>`) can collide with them.
 *
 * - riscv64 and arm32: the frame is `{fn, node, trip}` with `fn` and `node` pointers to
 *   NUL-terminated names in the module's read-only data (`struct A0_frame` below, natural C
 *   layout: 24 bytes on RV64, 12 on ARM32). `A0_frames` is the array, `A0_trap_end` points one
 *   past the innermost frame at the trap, `A0_trap_kind` is a pointer to the kind's name.
 *   `nativeTrapHostC` is a reference host that prints the interpreter's line and exits 3.
 * - avr: there are no strings (flash is the budget). The frame is seven bytes in SRAM: the word
 *   address of the function (`gs(a0_<name>)`, the value a C function pointer has), a node ordinal
 *   (0 none, else 1 + the index among the function's marked folds and loops, `trapNodes`) and the
 *   trip as a little-endian u32. `A0_frames` is the array, `A0_trap_end` is the byte address one
 *   past the innermost frame, and the stub passes the kind (0 bounds, 1 divzero) in r24 to `A0_trap`.
 */

import type { Node, TypedFunc, TypedProgram } from './core.js';
import { formatTrap, TRAP_FIX, type Trap } from './diagnostics.js';
import { callTraps, mayTrapFn } from './optimize.js';

/** The strict traps the native backends can raise, in the order of their kind codes. */
export const NATIVE_TRAP_KINDS = ['bounds', 'divzero'] as const;
export type NativeTrapKind = (typeof NATIVE_TRAP_KINDS)[number];

/** Does any function of `program` keep a frame (so the module needs the runtime)? */
export const programTraps = (program: Pick<TypedProgram, 'functions'>): boolean =>
  program.functions.some(mayTrapFn);

/**
 * The frame capacity of a module: one frame per function that keeps one. A chain never repeats a
 * function (A0 has no recursion), so no call is deeper than that. `bodies` are the emitted
 * functions, each framed one carrying its name label (`nativeNameData`) or, on avr, its enter call.
 */
export const frameCapacity = (bodies: readonly string[]): number =>
  bodies.filter((b) => b.includes('.LA0N_') || b.includes('call __a0_enter')).length;

/** The folds and loops of `fn` that name `at`/`trip` of a trap: those whose body can trap. */
export function trapNodes(fn: TypedFunc): Node[] {
  return fn.nodes.filter((n) => (n.op === 'fold' || n.op === 'loop') && callTraps(fn, n));
}

const asmString = (s: string): string => `\t.asciz "${s}"`;

/** The read-only name strings one function's frame refers to (labels are file-local). */
export function nativeNameData(fn: TypedFunc): string[] {
  return [
    `.LA0N_${fn.name}:`,
    asmString(fn.name),
    ...trapNodes(fn).flatMap((n) => [`.LA0D_${fn.name}_${n.id}:`, asmString(n.id)]),
  ];
}

/**
 * The C host contract and a reference host: the interpreter's line, then exit 3.
 * With the exact linked program, storage is derived from its names without a heap dependency.
 * Otherwise the host retains a growable buffer, including across A0_TRAP_EXIT longjmp hooks.
 * A0_TRAP_EMIT overrides own their I/O error handling; the default checks stderr writes/flushes.
 */
export function nativeTrapHostC(program?: Pick<TypedProgram, 'functions'>): string {
  const fixes = NATIVE_TRAP_KINDS.map((k) => JSON.stringify(TRAP_FIX[k])).join(', ');
  const kinds = NATIVE_TRAP_KINDS.map((k) => JSON.stringify(k)).join(', ');
  let storage: string;
  if (program === undefined) {
    storage = `#include <stdlib.h>
static char *A0_storage;
static size_t A0_capacity;
static char *A0_reserve(size_t need) {
  if (need > A0_capacity) {
    char *next = (char *)realloc(A0_storage, need);
    if (!next) return 0;
    A0_storage = next;
    A0_capacity = need;
  }
  return A0_storage;
}`;
  } else {
    // A0 chains never repeat a function. Include every function/node, independently of framing
    // optimizations. Identifiers are ASCII; all punctuation, the u32 trip and NUL are included.
    let names = 0,
      maxFn = 1,
      maxNode = 0;
    for (const fn of program.functions) {
      names += fn.name.length;
      maxFn = Math.max(maxFn, fn.name.length);
      for (const node of fn.nodes) maxNode = Math.max(maxNode, node.id.length);
    }
    const maxKind = Math.max(...NATIVE_TRAP_KINDS.map((kind) => kind.length));
    const maxFix = Math.max(...NATIVE_TRAP_KINDS.map((kind) => TRAP_FIX[kind].length));
    const capacity =
      'runtime: trap '.length +
      maxKind +
      ' fn='.length +
      maxFn +
      ' at='.length +
      Math.max('- trip=-'.length, maxFn + 1 + maxNode + ' trip='.length + 10) +
      ' chain='.length +
      names +
      Math.max(0, program.functions.length - 1) +
      ' fix: '.length +
      maxFix +
      1;
    if (!Number.isSafeInteger(capacity)) throw new RangeError('native trap text size overflow');
    storage = `static char A0_storage[${capacity}u];
static char *A0_reserve(size_t need) {
  return need <= sizeof A0_storage ? A0_storage : 0;
}`;
  }
  return `/* A0 strict profile host for the direct native targets: A0_trap is called by the module's trap
 * stub with the record in A0_frames / A0_trap_end / A0_trap_kind and never returns. This one writes
 * the interpreter's trap line (A0_TRAP_EMIT, default stderr) and exits 3 (A0_TRAP_EXIT).
 * Record pointers/names are compiler-owned. This host adds no concurrent-trap guarantee. */
#include <stddef.h>
struct A0_frame { const char *fn; const char *node; uint32_t trip; };
extern struct A0_frame A0_frames[];
extern const struct A0_frame *A0_trap_end;
extern const char *A0_trap_kind;
static const char *a0_trapbuf;
${storage}
struct A0_line { char *data; size_t length; size_t capacity; int failed; };
static void A0_putc(struct A0_line *o, char c) {
  if (o->failed) return;
  if (o->length == o->capacity) { o->failed = 1; return; }
  if (o->data) o->data[o->length] = c;
  o->length++;
}
static struct A0_line *A0_put(struct A0_line *o, const char *s) {
  while (*s && !o->failed) A0_putc(o, *s++);
  return o;
}
static int A0_same(const char *a, const char *b) { while (*a && *a == *b) { a++; b++; } return *a == *b; }
static void A0_putu(struct A0_line *o, uint32_t v) {
  char b[10]; int k = 0;
  do { b[k++] = (char)('0' + v % 10u); v /= 10u; } while (v);
  while (k) A0_putc(o, b[--k]);
}
#ifndef A0_TRAP_EXIT
#define A0_TRAP_EXIT() exit(3)
#endif
#ifndef A0_TRAP_EMIT
#define A0_TRAP_EMIT(line) do { if (fprintf(stderr, "%s\\n", (line)) < 0 || fflush(stderr) != 0) { A0_TRAP_EXIT(); for (;;) {} } } while (0)
#endif
static void A0_report_failed(const char *line) {
  a0_trapbuf = line;
  A0_TRAP_EMIT(a0_trapbuf);
  A0_TRAP_EXIT();
  for (;;) {}
}
static void A0_render(struct A0_line *o, size_t n, const struct A0_frame *at, const char *kind, const char *fix) {
  A0_put(A0_put(o, "runtime: trap "), kind);
  A0_put(A0_put(o, " fn="), n > 0u ? A0_frames[n - 1u].fn : "-");
  A0_put(o, " at=");
  if (at) { A0_put(o, at->fn); A0_putc(o, '.'); A0_put(o, at->node); A0_put(o, " trip="); A0_putu(o, at->trip); }
  else A0_put(o, "- trip=-");
  A0_put(o, " chain=");
  for (size_t k = 0u; k < n && !o->failed; k++) { if (k) A0_putc(o, '>'); A0_put(o, A0_frames[k].fn); }
  A0_put(A0_put(o, " fix: "), fix);
  A0_putc(o, 0);
}
void A0_trap(void);
void A0_trap(void) {
  static const char *const kinds[] = { ${kinds} };
  static const char *const fixes[] = { ${fixes} };
  const size_t n = (size_t)(A0_trap_end - A0_frames);
  uint32_t kind = 0;
  while (kind < ${NATIVE_TRAP_KINDS.length}u - 1u && !A0_same(A0_trap_kind, kinds[kind])) kind++;
  const struct A0_frame *at = 0;
  for (size_t k = n; k-- > 0u;) if (A0_frames[k].node) { at = &A0_frames[k]; break; }
  struct A0_line count = { 0, 0, (size_t)-1, 0 };
  A0_render(&count, n, at, kinds[kind], fixes[kind]);
  if (count.failed) A0_report_failed("runtime: trap reporting failed: text size overflow");
  char *line = A0_reserve(count.length);
  if (!line) A0_report_failed("runtime: trap reporting failed: storage unavailable");
  struct A0_line out = { line, 0, count.length, 0 };
  A0_render(&out, n, at, kinds[kind], fixes[kind]);
  if (out.failed || out.length != count.length) A0_report_failed("runtime: trap reporting failed: record changed");
  a0_trapbuf = line;
  A0_TRAP_EMIT(a0_trapbuf);
  A0_TRAP_EXIT();
  for (;;) {}
}
`;
}

/**
 * Decode one firmware trap record `T <kind> <n> (<word address> <node ordinal> <trip>)*` (decimal
 * words, as the AVR test firmware writes them) into the interpreter's trap line, with
 * `trap: ` in front. `functions` maps a function's word address to its name; `nodesOf` gives
 * the names `avrTrapNodes` numbers.
 */
export function decodeAvrTrap(
  record: string,
  functions: ReadonlyMap<number, string>,
  nodesOf: (fn: string) => readonly string[],
): string {
  const w = record.trim().split(/\s+/).slice(1).map(Number);
  const kind = NATIVE_TRAP_KINDS[w[0] as number];
  const n = w[1] as number;
  const frames = Array.from({ length: n }, (_, k) => ({
    fn: functions.get(w[2 + 3 * k] as number) ?? `?${String(w[2 + 3 * k])}`,
    node: w[3 + 3 * k] as number,
    trip: w[4 + 3 * k] as number,
  }));
  const top = frames[n - 1];
  const marked = [...frames].reverse().find((f) => f.node !== 0);
  const trap: Trap = {
    kind: kind ?? 'bounds',
    fn: top?.fn ?? '-',
    at: marked === undefined ? null : `${marked.fn}.${nodesOf(marked.fn)[marked.node - 1] ?? '?'}`,
    trip: marked === undefined ? null : marked.trip,
    chain: frames.map((f) => f.fn),
  };
  return `trap: ${formatTrap(trap)}`;
}
