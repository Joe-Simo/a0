/**
 * `a0 explain A0nnnn`: the text of one row of the diagnostics table, and the runner that executes
 * every row's examples. The examples are data in src/diagnostics.ts; this module is what keeps
 * them honest: `verifyExamples` runs the failing example of each row through the real parser,
 * checker, edit session, patch applier or interpreter and demands exactly that row's code, and
 * the fixed example must be accepted (the way Rust runs its `compile_fail` doctests).
 */

import { A0Error, makeIo, parseAndValidate, run, type Value } from './core.js';
import {
  DIAGNOSTICS,
  type DiagId,
  diagnosticIds,
  EXACT_FIXES,
  type Example,
  type ExampleArg,
  isDiagId,
  type Spec,
} from './diagnostics.js';
import { applyPatch, EditSession, parsePatch, revision } from './edit.js';

const text = (v: string | (() => string)): string => (typeof v === 'function' ? v() : v);
const spec = (id: DiagId): Spec => DIAGNOSTICS[id];

/** One line per row: `A0011 parse unknown operation '{0}'`. */
export function explainIndex(): string {
  return `${diagnosticIds()
    .map((id) => `${id} ${spec(id).cls} ${spec(id).message}`)
    .join('\n')}\n`;
}

const indent = (s: string): string =>
  s
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');

/** The explanation of one code: what it means, a failing example, the fixed example, the fixes. */
export function explain(id: string): string | undefined {
  const key = id.toUpperCase();
  if (!isDiagId(key)) return undefined;
  const s = spec(key);
  const out = [`${key} ${s.cls}: ${s.message}`, ...s.why];
  const ex: Example | undefined = s.example;
  if (ex === undefined) out.push(`(no runnable example: ${s.unrunnable ?? 'none'})`);
  else {
    const shown = ex.shown;
    const label =
      ex.kind === 'edit' ? 'rejected reply' : ex.kind === 'patch' ? 'rejected patch' : 'fails';
    const fixed =
      ex.kind === 'edit' ? 'accepted reply' : ex.kind === 'patch' ? 'accepted patch' : 'fixed';
    out.push(
      `${label}:`,
      indent(shown?.bad ?? text(ex.bad)),
      `${fixed}:`,
      indent(shown?.good ?? text(ex.good)),
    );
    if (ex.base !== undefined) out.push('over:', indent(ex.base));
  }
  const exact = EXACT_FIXES.filter((f) => f.id === key);
  if (exact.length > 0)
    out.push(
      `exact fixes (\`fix all\`, \`a0 check --fix\`): ${exact.map((f) => f.what).join('; ')}`,
    );
  return `${out.join('\n')}\n`;
}

/** The code a thunk raises, undefined when it does not throw; other errors propagate. */
function raised(thunk: () => unknown): A0Error | undefined {
  try {
    thunk();
    return undefined;
  } catch (e) {
    if (e instanceof A0Error) return e;
    throw e;
  }
}

function session(ex: Example): EditSession {
  const base = parseAndValidate(ex.base ?? '');
  const s = new EditSession(base);
  for (const f of ex.open ?? [ex.fn ?? '']) s.open(f, { scope: 'deps' });
  s.openProgram();
  return s;
}

const value = (a: ExampleArg): Value =>
  a === 'io' ? makeIo() : Array.isArray(a) ? a.map(value) : (a as Value);

function runExample(ex: Example, source: string, good: boolean): void {
  const typed = parseAndValidate(source);
  const fn = typed.byName.get(ex.fn ?? '');
  if (fn === undefined) throw new Error(`example runs unknown function '${ex.fn ?? ''}'`);
  const args: Value[] = ((good ? ex.goodArgs : undefined) ?? ex.args ?? []).map(value);
  run(fn, args, ex.fuel === undefined ? undefined : { fuel: ex.fuel });
}

/** Problems with the examples of one row (empty when the row's examples hold). */
export function verifyExample(id: DiagId): string[] {
  const s = spec(id);
  const ex: Example | undefined = s.example;
  if (ex === undefined)
    return s.unrunnable === undefined ? [`${id}: no example and no reason`] : [];
  const problems: string[] = [];
  const bad = text(ex.bad);
  const good = text(ex.good);
  let badError: A0Error | undefined;
  let goodError: A0Error | undefined;
  switch (ex.kind) {
    case 'source':
      badError = raised(() => parseAndValidate(bad));
      goodError = raised(() => parseAndValidate(good));
      break;
    case 'edit':
      badError = raised(() => session(ex).apply(bad));
      goodError = raised(() => session(ex).apply(good));
      break;
    case 'patch': {
      const base = parseAndValidate(ex.base ?? '');
      const fn = base.byName.get(ex.fn ?? '');
      if (fn === undefined) return [`${id}: patch example names unknown function '${ex.fn ?? ''}'`];
      const apply = (patch: string): void => {
        applyPatch(base, parsePatch(patch.replaceAll('REV', revision(fn))));
      };
      badError = raised(() => apply(bad));
      goodError = raised(() => apply(good));
      break;
    }
    case 'run':
      badError = raised(() => runExample(ex, bad, false));
      goodError = raised(() => runExample(ex, good, true));
      break;
  }
  if (badError === undefined) problems.push(`${id}: the failing example is accepted`);
  else if (badError.id !== id)
    problems.push(
      `${id}: the failing example raised ${badError.id ?? 'no code'}: ${badError.message}`,
    );
  if (goodError !== undefined)
    problems.push(
      `${id}: the fixed example is rejected with ${goodError.id ?? 'no code'}: ${goodError.message}`,
    );
  return problems;
}

/** Every row's problems; empty when all examples hold. */
export function verifyExamples(): string[] {
  return diagnosticIds().flatMap(verifyExample);
}
