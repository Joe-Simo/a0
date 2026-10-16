import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  A0Error,
  formatTrap,
  isPrimitive,
  makeIo,
  parseAndValidate,
  run,
  type Type,
  type TypedProgram,
  type Value,
} from '../../../src/core.js';
import {
  type Fixture,
  fixturesFor,
  type Invocation,
  PUBLIC_SOURCE,
  STRICT_IDENTITY_SOURCE,
} from './fixtures.js';

// This file imports no target compiler. The supplied adapter must execute emitjs written
// in A0; source formatting/word encoding is permitted, TS target emission is not.
export interface CandidateResult {
  readonly code: number;
  readonly text: string;
  readonly chunks?: number;
}
export type CandidateEmitter = (
  source: string,
  program: TypedProgram,
) => CandidateResult | Promise<CandidateResult>;
export interface Options {
  readonly strict: 'supported' | 'refused';
  readonly groups?: readonly Fixture['group'][];
  readonly cacheDir: string;
}

function toJS(value: Value, type: Type, seen: Map<object, unknown>): unknown {
  if (isPrimitive(type)) return value;
  assert.ok(Array.isArray(value));
  if (seen.has(value)) return seen.get(value);
  if (type.kind === 'arr' && (type.elem === 'u32' || type.elem === 'bool')) {
    const out =
      type.elem === 'u32'
        ? Uint32Array.from(value as number[])
        : Uint8Array.from(value as boolean[], (x) => (x ? 1 : 0));
    seen.set(value, out);
    return out;
  }
  const out: unknown[] = [];
  seen.set(value, out);
  for (const [i, v] of value.entries())
    out.push(toJS(v, type.kind === 'arr' ? type.elem : (type.fields[i] as Type), seen));
  return out;
}

function fromJS(value: unknown, type: Type, requireResultRepresentation = false): Value {
  if (type === 'u32') {
    assert.ok(
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
      'u32 result must be an unsigned integer',
    );
    return value;
  }
  if (type === 'bool') {
    assert.equal(typeof value, 'boolean', 'bool must not leak 0/1');
    return value as boolean;
  }
  if (type === 'io') return value as Value;
  if (requireResultRepresentation) {
    if (type.kind === 'arr' && type.elem === 'u32') assert.ok(value instanceof Uint32Array);
    else if (type.kind === 'arr' && type.elem === 'bool') assert.ok(value instanceof Uint8Array);
    else assert.ok(Array.isArray(value), 'records/nested arrays are plain arrays');
  }
  const values = Array.from(value as ArrayLike<unknown>);
  assert.equal(values.length, type.kind === 'arr' ? type.length : type.fields.length);
  if (type.kind === 'arr' && type.elem === 'bool' && value instanceof Uint8Array)
    return values.map((v) => v === 1);
  return values.map((v, i) =>
    fromJS(
      v,
      type.kind === 'arr' ? type.elem : (type.fields[i] as Type),
      requireResultRepresentation,
    ),
  );
}

type Module = Record<string, (...args: unknown[]) => unknown>;

async function importCandidate(text: string, dir: string): Promise<Module> {
  assert.ok(text.length > 0, 'successful A0 emission must produce source');
  // File URLs work in both Node and the isolated Bun runner; long data: URLs do not.
  await mkdir(dir, { recursive: true });
  const file = `${dir}/${createHash('sha256').update(text).digest('hex')}.mjs`;
  await writeFile(file, text);
  return (await import(pathToFileURL(file).href)) as Module;
}

