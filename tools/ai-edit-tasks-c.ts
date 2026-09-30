/**
 * Task set C for the AI-edit experiment: "project scale".
 *
 * The twelve set-B tasks, unchanged in instruction, tests, and reference edit, but each
 * target function lives inside one deterministic 40-function program that is identical
 * for every task (the other 39 functions are filler the tests never call). The three
 * representations carry the same 40 functions under the same names, in the same order:
 * the set-A and set-B task functions, six functions from examples/life.a0, one from
 * examples/kernels.a0, and hand translations for every A0 fold helper that the original
 * TypeScript and Rust sources inlined (they are exported as ordinary functions).
 *
 * Protocol asymmetry (also recorded in the report's `method` field): `conventional`
 * sends the whole file in every representation. `structured` sends for A0 the
 * dependency-scoped view of the target function (its body plus one signature line per
 * callee) and the program handle (one signature line per function); for TypeScript and
 * Rust it sends the whole numbered file with the line-edit protocol, because locating
 * the function inside the file is part of the job, exactly as it is for an agent editing
 * a real file. No language-agnostic per-function view exists for TypeScript or Rust in
 * this harness; the asymmetry is the object of measurement, not a confound.
 */

import { formatFunction, parseAndValidate } from '../src/core.js';
import {
  fillerText,
  LANG_B,
  LANG_PROJECT_FILLER,
  LANGS,
  type Lang,
  langFile,
  splitLang,
} from './ai-edit-langs.js';
import type { Task } from './ai-edit-tasks-b.js';

type Representation = 'a0' | 'ts' | 'rust';

/** Definition order of the 40 functions; every callee precedes its callers. */
export const PROJECT_ORDER: readonly string[] = [
  'affine',
  'is_even',
  'fits',
  'clamp',
  'addi',
  'sumfrom',
  'rotl',
  'rot8',
  'sq',
  'quad',
  'onlyone',
  'absdiff',
  'nb',
  'count',
  'avgfloor',
  'combine4',
  'addel',
  'sumsq',
  'min2',
  'sumto',
  'inrange',
  'inc',
  'below',
  'countup',
  'minmax',
  'bounds',
  'pick',
  'bitstep',
  'popcount',
  'mixel',
  'checksum',
  'byte1',
  'dstep',
  'dot',
  'sadd',
  'rowpop',
  'population',
  'limit',
  'pstep',
  'popcnt',
];

// --- Functions that exist only as A0 fold helpers in sets A/B, or come from examples/ ----

const EXTRA_A0 = `fn is_even u32 -> bool
m and p0 1
z eq m 0
ret z
end
fn nb u32x32 u32 u32 -> u32
row get p0 p1
bit shr row p2
one and bit 1
ret one
end
fn count u32x32 u32 u32 -> u32
ru sub p1 1
rd add p1 1
cl sub p2 1
cr add p2 1
a call nb p0 ru cl
b call nb p0 ru p2
c call nb p0 ru cr
d call nb p0 p1 cl
e call nb p0 p1 cr
f call nb p0 rd cl
g call nb p0 rd p2
h call nb p0 rd cr
s1 add a b
s2 add s1 c
s3 add s2 d
s4 add s3 e
s5 add s4 f
s6 add s5 g
s7 add s6 h
ret s7
end
fn bitstep u32 u32 u32 -> u32
b shr p2 p1
one and b 1
s add p0 one
ret s
end
fn popcount u32 -> u32
n fold bitstep 32 0 p0
ret n
end
fn rowpop u32 u32 u32x32 -> u32
row get p2 p1
n call popcount row
s add p0 n
ret s
end
fn population u32x32 -> u32
n fold rowpop 32 0 p0
ret n
end
`;

