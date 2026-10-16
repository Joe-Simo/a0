import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { A0Error, isPrimitive, parseAndValidate, run, type Type, type Value } from '../src/core.js';
import { CASES as EXTRA_CASES, IO_EXTRA_CASES } from './fixtures/js-deep-extra.js';
import { CASES, INPUTS } from './fixtures/js-deep-owned.js';

/** Preserve input aliases while converting scalar arrays to their public JS representation. */
function toJS(value: Value, type: Type, seen: Map<Value[], unknown>): unknown {
  if (isPrimitive(type)) return value;
  assert.ok(Array.isArray(value));
  if (seen.has(value)) return seen.get(value);
  if (type.kind === 'arr' && (type.elem === 'u32' || type.elem === 'bool')) {
    const out =
      type.elem === 'u32'
        ? Uint32Array.from(value as number[])
        : Uint8Array.from(value as boolean[], (v) => (v ? 1 : 0));
    seen.set(value, out);
    return out;
  }
  const out: unknown[] = [];
  seen.set(value, out);
  for (const [i, v] of value.entries())
    out.push(toJS(v, type.kind === 'arr' ? type.elem : (type.fields[i] as Type), seen));
  return out;
}

function fromJS(value: unknown, type: Type): Value {
  if (isPrimitive(type)) return value as Value;
  const values = Array.from(value as ArrayLike<unknown>);
  if (type.kind === 'arr' && type.elem === 'bool' && value instanceof Uint8Array)
    return values.map((v) => v === 1);
  return values.map((v, i) =>
    fromJS(v, type.kind === 'arr' ? type.elem : (type.fields[i] as Type)),
  );
}

for (const fixture of [...CASES, ...EXTRA_CASES, ...IO_EXTRA_CASES])
  test(`JS deep record ownership: ${fixture.name}`, async () => {
    const p = parseAndValidate(fixture.source);
    const entry = fixture.entry ?? 'probe';
    const fn = p.byName.get(entry);
    assert.ok(fn);
    for (const optimize of [false, true]) {
      const text = compile(p, 'js', { optimize }).text;
      if (fixture.io || fixture.noDeep) assert.doesNotMatch(text, /function a0d_step\(/);
      if (fixture.deep) {
        assert.match(text, /function a0d_step\(/);
        assert.match(text, /= a0d_step\(/);
      }
      const mod = (await import(
        `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
      )) as Record<string, (...args: unknown[]) => unknown>;
      const invoke = mod[entry];
      assert.ok(invoke);
      for (const input of fixture.inputs ?? INPUTS) {
        const expectedArgs = structuredClone(input) as Value[];
        const seen = new Map<Value[], unknown>();
        const actualArgs: unknown[] = structuredClone(input).map((v, i): unknown =>
          toJS(v, fn.params[i] as Type, seen),
        );
        let expected: Value | undefined;
        let trap: A0Error | undefined;
        try {
          expected = run(fn, expectedArgs);
        } catch (e) {
          assert.ok(e instanceof A0Error && e.trap !== undefined);
          trap = e;
        }
        if (trap !== undefined)
          assert.throws(
            () => invoke(...actualArgs),
            (e: unknown) => {
              assert.ok(e instanceof Error);
              const actual = e as A0Error;
              assert.deepEqual(
                { id: actual.id, code: actual.code, trap: actual.trap },
                { id: trap.id, code: trap.code, trap: trap.trap },
              );
              return true;
            },
          );
        else
          assert.deepEqual(
            fromJS(invoke(...actualArgs), fn.result),
            expected,
            `${fixture.name}; ${JSON.stringify(input)}; optimize=${optimize}`,
          );
        for (const [i, v] of actualArgs.entries())
          assert.deepEqual(
            fromJS(v, fn.params[i] as Type),
            expectedArgs[i],
            `${fixture.name}: caller values/effects; optimize=${optimize}`,
          );
      }
    }
  });

test('JS private record loops copy a retained caller array once, instead of every trip', async () => {
  const p = parseAndValidate((CASES[0] as (typeof CASES)[number]).source);
  const text = compile(p, 'js', { optimize: false }).text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
  )) as { probe: (a: number, b: number) => number };
  const descriptor = Object.getOwnPropertyDescriptor(Uint32Array.prototype, 'slice');
  const original = Uint32Array.prototype.slice;
  let copies = 0;
  Object.defineProperty(Uint32Array.prototype, 'slice', {
    configurable: true,
    writable: true,
    value: function (this: Uint32Array, ...args: [number?, number?]) {
      copies++;
      return Reflect.apply(original, this, args);
    },
  });
  try {
    mod.probe(7, 13);
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(Uint32Array.prototype, 'slice');
    else Object.defineProperty(Uint32Array.prototype, 'slice', descriptor);
  }
  assert.equal(copies, 1, 'snapshot the retained original once; loop trips own their array field');
});
