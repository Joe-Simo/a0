/**
 * Builds the sealed task set CD (tools/ai-edit-tasks-cd.ts) for the compact-dense edit-accuracy check
 * (docs/history/2026-10-09-compact-dense-edit-accuracy-preregistration.md). No author and no model: every task is
 * drawn from an in-tree `.a0` program by the fixed rule below, and checked with the reference interpreter.
 *
 * Rule, in order (fixed in the pre-registration before this tool was run):
 *   1. Programs: every `.a0` file outside dot directories, `node_modules`, `dist`, `results` and `corpus/reject`
 *      (the held-out list of tools/dense-six-rules.ts), sorted by repository-relative path with `/`. A file with a
 *      `use` line, or one that does not validate on its own, is skipped (an edit session holds one program).
 *   2. Functions: every function, in program order, whose parameters and result are all `u32`, that has at least
 *      one parameter, and whose canonical body has a statement with a decimal literal operand.
 *   3. Bug: in each such function (one task each; the program's other functions are unchanged), the first such literal L (statement order, then operand order) becomes (L + 1) mod
 *      2^32. The task program is the target and its transitive callees, in file order (the rest of a large
 *      file is not part of the task). The starting program is the mutant; the reference is the original.
 *   4. Wrong edit: the same literal as (L + 2) mod 2^32.
 *   5. Tests: argument vectors from a fixed pool (every parameter set to each of 0, 1, 2, 3, 7, 10, 100, L - 1, L,
 *      L + 1, then 24 vectors of a seeded generator, seed = FNV-1a of `path:function`), in that order, keeping a
 *      vector when the reference returns within FUEL (10^6 node evaluations, a declared bound so the draw is quick) and the vector is new; the first 10 kept vectors,
 *      but the first vector where the mutant differs is always included. Expected = the reference's result.
 *   6. Instruction: "`f` returns the wrong value: `f(args)` should be X, it is Y. Fix `f` without changing any other
 *      function." for the first vector where the mutant differs.
 *   7. Checks (as tools/ai-edit-tasks-h-gen.ts): the start fails a test, the reference passes all, the wrong edit
 *      fails one, at least 8 tests. A drawn task that fails a check is dropped (nothing is repaired by hand). A
 *      task whose id (`cd-<file base name>-<function>`) an earlier file already gave is dropped, so in-tree copies
 *      of one program (site and example copies) yield one task.
 *
 *   bun tools/ai-edit-tasks-cd-gen.ts [--write]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  formatProgram,
  parse,
  parseAndValidate,
  run,
  type TypedFunc,
  type Value,
} from '../src/core.js';

function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === 'dist' || f === 'results' || f.startsWith('.')) continue;
    const p = join(dir, f);
    if (p.endsWith(join('corpus', 'reject'))) continue;
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith('.a0')) out.push(p);
  }
  return out;
}

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};
const u32 = (n: number): number => n >>> 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface Draw {
  readonly id: string;
  readonly path: string;
  readonly target: string;
  readonly start: string;
  readonly reference: string;
  readonly wrong: string;
  readonly literal: number;
}

/** The target and its transitive callees (rule 3: the task program). */
function closure(canonical: string, target: string): ReadonlySet<string> {
  const program = parseAndValidate(canonical);
  const out = new Set<string>();
  const visit = (name: string): void => {
    if (out.has(name)) return;
    out.add(name);
    const f = program.byName.get(name) as TypedFunc;
    for (const c of f.calls.values()) visit(c.name);
  };
  visit(target);
  return out;
}

/** The functions of a canonical text named in `keep`, in their order. */
function only(text: string, keep: ReadonlySet<string>): string {
  const out: string[] = [];
  let on = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('fn '))
      on = keep.has((/^fn (\S+)/.exec(line) as RegExpExecArray)[1] as string);
    if (on) out.push(line);
    if (line === 'end') on = false;
  }
  return `${out.join('\n')}\n`;
}

/** Rules 2 to 4 on one canonical program text: one draw per qualifying function. */
function draw(path: string, canonical: string): Draw[] {
  const drawn: Draw[] = [];
  const lines = canonical.split('\n');
  let header = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.startsWith('fn ')) {
      const m = /^fn (\S+)((?: \S+)*) -> (\S+)$/.exec(line);
      const params = (m?.[2] ?? '').trim().split(' ').filter(Boolean);
      header =
        m !== null && m[3] === 'u32' && params.length > 0 && params.every((p) => p === 'u32')
          ? i
          : -1;
      continue;
    }
    if (
      header < 0 ||
      line === 'end' ||
      line.startsWith('ret ') ||
      line.startsWith('pre ') ||
      line.startsWith('post ')
    )
      continue;
    const words = line.split(' ');
    const k = words.findIndex((w, j) => j >= 2 && /^[0-9]+$/.test(w));
    if (k < 0) continue;
    const hi = header;
    header = -1;
    const L = Number(words[k]);
    const at = (v: number): string => {
      const w = [...words];
      w[k] = String(u32(v));
      const out = [...lines];
      out[i] = w.join(' ');
      return out.join('\n');
    };
    const target = (/^fn (\S+)/.exec(lines[hi] as string) as RegExpExecArray)[1] as string;
    const base = path.replace(/\.a0$/, '').split('/').pop() as string;
    const keep = closure(canonical, target);
    drawn.push({
      id: `cd-${base}-${target}`,
      path,
      target,
      start: only(at(L + 1), keep),
      reference: only(canonical, keep),
      wrong: only(at(L + 2), keep),
      literal: L,
    });
  }
  return drawn;
}