const EXTRA_TS = `export function is_even(x: number): boolean {
  return (x & 1) === 0;
}
export function addi(acc: number, i: number): number {
  return (acc + i) >>> 0;
}
export function inc(s: number, i: number, limit: number): number {
  return (s + 1) >>> 0;
}
export function below(s: number, i: number, limit: number): boolean {
  return s < limit;
}
export function addel(acc: number, i: number, a: number[]): number {
  return (acc + a[i % 4]!) >>> 0;
}
export function minmax(acc: readonly [number, number], i: number, a: number[]): [number, number] {
  const lo = acc[0];
  const hi = acc[1];
  const x = a[i % 4]!;
  const nlo = x < lo ? x : lo;
  const nhi = x < hi ? x : hi;
  return [nlo, nhi];
}
export function mixel(acc: number, i: number, a: number[]): number {
  return (acc ^ a[i % 4]!) >>> 0;
}
export function dstep(acc: number, i: number, a: number[], b: number[]): number {
  return (acc + Math.imul(a[i % 4]!, b[i % 4]!)) >>> 0;
}
export function pstep(acc: number, i: number, x: number): number {
  return (acc + ((x >>> (i & 31)) & 1)) >>> 0;
}
export function nb(grid: number[], r: number, c: number): number {
  const row = grid[r % 32]!;
  return (row >>> (c & 31)) & 1;
}
export function count(grid: number[], r: number, c: number): number {
  const ru = (r - 1) >>> 0;
  const rd = (r + 1) >>> 0;
  const cl = (c - 1) >>> 0;
  const cr = (c + 1) >>> 0;
  let s = nb(grid, ru, cl);
  s = (s + nb(grid, ru, c)) >>> 0;
  s = (s + nb(grid, ru, cr)) >>> 0;
  s = (s + nb(grid, r, cl)) >>> 0;
  s = (s + nb(grid, r, cr)) >>> 0;
  s = (s + nb(grid, rd, cl)) >>> 0;
  s = (s + nb(grid, rd, c)) >>> 0;
  s = (s + nb(grid, rd, cr)) >>> 0;
  return s;
}
export function bitstep(acc: number, i: number, x: number): number {
  return (acc + ((x >>> (i & 31)) & 1)) >>> 0;
}
export function popcount(x: number): number {
  let n = 0;
  for (let i = 0; i < 32; i++) n = bitstep(n, i, x);
  return n;
}
export function rowpop(acc: number, i: number, grid: number[]): number {
  return (acc + popcount(grid[i % 32]!)) >>> 0;
}
export function population(grid: number[]): number {
  let n = 0;
  for (let i = 0; i < 32; i++) n = rowpop(n, i, grid);
  return n;
}
`;

const EXTRA_RUST = `pub fn is_even(x: u32) -> bool {
    (x & 1) == 0
}
pub fn addi(acc: u32, i: u32) -> u32 {
    acc.wrapping_add(i)
}
pub fn inc(s: u32, _i: u32, _limit: u32) -> u32 {
    s.wrapping_add(1)
}
pub fn below(s: u32, _i: u32, limit: u32) -> bool {
    s < limit
}
pub fn addel(acc: u32, i: u32, a: [u32; 4]) -> u32 {
    acc.wrapping_add(a[(i % 4) as usize])
}
pub fn minmax(acc: (u32, u32), i: u32, a: [u32; 4]) -> (u32, u32) {
    let (lo, hi) = acc;
    let x = a[(i % 4) as usize];
    let nlo = if x < lo { x } else { lo };
    let nhi = if x < hi { x } else { hi };
    (nlo, nhi)
}
pub fn mixel(acc: u32, i: u32, a: [u32; 4]) -> u32 {
    acc ^ a[(i % 4) as usize]
}
pub fn dstep(acc: u32, i: u32, a: [u32; 4], b: [u32; 4]) -> u32 {
    acc.wrapping_add(a[(i % 4) as usize].wrapping_mul(b[(i % 4) as usize]))
}
pub fn pstep(acc: u32, i: u32, x: u32) -> u32 {
    acc.wrapping_add((x >> (i & 31)) & 1)
}
pub fn nb(grid: [u32; 32], r: u32, c: u32) -> u32 {
    let row = grid[(r % 32) as usize];
    (row >> (c & 31)) & 1
}
pub fn count(grid: [u32; 32], r: u32, c: u32) -> u32 {
    let ru = r.wrapping_sub(1);
    let rd = r.wrapping_add(1);
    let cl = c.wrapping_sub(1);
    let cr = c.wrapping_add(1);
    let mut s = nb(grid, ru, cl);
    s = s.wrapping_add(nb(grid, ru, c));
    s = s.wrapping_add(nb(grid, ru, cr));
    s = s.wrapping_add(nb(grid, r, cl));
    s = s.wrapping_add(nb(grid, r, cr));
    s = s.wrapping_add(nb(grid, rd, cl));
    s = s.wrapping_add(nb(grid, rd, c));
    s = s.wrapping_add(nb(grid, rd, cr));
    s
}
pub fn bitstep(acc: u32, i: u32, x: u32) -> u32 {
    acc.wrapping_add((x >> (i & 31)) & 1)
}
pub fn popcount(x: u32) -> u32 {
    let mut n: u32 = 0;
    for i in 0..32u32 {
        n = bitstep(n, i, x);
    }
    n
}
pub fn rowpop(acc: u32, i: u32, grid: [u32; 32]) -> u32 {
    acc.wrapping_add(popcount(grid[(i % 32) as usize]))
}
pub fn population(grid: [u32; 32]) -> u32 {
    let mut n: u32 = 0;
    for i in 0..32u32 {
        n = rowpop(n, i, grid);
    }
    n
}
`;