function checkInvocation(
  mod: Module,
  program: TypedProgram,
  row: Invocation,
  label: string,
): { trap: boolean; io: boolean } {
  const fn = program.byName.get(row.fn);
  assert.ok(fn, `${label}: reference function ${row.fn}`);
  const invoke = mod[row.fn];
  assert.ok(typeof invoke === 'function', `${label}: public export ${row.fn}`);
  const args: Value[] = [...row.args];
  if (row.input !== undefined) args.push(makeIo(row.input));
  const expectedArgs = structuredClone(args);
  const actualClone = structuredClone(args);
  const seen = new Map<object, unknown>();
  const actualArgs = actualClone.map((v, i) => toJS(v, fn.params[i] as Type, seen));
  let expected: Value | undefined;
  let expectedTrap: A0Error | undefined;
  try {
    expected = run(fn, expectedArgs, { fuel: 5_000_000 });
  } catch (error) {
    assert.ok(
      error instanceof A0Error && error.trap !== undefined,
      `${label}: unexpected reference failure`,
    );
    expectedTrap = error;
  }
  if (row.trapLine !== undefined) {
    assert.ok(expectedTrap?.trap, `${label}: recorded trap must occur in reference`);
    assert.equal(formatTrap(expectedTrap.trap), row.trapLine);
  } else if (row.expected !== undefined) {
    assert.equal(expectedTrap, undefined, `${label}: independent/recorded success must not trap`);
    assert.deepEqual(
      expected,
      row.expected,
      `${label}: reference agrees with independent/recorded oracle`,
    );
  }
  if (expectedTrap !== undefined) {
    assert.throws(
      () => invoke(...actualArgs),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const actual = error as A0Error;
        assert.deepEqual(
          { id: actual.id, code: actual.code, trap: actual.trap },
          { id: expectedTrap.id, code: expectedTrap.code, trap: expectedTrap.trap },
          label,
        );
        return true;
      },
    );
  } else {
    assert.deepEqual(fromJS(invoke(...actualArgs), fn.result, true), expected, label);
  }
  // Includes ordinary caller inputs, shared aggregate children, and IO state/output even
  // when the function returns a scalar or traps after earlier side effects.
  for (const [i, actual] of actualArgs.entries())
    assert.deepEqual(
      fromJS(actual, fn.params[i] as Type),
      expectedArgs[i],
      `${label}: caller argument/effects p${i}`,
    );
  if (row.output !== undefined) {
    const io = expectedArgs.at(-1) as ReturnType<typeof makeIo>;
    assert.deepEqual(io.output, row.output, `${label}: independent recorded IO words`);
  }
  return {
    trap: expectedTrap !== undefined,
    io: row.input !== undefined || fn.params.some((t) => t === 'io'),
  };
}

function publicBoundary(mod: Module): number {
  let calls = 0;
  const call = (name: string, ...args: unknown[]) => {
    calls++;
    const fn = mod[name];
    assert.ok(typeof fn === 'function');
    return fn(...args);
  };
  const rejects = (name: string, args: unknown[], kind: new (...args: never[]) => Error) => {
    calls++;
    const fn = mod[name];
    assert.ok(typeof fn === 'function');
    assert.throws(() => fn(...args), kind);
  };
  for (const x of [0, 1, 0x80000000, 0xffffffff]) assert.equal(call('public_u32', x), x);
  for (const x of [-1, 0x100000000, 0.5, NaN, Infinity, '7', true, null, undefined])
    rejects('public_u32', [x], RangeError);
  assert.equal(
    call('public_u32', 7, 99),
    7,
    'existing JS public entries ignore extra JS arguments',
  );
  for (const x of [false, true]) assert.equal(call('public_bool', x), x);
  for (const x of [0, 1, 'true', null, undefined]) rejects('public_bool', [x], TypeError);
  for (const input of [[1, 2, 3], Uint32Array.of(1, 2, 3), Uint8Array.of(1, 2, 3)]) {
    const before = Array.from(input);
    const result = call('public_array', input, 0xffffffff, 77);
    assert.ok(result instanceof Uint32Array);
    assert.deepEqual(Array.from(result), [77, 2, 3], 'UINT_MAX % 3 is zero');
    assert.deepEqual(Array.from(input), before, 'public set preserves caller input');
  }
  rejects('public_array', [[1, 2], 0, 7], RangeError);
  rejects('public_array', [[1, '2', 3], 0, 7], RangeError);
  rejects('public_array', [null, 0, 7], TypeError);
  assert.equal(call('public_bool_array', [true, false, true], 1), false);
  // Production accepts Uint8Array without checking 0/1, then decodes with ===1.
  for (const [i, expected] of [
    [0, false],
    [1, false],
    [2, true],
  ] as const)
    assert.equal(call('public_bool_array', Uint8Array.of(2, 255, 1), i), expected);
  rejects('public_bool_array', [[true, 0, false], 0], TypeError);
  const boolInput = Uint8Array.of(1, 0, 1);
  const boolResult = call('public_bool_update', boolInput, 0xffffffff, false);
  assert.ok(boolResult instanceof Uint8Array);
  assert.deepEqual(Array.from(boolResult), [0, 0, 1]);
  assert.deepEqual(Array.from(boolInput), [1, 0, 1]);
  const record = [[1, 2, 3], true];
  const publicRecord = parseAndValidate(PUBLIC_SOURCE).byName.get('public_record');
  assert.ok(publicRecord);
  assert.deepEqual(fromJS(call('public_record', record), publicRecord.result, true), record);
  rejects('public_record', [Uint32Array.of(1, 2)], TypeError);
  rejects('public_record', [[[1, 2, 3], 1]], TypeError);
  const child = Uint32Array.of(1, 2, 3);
  const nested = call('public_nested', [child, child]) as unknown[];
  assert.deepEqual(
    nested.map((x) => Array.from(x as Uint32Array)),
    [
      [1, 2, 3],
      [1, 2, 3],
    ],
  );
  rejects('public_nested', [Uint32Array.of(1, 2)], TypeError);
  const io = { input: [7], position: 0, output: [] as number[] };
  assert.equal(call('public_io', io), 0);
  assert.deepEqual(io, { input: [7], position: 1, output: [7, 0] });
  rejects('public_io', [null], TypeError);
  const input = [11, 22];
  const made = call('a0_make_io', input) as ReturnType<typeof makeIo>;
  input[0] = 99;
  assert.deepEqual(made, { input: [11, 22], position: 0, output: [] });
  return calls;
}

