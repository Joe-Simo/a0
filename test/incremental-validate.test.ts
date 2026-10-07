/**
 * Incremental validation (src/core.ts validate) against validation from scratch.
 *
 * `validate` reuses the typed result of an unchanged function by identity when every callee it resolved is
 * the same object. This file proves the result equals a full validation in every observable way: the
 * functions in order, canonical text, revisions, types, calls, iteration bounds, the profile, and on failure the
 * same diagnostic (every field). The reference is `validate` on a copy of the same functions with every typing
 * removed, which has nothing to reuse.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  A0Error,
  type Func,
  formatFunction,
  formatProgram,
  type Node,
  type Operand,
  type Program,
  parseAndValidate,
  type TypedProgram,
  validate,
} from '../src/core.js';
import { EditSession, revision } from '../src/edit.js';
import { link } from '../src/link.js';
import { extractBlock } from '../tools/ai-edit-apply.js';
import { startPrograms } from '../tools/app-edit-bench.js';
import { APP_TASKS } from '../tools/app-edit-tasks.js';

/** The functions with every typing removed: validating these cannot reuse anything. */
function strip(f: Func): Func {
  const { types, calls, staticIterations, literalIterations, profile, ...rest } = f as Func & {
    types?: unknown;
    calls?: unknown;
    staticIterations?: unknown;
    literalIterations?: unknown;
    profile?: unknown;
  };
  void [types, calls, staticIterations, literalIterations, profile];
  return rest;
}

function serialize(p: TypedProgram): string {
  return JSON.stringify({
    profile: p.profile ?? null,
    text: formatProgram(p),
    order: [...p.byName.keys()],
    functions: p.functions.map((f) => ({
      name: f.name,
      text: formatFunction(f),
      rev: revision(f),
      profile: f.profile ?? null,
      types: [...f.types],
      calls: [...f.calls.keys()],
      si: f.staticIterations,
      li: f.literalIterations,
      same: p.byName.get(f.name) === f,
      callsResolved: [...f.calls].every(([k, c]) => p.byName.get(k) === c),
    })),
  });
}

function outcome(run: () => TypedProgram): { ok: true; text: string } | { ok: false; err: string } {
  try {
    return { ok: true, text: serialize(run()) };
  } catch (e) {
    if (!(e instanceof A0Error)) throw e;
    return {
      ok: false,
      err: JSON.stringify({
        message: e.message,
        detail: e.detail,
        line: e.line ?? null,
        id: e.id ?? null,
        code: e.code,
        expected: e.expected ?? null,
        actual: e.actual ?? null,
        fix: e.fix ?? null,
        edits: e.edits,
        spec: e.spec ?? null,
      }),
    };
  }
}

let compared = 0;
let failures = 0;

/** Validate incrementally and from scratch; they must agree. Returns the incremental result if valid. */
function agree(program: Program, label: string): TypedProgram | undefined {
  const inc = outcome(() => validate(program));
  const full = outcome(() =>
    validate({
      ...(program.profile === undefined ? {} : { profile: program.profile }),
      functions: program.functions.map(strip),
    }),
  );
  compared += 1;
  assert.deepEqual(inc, full, label);
  if (!inc.ok) {
    failures += 1;
    return undefined;
  }
  return validate(program);
}

// --- deterministic generator -------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const below = (r: Rand, n: number): number => Math.floor(r() * n);

function mapNodes(f: Func, g: (n: Node, i: number) => Node): Func {
  return { ...strip(f), nodes: f.nodes.map(g) };
}