// --- Splitting and assembling ---------------------------------------------------------

/** Top-level functions of a source file, by name, each as its own text ending in a newline. */
export function splitFunctions(rep: Representation, source: string): Map<string, string> {
  const out = new Map<string, string>();
  if (rep === 'a0') {
    for (const fn of parseAndValidate(source).functions)
      out.set(fn.name, `${formatFunction(fn)}\n`);
    return out;
  }
  const head =
    rep === 'ts'
      ? /^export function ([A-Za-z_][A-Za-z0-9_]*)\b/
      : /^pub fn ([A-Za-z_][A-Za-z0-9_]*)\b/;
  let name: string | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (name !== undefined) out.set(name, `${lines.join('\n').trimEnd()}\n`);
  };
  for (const line of source.split('\n')) {
    const m = head.exec(line);
    if (m !== null) {
      flush();
      name = m[1];
      lines = [];
    }
    lines.push(line);
  }
  flush();
  return out;
}

/**
 * The project file: PROJECT_ORDER with `overrides` replacing same-name functions and any
 * new functions appended at the end (where they may call every existing function).
 */
function assemble(
  order: readonly string[],
  filler: Map<string, string>,
  overrides: Map<string, string>,
): string {
  const parts = order.map((name) => {
    const text = overrides.get(name) ?? filler.get(name);
    if (text === undefined) throw new Error(`set C: no definition of ${name}`);
    return text;
  });
  const known = new Set(order);
  for (const [name, text] of overrides) if (!known.has(name)) parts.push(text);
  return parts.join('');
}

// --- Generated filler for the scaled sets (c400, c1000) ----------------------------------

/** One generated helper in all three representations. */
export interface FillerFunction {
  readonly name: string;
  readonly arity: 1 | 2;
  readonly a0: string;
  readonly ts: string;
  readonly rust: string;
  /** Template and constants, from which the other languages' texts are emitted. */
  readonly spec:
    | { readonly template: 'lin'; readonly m: number; readonly c: number }
    | { readonly template: 'xs'; readonly s: number }
    | { readonly template: 'cap' | 'pair'; readonly c: number }
    | { readonly template: 'sum'; readonly g: string; readonly h: string }
    | { readonly template: 'mixin'; readonly g: string };
}

/**
 * `count` small helpers from six fixed templates, each a direct translation in A0,
 * TypeScript, and Rust (u32 wrapping semantics). Constants come from a fixed LCG, so the
 * output depends only on `count`. Templates 4 and 5 call earlier unary helpers only, so
 * every callee precedes its callers. Names carry a four-digit index and cannot collide
 * with the 40 project functions.
 */