const FUEL = 1_000_000;
const call = (
  p: ReturnType<typeof parseAndValidate>,
  fn: string,
  args: readonly number[],
): Value | undefined => {
  try {
    return run(p.byName.get(fn) as TypedFunc, args, { fuel: FUEL });
  } catch {
    return undefined;
  }
};

const root = process.cwd();
const paths = files(root)
  .map((p) => relative(root, p).split(sep).join('/'))
  .sort();
const kept: unknown[] = [];
const problems: string[] = [];
const ids = new Set<string>();
for (const path of paths) {
  const source = readFileSync(join(root, path), 'utf8');
  if (/^use /m.test(source)) continue;
  let canonical: string;
  try {
    canonical = formatProgram(parse(source));
    parseAndValidate(canonical);
  } catch {
    continue;
  }
  for (const d of draw(path, canonical)) {
    const fail = (m: string): void => void problems.push(`${d.id} (${path}): ${m}`);
    if (ids.has(d.id)) {
      fail('id already drawn from an earlier file');
      continue;
    }
    let ref: ReturnType<typeof parseAndValidate>;
    let start: ReturnType<typeof parseAndValidate>;
    let wrong: ReturnType<typeof parseAndValidate>;
    try {
      ref = parseAndValidate(d.reference);
      start = parseAndValidate(d.start);
      wrong = parseAndValidate(d.wrong);
    } catch (e) {
      fail(`mutant does not validate: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const arity = (ref.byName.get(d.target) as TypedFunc).params.length;
    const pool: number[][] = [
      0,
      1,
      2,
      3,
      7,
      10,
      100,
      u32(d.literal - 1),
      d.literal,
      u32(d.literal + 1),
    ].map((v) => Array.from({ length: arity }, () => v));
    let s = fnv1a(`${path}:${d.target}`);
    const next = (): number => {
      s = u32(Math.imul(s, 1664525) + 1013904223);
      return s % 4 === 0 ? s : s % 1000;
    };
    for (let i = 0; i < 24; i += 1) pool.push(Array.from({ length: arity }, next));
    const seen = new Set<string>();
    const tests: { fn: string; args: number[]; expected: Value }[] = [];
    let firstDiff: { args: number[]; expected: Value; got: Value | undefined } | undefined;
    for (const args of pool) {
      const key = JSON.stringify(args);
      if (seen.has(key)) continue;
      seen.add(key);
      const expected = call(ref, d.target, args);
      if (expected === undefined) continue;
      const got = call(start, d.target, args);
      const differs = !same(got, expected);
      if (differs && firstDiff === undefined) {
        firstDiff = { args, expected, got };
        if (tests.length >= 10) tests[9] = { fn: d.target, args, expected };
        else tests.push({ fn: d.target, args, expected });
      } else if (tests.length < 10) tests.push({ fn: d.target, args, expected });
    }
    const passes = (p: ReturnType<typeof parseAndValidate>): boolean =>
      tests.every((t) => same(call(p, t.fn, t.args), t.expected));
    if (firstDiff === undefined || passes(start)) {
      fail('starting program passes every test');
      continue;
    }
    if (passes(wrong)) {
      fail('wrong edit passes every test');
      continue;
    }
    if (tests.length < 8) {
      fail(`only ${tests.length} tests`);
      continue;
    }
    ids.add(d.id);
    const shown = (v: Value | undefined): string =>
      v === undefined ? 'an error' : JSON.stringify(v);
    kept.push({
      id: d.id,
      kind: 'targeted-edit',
      target: d.target,
      wrongEditKind: 'literal-off-by-one',
      note: `Drawn from ${path}: the literal ${d.literal} in ${d.target} was raised by one; the wrong edit raises it by two.`,
      instruction: `\`${d.target}\` returns the wrong value: \`${d.target}(${firstDiff.args.join(', ')})\` should be ${shown(firstDiff.expected)}, it is ${shown(firstDiff.got)}. Fix \`${d.target}\` without changing any other function.`,
      a0Source: d.start,
      tests,
      reference: { a0: d.reference },
      wrongEdits: [d.wrong],
    });
  }
}
console.log(`${kept.length} tasks drawn from ${paths.length} files`);
for (const p of problems) console.log(`dropped: ${p}`);
if (process.argv.includes('--write')) {
  const body = (kept as Record<string, unknown>[]).map((t) => `  ${JSON.stringify(t)},`).join('\n');
  writeFileSync(
    'tools/ai-edit-tasks-cd.ts',
    `/**\n * Held-out task set CD (A0 only) for docs/history/2026-10-09-compact-dense-edit-accuracy-preregistration.md.\n * Generated by tools/ai-edit-tasks-cd-gen.ts from in-tree .a0 programs by the rule stated there (no author, no\n * model). SHA-256 sealed in ai-edit-tasks-cd.sha256 before any subject ran: never alter this file.\n */\n\nexport interface TaskCD {\n  readonly id: string;\n  readonly kind: string;\n  readonly target: string;\n  readonly wrongEditKind: string;\n  readonly note: string;\n  readonly instruction: string;\n  readonly a0Source: string;\n  readonly tests: readonly { readonly fn: string; readonly args: readonly unknown[]; readonly expected: unknown }[];\n  readonly reference: { readonly a0: string };\n  readonly wrongEdits: readonly string[];\n}\n\nexport const TASKS_CD: readonly TaskCD[] = [\n${body}\n];\n`,
  );
}