/** Edit the program like a model would: one change of one of seven kinds. Unchanged functions keep their typing. */
function mutate(r: Rand, p: Program): { program: Program; kind: string } {
  const fs = [...p.functions];
  const n = fs.length;
  const i = below(r, n);
  const f = fs[i] as Func;
  const kinds = [
    'rename',
    'rename-all',
    'body',
    'op',
    'signature',
    'result',
    'delete',
    'add',
    'reorder',
    'move',
    'break-callee',
    'later-callee',
    'drop-spec',
    'profile',
    'noop-copy',
  ];
  const kind = pick(r, kinds);
  const out = (functions: Func[], profile: Program['profile'] = p.profile): Program => ({
    ...(profile === undefined ? {} : { profile }),
    functions,
  });
  switch (kind) {
    case 'rename': {
      // Callers still name the old function: a diagnostic unless nobody calls it.
      fs[i] = { ...strip(f), name: `${f.name}_r` };
      return { program: out(fs), kind };
    }
    case 'rename-all': {
      const to = `${f.name}_r`;
      const fixed = fs.map((g, k) => {
        if (k === i) return { ...strip(g), name: to };
        const uses = g.nodes.some((x) => x.callee === f.name || x.pred === f.name);
        if (!uses) return g;
        return mapNodes(g, (x) => ({
          ...x,
          ...(x.callee === f.name ? { callee: to } : {}),
          ...(x.pred === f.name ? { pred: to } : {}),
        }));
      });
      return { program: out(fixed), kind };
    }
    case 'body': {
      const at = f.nodes.findIndex((x) => x.args.some((a) => a.kind === 'u32'));
      if (at < 0) break;
      const cands = f.nodes.flatMap((x, k) => (x.args.some((a) => a.kind === 'u32') ? [k] : []));
      const k = pick(r, cands);
      fs[i] = mapNodes(f, (x, j) =>
        j !== k
          ? x
          : {
              ...x,
              args: x.args.map(
                (a): Operand => (a.kind === 'u32' ? { kind: 'u32', value: below(r, 9) } : a),
              ),
            },
      );
      return { program: out(fs), kind };
    }
    case 'op': {
      const swaps: Record<string, string> = {
        add: 'sub',
        sub: 'mul',
        mul: 'add',
        lt: 'eq',
        eq: 'lt',
      };
      const cands = f.nodes.flatMap((x, k) => (x.op in swaps ? [k] : []));
      if (cands.length === 0) break;
      const k = pick(r, cands);
      fs[i] = mapNodes(f, (x, j) =>
        j === k ? ({ ...x, op: swaps[x.op] as Node['op'] } as Node) : x,
      );
      return { program: out(fs), kind };
    }
    case 'signature':
      fs[i] =
        r() < 0.5
          ? { ...strip(f), params: [...f.params, 'u32'] }
          : { ...strip(f), params: f.params.slice(0, -1) };
      return { program: out(fs), kind };
    case 'result':
      fs[i] = { ...strip(f), result: f.result === 'u32' ? 'bool' : 'u32' };
      return { program: out(fs), kind };
    case 'delete':
      if (n < 2) break;
      fs.splice(i, 1);
      return { program: out(fs), kind };
    case 'add': {
      const copy = { ...strip(f), name: `${f.name}_n${below(r, 100)}` };
      fs.splice(below(r, n + 1), 0, copy);
      return { program: out(fs), kind };
    }
    case 'reorder': {
      const j = below(r, n);
      [fs[i], fs[j]] = [fs[j] as Func, fs[i] as Func];
      return { program: out(fs), kind };
    }
    case 'move': {
      fs.splice(i, 1);
      fs.splice(below(r, n), 0, f);
      return { program: out(fs), kind };
    }
    case 'break-callee': {
      const cands = f.nodes.flatMap((x, k) => (x.callee !== undefined ? [k] : []));
      if (cands.length === 0) break;
      const k = pick(r, cands);
      fs[i] = mapNodes(f, (x, j) => (j === k ? { ...x, callee: 'nosuchfn' } : x));
      return { program: out(fs), kind };
    }
    case 'later-callee': {
      if (i + 1 >= n) break;
      const cands = f.nodes.flatMap((x, k) => (x.callee !== undefined ? [k] : []));
      if (cands.length === 0) break;
      const k = pick(r, cands);
      const to = (fs[below(r, n - i - 1) + i + 1] as Func).name;
      fs[i] = mapNodes(f, (x, j) => (j === k ? { ...x, callee: to } : x));
      return { program: out(fs), kind };
    }
    case 'drop-spec': {
      const k = fs.findIndex((g) => g.spec !== undefined);
      if (k < 0) break;
      const { spec: _spec, ...rest } = strip(fs[k] as Func);
      void _spec;
      fs[k] = rest;
      return { program: out(fs), kind };
    }
    case 'profile':
      return { program: out(fs, p.profile === 'strict' ? undefined : 'strict'), kind };
    case 'noop-copy':
      // A rebuilt but identical function: it is retyped, its callers must follow.
      fs[i] = { ...strip(f) };
      return { program: out(fs), kind };
  }
  return { program: out(fs), kind: 'none' };
}