export function generateFiller(count: number): FillerFunction[] {
  let seed = 0x2545f491;
  const next = (mod: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % mod;
  };
  const out: FillerFunction[] = [];
  const unary: string[] = [];
  const u = (p: string): string => `(${p}: number): number {`;
  for (let k = 0; k < count; k += 1) {
    const template = unary.length < 2 ? k % 4 : k % 6;
    const id = String(k).padStart(4, '0');
    let f: FillerFunction;
    if (template === 0) {
      const name = `lin${id}`;
      const m = 2 * next(50000) + 3;
      const c = next(100000);
      f = {
        name,
        arity: 1,
        a0: `fn ${name} u32 -> u32\na mul p0 ${m}\nb add a ${c}\nret b\nend\n`,
        ts: `export function ${name}${u('x')}\n  return (Math.imul(x, ${m}) + ${c}) >>> 0;\n}\n`,
        rust: `pub fn ${name}(x: u32) -> u32 {\n    x.wrapping_mul(${m}).wrapping_add(${c})\n}\n`,
        spec: { template: 'lin', m, c },
      };
    } else if (template === 1) {
      const name = `xs${id}`;
      const s = 1 + next(31);
      f = {
        name,
        arity: 1,
        a0: `fn ${name} u32 -> u32\na shr p0 ${s}\nb xor p0 a\nret b\nend\n`,
        ts: `export function ${name}${u('x')}\n  return (x ^ (x >>> ${s})) >>> 0;\n}\n`,
        rust: `pub fn ${name}(x: u32) -> u32 {\n    x ^ (x >> ${s})\n}\n`,
        spec: { template: 'xs', s },
      };
    } else if (template === 2) {
      const name = `cap${id}`;
      const c = 1 + next(100000);
      f = {
        name,
        arity: 1,
        a0: `fn ${name} u32 -> u32\nc lt p0 ${c}\nr select c p0 ${c}\nret r\nend\n`,
        ts: `export function ${name}${u('x')}\n  return x < ${c} ? x : ${c};\n}\n`,
        rust: `pub fn ${name}(x: u32) -> u32 {\n    if x < ${c} { x } else { ${c} }\n}\n`,
        spec: { template: 'cap', c },
      };
    } else if (template === 3) {
      const name = `pair${id}`;
      const c = next(100000);
      f = {
        name,
        arity: 2,
        a0: `fn ${name} u32 u32 -> u32\ns add p0 p1\nr xor s ${c}\nret r\nend\n`,
        ts: `export function ${name}(a: number, b: number): number {\n  return ((a + b) ^ ${c}) >>> 0;\n}\n`,
        rust: `pub fn ${name}(a: u32, b: u32) -> u32 {\n    a.wrapping_add(b) ^ ${c}\n}\n`,
        spec: { template: 'pair', c },
      };
    } else if (template === 4) {
      const name = `sum${id}`;
      const g = unary[next(unary.length)] as string;
      const h = unary[next(unary.length)] as string;
      f = {
        name,
        arity: 1,
        a0: `fn ${name} u32 -> u32\na call ${g} p0\nb call ${h} p0\nc add a b\nret c\nend\n`,
        ts: `export function ${name}${u('x')}\n  return (${g}(x) + ${h}(x)) >>> 0;\n}\n`,
        rust: `pub fn ${name}(x: u32) -> u32 {\n    ${g}(x).wrapping_add(${h}(x))\n}\n`,
        spec: { template: 'sum', g, h },
      };
    } else {
      const name = `mixin${id}`;
      const g = unary[next(unary.length)] as string;
      f = {
        name,
        arity: 2,
        a0: `fn ${name} u32 u32 -> u32\na call ${g} p0\nb xor a p1\nret b\nend\n`,
        ts: `export function ${name}(a: number, b: number): number {\n  return (${g}(a) ^ b) >>> 0;\n}\n`,
        rust: `pub fn ${name}(a: u32, b: u32) -> u32 {\n    ${g}(a) ^ b\n}\n`,
        spec: { template: 'mixin', g },
      };
    }
    out.push(f);
    if (f.arity === 1) unary.push(f.name);
  }
  return out;
}

/**
 * Definition order of a scaled program of `size` functions: the generated filler split
 * into 40 near-equal runs, one run before each project function, so the targets sit
 * throughout the file rather than at one end.
 */
