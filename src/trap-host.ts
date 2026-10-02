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

/** The C host contract and a reference host: the line of the interpreter, then exit 3. */
export function nativeTrapHostC(): string {
  const fixes = NATIVE_TRAP_KINDS.map((k) => JSON.stringify(TRAP_FIX[k])).join(', ');
  const kinds = NATIVE_TRAP_KINDS.map((k) => JSON.stringify(k)).join(', ');
  return `/* A0 strict profile host for the direct native targets: A0_trap is called by the module's trap
 * stub with the record in A0_frames / A0_trap_end / A0_trap_kind and never returns. This one writes
 * the interpreter's trap line (A0_TRAP_EMIT, default stderr) and exits 3 (A0_TRAP_EXIT). */
struct A0_frame { const char *fn; const char *node; uint32_t trip; };
extern struct A0_frame A0_frames[];
extern const struct A0_frame *A0_trap_end;
extern const char *A0_trap_kind;
static char a0_trapbuf[1024];
static char *A0_put(char *o, const char *s) { while (*s) *o++ = *s++; return o; }
static int A0_same(const char *a, const char *b) { while (*a && *a == *b) { a++; b++; } return *a == *b; }
static char *A0_putu(char *o, uint32_t v) { char b[12]; int k = 0; do { b[k++] = (char)('0' + v % 10u); v /= 10u; } while (v); while (k) *o++ = b[--k]; return o; }
#ifndef A0_TRAP_EMIT
#define A0_TRAP_EMIT(line) fprintf(stderr, "%s\\n", (line))
#endif
#ifndef A0_TRAP_EXIT
#define A0_TRAP_EXIT() exit(3)
#endif
void A0_trap(void);
void A0_trap(void) {
  static const char *const kinds[] = { ${kinds} };
  static const char *const fixes[] = { ${fixes} };
  const struct A0_frame *end = A0_trap_end;
  const uint32_t n = (uint32_t)(end - A0_frames);
  uint32_t kind = 0;
  while (kind < ${NATIVE_TRAP_KINDS.length}u - 1u && !A0_same(A0_trap_kind, kinds[kind])) kind++;
  char *o = A0_put(a0_trapbuf, "runtime: trap ");
  o = A0_put(A0_put(o, kinds[kind]), " fn=");
  o = A0_put(o, n > 0u ? A0_frames[n - 1u].fn : "-");
  o = A0_put(o, " at=");
  const struct A0_frame *at = 0;
  for (uint32_t k = n; k-- > 0u;) if (A0_frames[k].node) { at = &A0_frames[k]; break; }
  if (at) { o = A0_put(o, at->fn); *o++ = '.'; o = A0_put(o, at->node); o = A0_put(o, " trip="); o = A0_putu(o, at->trip); }
  else o = A0_put(o, "- trip=-");
  o = A0_put(o, " chain=");
  for (uint32_t k = 0u; k < n; k++) { if (k) *o++ = '>'; o = A0_put(o, A0_frames[k].fn); }
  o = A0_put(A0_put(o, " fix: "), fixes[kind]);
  *o = 0;
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