const KINDS = new Map<string, number>();

function walk(seed: number, base: TypedProgram, steps: number, label: string): void {
  const r = rng(seed);
  let current: Program = base;
  for (let s = 0; s < steps; s += 1) {
    const { program, kind } = mutate(r, current);
    KINDS.set(kind, (KINDS.get(kind) ?? 0) + 1);
    const typed = agree(program, `${label} seed ${seed} step ${s} (${kind})`);
    // Chain on a valid result so later edits reuse the typings of earlier ones; otherwise retry from the last good one.
    if (typed !== undefined) current = typed;
  }
}

function a0Files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...a0Files(p));
    else if (e.name.endsWith('.a0')) out.push(p);
  }
  return out.sort();
}

function validPrograms(): { name: string; program: TypedProgram }[] {
  const out: { name: string; program: TypedProgram }[] = [];
  for (const file of [...a0Files('corpus'), ...a0Files('examples')]) {
    const text = readFileSync(file, 'utf8');
    if (/^\s*use\s/m.test(text)) continue;
    try {
      const program = parseAndValidate(text);
      if (program.functions.length > 1) out.push({ name: file, program });
    } catch {
      // A rejection corpus program: not a start state.
    }
  }
  return out;
}

const RANDOM_EDITS = Number(process.env.A0_INCREMENTAL_EDITS ?? '2400');

test('incremental validate: random edits over corpus and examples equal a full validate', () => {
  const programs = validPrograms();
  assert.ok(programs.length >= 10, `only ${programs.length} start programs`);
  const per = Math.ceil(RANDOM_EDITS / programs.length);
  const before = compared;
  for (const [k, { name, program }] of programs.entries()) walk(1000 + k, program, per, name);
  assert.ok(compared - before >= RANDOM_EDITS);
  // Every kind of edit ran, and both outcomes (valid, diagnostic) are covered.
  assert.ok(failures > 100 && compared - failures > 100, `${failures} failed of ${compared}`);
  for (const k of [
    'rename',
    'rename-all',
    'body',
    'op',
    'signature',
    'result',
    'delete',
    'add',
    'reorder',
    'move',
    'break-callee',
    'noop-copy',
    'profile',
  ])
    assert.ok((KINDS.get(k) ?? 0) > 5, `edit kind ${k} ran ${KINDS.get(k) ?? 0} times`);
});

test('incremental validate: random edits over linked compiler programs with specs and strict profile', async () => {
  const bases: { name: string; program: TypedProgram }[] = [];
  for (const file of [
    'compiler/shape.a0',
    'compiler/emit_wasm.a0',
    'compiler/asm_arm64.a0',
    'compiler/lex.a0',
  ]) {
    const linked = await link(file, (p) => readFile(p, 'utf8'));
    bases.push({ name: file, program: parseAndValidate(linked.text) });
  }
  // Spec lines whose pre and post call helpers (those callees are dependencies too).
  const spec = [
    'fn below u32 u32 -> bool',
    'a lt p0 p1',
    'ret a',
    'end',
    'fn inc u32 -> u32',
    'a add p0 1',
    'ret a',
    'end',
    'fn f u32 -> u32',
    'ex 1 -> 3',
    'pre below p0 100',
    'post call below p0 r',
    'a call inc p0',
    'b call inc a',
    'ret b',
    'end',
    'fn g u32 -> u32',
    'ex 1 -> 4',
    'a call f p0',
    'b call inc a',
    'ret b',
    'end',
    'fn h u32 -> u32',
    'ex 0 -> 5',
    'a call g p0',
    'b call f a',
    'ret b',
    'end',
    '',
  ].join('\n');
  bases.push({ name: 'spec', program: parseAndValidate(spec) });
  assert.ok(
    bases.some((b) => b.program.functions.some((f) => f.spec !== undefined)),
    'no spec lines in the bases',
  );
  for (const [k, { name, program }] of bases.entries())
    walk(5000 + k, program, name === 'spec' ? 400 : 60, name);
});

