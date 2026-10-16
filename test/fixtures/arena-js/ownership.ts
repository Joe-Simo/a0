import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseAndValidate, run } from '../../../src/core.js';
import { CONTROLS, INPUTS } from './ownership-controls.js';
import { LIFECYCLE } from './ownership-fixtures.js';

interface CandidateResult {
  readonly code: number;
  readonly text: string;
}

type Module = Record<string, (...args: number[]) => unknown>;
type ObserverGlobal = typeof globalThis & {
  __a0_array_allocation?: (value: unknown[]) => unknown[];
};
const observedGlobal = globalThis as ObserverGlobal;

/** Return the exact target object while counting its allocation. Module setup and
 * independent models run outside observation. No target text pattern is an oracle. */
function instrumentArrays(text: string): string {
  const source = ts.createSourceFile(
    'target.js',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const transformed = ts.transform(source, [
    (context) => {
      const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
        const child = ts.visitEachChild(node, visit, context);
        return ts.isArrayLiteralExpression(child)
          ? ts.factory.createCallExpression(
              ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier('globalThis'),
                '__a0_array_allocation',
              ),
              undefined,
              [child],
            )
          : child;
      };
      return (root) => ts.visitNode(root, visit) as ts.SourceFile;
    },
  ]);
  try {
    const output = transformed.transformed[0];
    assert.ok(output);
    return ts.createPrinter().printFile(output);
  } finally {
    transformed.dispose();
  }
}

function observe(invoke: () => unknown) {
  const rows: { kind: string; length: number; copy: boolean }[] = [];
  const saved: { prototype: object; key: string; descriptor: PropertyDescriptor | undefined }[] =
    [];
  const globals = new Map<string, unknown>();
  const bump = (kind: string, length: number, copy = false): void => {
    rows.push({ kind, length, copy });
  };
  const originalArray = Array,
    originalU32 = Uint32Array,
    originalU8 = Uint8Array;
  function method(prototype: object, key: string, kind: string): void {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    const fn: unknown = Reflect.get(prototype, key);
    assert.equal(typeof fn, 'function');
    saved.push({ prototype, key, descriptor });
    Object.defineProperty(prototype, key, {
      configurable: true,
      writable: true,
      value: function (this: unknown, ...args: unknown[]) {
        const result = Reflect.apply(fn as (...args: unknown[]) => { length: number }, this, args);
        bump(kind, result.length, key === 'slice');
        return result;
      },
    });
  }
  const literal = Object.getOwnPropertyDescriptor(globalThis, '__a0_array_allocation');
  Object.defineProperty(globalThis, '__a0_array_allocation', {
    configurable: true,
    writable: true,
    value: (value: unknown[]) => {
      bump('literal', value.length);
      return value;
    },
  });
  let value: unknown;
  try {
    for (const [name, ctor, kind] of [
      ['Array', originalArray, 'array-constructor'],
      ['Uint32Array', originalU32, 'u32-constructor'],
      ['Uint8Array', originalU8, 'bool-constructor'],
    ] as const) {
      globals.set(name, Reflect.get(globalThis, name));
      Reflect.set(
        globalThis,
        name,
        new Proxy(ctor, {
          construct(target, args, newTarget) {
            const result = Reflect.construct(target, args, newTarget) as { length: number };
            bump(kind, result.length);
            return result;
          },
        }),
      );
    }
    method(originalArray.prototype, 'slice', 'record-slice');
    method(originalArray.prototype, 'map', 'record-map');
    method(originalU32.prototype, 'slice', 'u32-slice');
    method(originalU8.prototype, 'slice', 'bool-slice');
    value = invoke();
  } finally {
    for (const { prototype, key, descriptor } of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(prototype, key);
      else Object.defineProperty(prototype, key, descriptor);
    }
    for (const [name, original] of globals) Reflect.set(globalThis, name, original);
    if (literal === undefined) Reflect.deleteProperty(globalThis, '__a0_array_allocation');
    else Object.defineProperty(globalThis, '__a0_array_allocation', literal);
  }
  const byKind: Record<string, { allocations: number; elements: number }> = {};
  for (const row of rows) {
    const count = byKind[row.kind] ?? { allocations: 0, elements: 0 };
    byKind[row.kind] = count;
    count.allocations++;
    count.elements += row.length;
  }
  return {
    value,
    counts: {
      allocations: rows.length,
      slices: rows.filter((row) => row.copy).length,
      copiedElements: rows.filter((row) => row.copy).reduce((sum, row) => sum + row.length, 0),
      byKind,
    },
  };
}

function plain(value: unknown): unknown {
  return ArrayBuffer.isView(value) || Array.isArray(value)
    ? Array.from(value as ArrayLike<unknown>, plain)
    : value;
}

/** Native A0 output only. These fixed counts came from the pre-candidate TS
 * fixtures; alias formulas are handwritten immutable BigInt models. */
export async function checkOwnership(
  emit: (source: string) => CandidateResult | Promise<CandidateResult>,
  dir: string,
): Promise<{ lifecycle: number; aliases: number; comparisons: number }> {
  await mkdir(dir, { recursive: true });
  let index = 0,
    comparisons = 0;
  async function load(source: string): Promise<Module> {
    const result = await emit(source);
    assert.equal(result.code, 0);
    const file = join(dir, `ownership-${index++}.mjs`);
    await writeFile(file, instrumentArrays(result.text));
    const previous = Object.getOwnPropertyDescriptor(globalThis, '__a0_array_allocation');
    observedGlobal.__a0_array_allocation = (value) => value;
    try {
      return (await import(pathToFileURL(file).href)) as Module;
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, '__a0_array_allocation');
      else Object.defineProperty(globalThis, '__a0_array_allocation', previous);
    }
  }
  for (const fixture of LIFECYCLE) {
    const reference = parseAndValidate(fixture.source).byName.get(fixture.entry);
    assert.ok(reference);
    const expected = run(reference, [7, 13]);
    const module = await load(fixture.source),
      invoke = module[fixture.entry];
    assert.ok(invoke);
    const result = observe(() => invoke(7, 13));
    assert.deepEqual(result.value, expected, fixture.name);
    assert.deepEqual(result.counts, fixture.counts, fixture.name);
    comparisons++;
  }
  for (const fixture of CONTROLS) {
    const module = await load(fixture.source),
      invoke = module.probe;
    assert.ok(invoke);
    for (const args of fixture.inputs ?? INPUTS) {
      const expected = fixture.expected(args);
      const result = observe(() => invoke(...args));
      assert.deepEqual(plain(result.value), plain(expected), fixture.name);
      assert.equal(result.counts.slices, fixture.slices, fixture.name);
      comparisons++;
    }
  }
  return { lifecycle: LIFECYCLE.length, aliases: CONTROLS.length, comparisons };
}