/** Never called automatically. Parent must supply/review an actual A0 emitter adapter. */
export async function runJSConformance(emit: CandidateEmitter, options: Options) {
  const cache = new Map<
    string,
    Promise<{ program: TypedProgram; module?: Module; refused: boolean }>
  >();
  const obtain = (source: string) => {
    let have = cache.get(source);
    if (have !== undefined) return have;
    have = (async () => {
      const program = parseAndValidate(source);
      const refuse = program.profile === 'strict' && options.strict === 'refused';
      let result: CandidateResult;
      try {
        result = await emit(source, program);
      } catch (error) {
        if (refuse && error instanceof A0Error && error.id === 'A0713')
          return { program, refused: true };
        throw error;
      }
      if (refuse) {
        assert.equal(
          result.code,
          2,
          'strict must be explicitly refused while metadata/traps are unsupported',
        );
        assert.equal(result.text, '', 'refusal must not emit a canonicalized module');
        return { program, refused: true };
      }
      assert.equal(result.code, 0, 'A0 emitter status');
      return {
        program,
        module: await importCandidate(result.text, options.cacheDir),
        refused: false,
      };
    })();
    cache.set(source, have);
    return have;
  };
  const rows: {
    fixture: string;
    oracle: string;
    declared: number;
    comparisons: number;
    traps: number;
    io: number;
    refused: boolean;
  }[] = [];
  for (const f of fixturesFor(options.groups)) {
    const result = await obtain(f.source);
    let comparisons = 0,
      traps = 0,
      io = 0;
    if (!result.refused) {
      assert.ok(result.module);
      for (const [i, row] of f.cases.entries()) {
        const observation = checkInvocation(
          result.module,
          result.program,
          row,
          `${f.name}/${i}/${row.fn}`,
        );
        comparisons++;
        traps += observation.trap ? 1 : 0;
        io += observation.io ? 1 : 0;
      }
    }
    rows.push({
      fixture: f.name,
      oracle: f.oracle,
      declared: f.cases.length,
      comparisons,
      traps,
      io,
      refused: result.refused,
    });
  }
  const publicResult = await obtain(PUBLIC_SOURCE);
  assert.ok(publicResult.module);
  const publicCalls = publicBoundary(publicResult.module);
  await obtain(STRICT_IDENTITY_SOURCE);
  return {
    status: 'passed',
    strict: options.strict,
    emissions: cache.size,
    comparisons: rows.reduce((n, r) => n + r.comparisons, 0),
    refusedSources:
      [...cache.values()].length -
      (await Promise.all(cache.values())).filter((r) => !r.refused).length,
    publicCalls,
    rows,
    note: 'Candidate target text came only from the injected A0 adapter. Strict refusals are not counted as successful semantic comparisons. No timing result.',
  };
}