test('incremental validate: reuse is by identity and invalidates exactly the dependents', () => {
  const text = [
    'fn a u32 -> u32',
    'x add p0 1',
    'ret x',
    'end',
    '',
    'fn b u32 -> u32',
    'x call a p0',
    'ret x',
    'end',
    '',
    'fn c u32 -> u32',
    'x call b p0',
    'ret x',
    'end',
    '',
    'fn d u32 -> u32',
    'x add p0 2',
    'ret x',
    'end',
    '',
  ].join('\n');
  const p = parseAndValidate(text);
  const same = validate({ functions: p.functions });
  for (const f of p.functions) assert.equal(same.byName.get(f.name), f, `${f.name} reused`);
  // Edit a: b and c are typed again, d is not.
  const a = p.functions[0] as Func;
  const edited = {
    ...strip(a),
    nodes: [{ ...a.nodes[0], args: [a.nodes[0]?.args[0], { kind: 'u32', value: 7 }] } as Node],
  };
  const q = validate({ functions: [edited, ...p.functions.slice(1)] });
  assert.notEqual(q.byName.get('b'), p.byName.get('b'));
  assert.notEqual(q.byName.get('c'), p.byName.get('c'));
  assert.equal(q.byName.get('d'), p.byName.get('d'));
  // Edit d: nothing else is typed again.
  const d = p.functions[3] as Func;
  const r = validate({
    functions: [
      ...p.functions.slice(0, 3),
      {
        ...strip(d),
        nodes: [{ ...d.nodes[0], args: [d.nodes[0]?.args[0], { kind: 'u32', value: 9 }] } as Node],
      },
    ],
  });
  for (const name of ['a', 'b', 'c']) assert.equal(r.byName.get(name), p.byName.get(name));
  // A different profile retypes everything.
  const s = validate({ profile: 'strict', functions: p.functions });
  for (const f of p.functions) assert.notEqual(s.byName.get(f.name), f);
  // A spread copy of a typed function is not trusted, whatever it carries.
  const forged = { ...p.functions[0], nodes: [] } as Func;
  assert.throws(() => validate({ functions: [forged, ...p.functions.slice(1)] }), A0Error);
});

test('incremental validate: the 14 reference edits on the real front end equal a full validate', async () => {
  const programs = await startPrograms();
  const start = parseAndValidate(programs.a0);
  let applied = 0;
  for (const task of APP_TASKS) {
    for (const [which, reply] of [
      ['reference', task.reference.a0],
      ['wrong', task.wrong.a0],
    ] as const) {
      const session = new EditSession(start);
      for (const f of task.a0Targets) session.open(f, { scope: 'deps' });
      session.openProgram({ scope: 'all', target: task.a0Targets[0] as string });
      let result: TypedProgram;
      try {
        result = session.apply(extractBlock(reply));
      } catch (e) {
        assert.ok(e instanceof A0Error, `${task.id} ${which}`);
        assert.equal(which, 'wrong', `${task.id}: the reference edit must apply`);
        continue;
      }
      applied += 1;
      const full = outcome(() =>
        validate({
          ...(result.profile === undefined ? {} : { profile: result.profile }),
          functions: result.functions.map(strip),
        }),
      );
      assert.deepEqual({ ok: true, text: serialize(result) }, full, `${task.id} ${which}`);
      // Most of the program is the very object it was before the edit.
      const kept = result.functions.filter((f) => start.byName.get(f.name) === f).length;
      assert.ok(kept > 0 || which === 'wrong', `${task.id}: nothing reused`);
    }
  }
  assert.ok(applied >= 14, `${applied} edits applied`);
});