export function scaledOrder(fillerNames: readonly string[]): string[] {
  const order: string[] = [];
  const n = PROJECT_ORDER.length;
  PROJECT_ORDER.forEach((name, i) => {
    const from = Math.floor((fillerNames.length * i) / n);
    const to = Math.floor((fillerNames.length * (i + 1)) / n);
    order.push(...fillerNames.slice(from, to), name);
  });
  return order;
}

function source(rep: Representation, task: Task): string {
  return rep === 'a0' ? task.a0Source : rep === 'ts' ? task.tsSource : task.rustSource;
}

function firstFunction(task: Task): string {
  const name = parseAndValidate(task.a0Source).functions[0]?.name;
  if (name === undefined) throw new Error(`set C: ${task.id} has no function`);
  return name;
}

/**
 * Builds set C from sets A and B. Filler precedence: set B, then set A, then the hand
 * translations above; every name in PROJECT_ORDER must resolve in all three
 * representations. Because the filler for a set-B name is that task's own original
 * function, the original file is the same for all twelve tasks.
 */
export function buildTasksC(
  tasksA: readonly Task[],
  tasksB: readonly Task[],
  size: number = PROJECT_ORDER.length,
): Task[] {
  if (size < PROJECT_ORDER.length)
    throw new Error(`set C: size ${size} is below the ${PROJECT_ORDER.length} project functions`);
  const generated = generateFiller(size - PROJECT_ORDER.length);
  const order =
    size === PROJECT_ORDER.length ? [...PROJECT_ORDER] : scaledOrder(generated.map((f) => f.name));
  const prefix = size === PROJECT_ORDER.length ? 'c-' : `c${size}-`;
  const filler: Record<Representation, Map<string, string>> = {
    a0: new Map(),
    ts: new Map(),
    rust: new Map(),
  };
  const extras: Record<Representation, string> = { a0: EXTRA_A0, ts: EXTRA_TS, rust: EXTRA_RUST };
  for (const rep of ['a0', 'ts', 'rust'] as const) {
    const sources = [
      ...tasksB.map((t) => source(rep, t)),
      ...tasksA.map((t) => source(rep, t)),
      extras[rep],
    ];
    for (const src of sources)
      for (const [name, text] of splitFunctions(rep, src))
        if (!filler[rep].has(name)) filler[rep].set(name, text);
    for (const f of generated) filler[rep].set(f.name, f[rep]);
  }
  const build = (rep: Representation, src: string): string =>
    assemble(order, filler[rep], splitFunctions(rep, src));
  // The five further languages: set-B originals, then the set-A originals and extras.
  const langFiller = new Map<Lang, Map<string, string>>();
  for (const lang of LANGS) {
    const m = new Map<string, string>();
    const sources = [
      ...tasksB.map((t) => LANG_B[t.id]?.[lang].source ?? ''),
      LANG_PROJECT_FILLER[lang],
    ];
    for (const src of sources)
      for (const [name, text] of splitLang(lang, src)) if (!m.has(name)) m.set(name, text);
    for (const f of generated) m.set(f.name, fillerText(lang, f));
    langFiller.set(lang, m);
  }
  const buildLang = (lang: Lang, body: string): string =>
    langFile(lang, assemble(order, langFiller.get(lang) ?? new Map(), splitLang(lang, body)));
  const langs = (task: Task): Pick<Task, 'langs'> => {
    const perTask = LANG_B[task.id];
    if (perTask === undefined) return {};
    const files = Object.fromEntries(
      LANGS.map((lang) => [
        lang,
        {
          source: buildLang(lang, perTask[lang].source),
          reference: buildLang(lang, perTask[lang].reference),
        },
      ]),
    ) as NonNullable<Task['langs']>;
    return { langs: files };
  };
  return tasksB.map((task) => ({
    ...task,
    ...langs(task),
    id: task.id.replace(/^b-/, prefix),
    target: task.target ?? firstFunction(task),
    a0Source: build('a0', task.a0Source),
    tsSource: build('ts', task.tsSource),
    rustSource: build('rust', task.rustSource),
    reference: {
      a0: build('a0', task.reference.a0),
      ts: build('ts', task.reference.ts),
      rust: build('rust', task.reference.rust),
    },
  }));
}
