/** Explicit live controls: all three artifact paths are required; no native case skips. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import {
  A0Error,
  type Func,
  formatProgram,
  isPrimitive,
  type Type,
  validate,
} from '../src/core.js';
import { link } from '../src/link.js';
import { type DirectFunction, directSource } from '../src/source-direct.js';
import { nativeSource } from '../src/source-native.js';
import type { NativeDiagnosticOptions } from '../src/source-native-render.js';
import { prepareSourceDiagnostic, prepareSourceFrontend } from '../tools/source-native-load.js';
import { irDiagnosticCases } from './fixtures/native-diagnostics/ir-cases.js';

const frontendPath = process.env.A0_IR_DIAGNOSTIC_FRONTEND,
  rendererPath = process.env.A0_IR_DIAGNOSTIC_RENDERER,
  arenaPath = process.env.A0_IR_DIAGNOSTIC_ARENA;
assert.ok(
  frontendPath && rendererPath && arenaPath,
  'A0_IR_DIAGNOSTIC_FRONTEND/RENDERER/ARENA required',
);
const renderer = await prepareSourceDiagnostic(rendererPath);
const native = await prepareSourceFrontend(frontendPath);
assert.equal(native.build.diagnosticPorts, 'arena-v1');
const frontendModule = new WebAssembly.Module(await readFile(join(frontendPath, 'frontend.wasm')));
const arenaModule = new WebAssembly.Module(await readFile(arenaPath));
const linked = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
assert.equal(
  createHash('sha256').update(formatProgram(linked.program)).digest('hex'),
  native.build.sourceSHA256,
  'C-derived artifact must contain this exact shared frontend closure',
);
const names = [
  'arena_parse_verify_begin',
  'arena_source_unit',
  'arena_verify_resume',
  'arena_verify_status',
  'arena_verify_begin',
  'source_ir_init',
  'source_ir_symbol',
  'source_ir_type',
];
const words = (type: Type): number =>
  isPrimitive(type)
    ? 1
    : type.kind === 'arr'
      ? type.length * words(type.elem)
      : type.fields.reduce((sum, field) => sum + words(field), 0);
const shape = (type: Type) => ({ words: words(type), scalar: isPrimitive(type) });
const functions: Record<string, DirectFunction> = {};
for (const name of names) {
  const fn = linked.program.byName.get(name);
  assert.ok(fn, name);
  functions[name] = { params: fn.params.map(shape), result: shape(fn.result) };
}
const directModule = new WebAssembly.Module(
  Buffer.from(
    compile(linked.program, 'wasm', {
      wasmExports: names,
      wasmSimd: true,
      optimize: true,
      wasmIo: { module: 'a0_arena', read: 'a0_runtime_read', write: 'a0_runtime_write' },
    }).text,
    'base64',
  ),
);
const factories = [
  ['C-derived', (options?: NativeDiagnosticOptions) => nativeSource(frontendModule, options)],
  [
    'direct',
    (options?: NativeDiagnosticOptions) =>
      directSource({ frontend: directModule, arena: arenaModule, functions }, options),
  ],
] as const;
const base: Func = {
  name: 'f',
  params: [],
  result: 'u32',
  nodes: [],
  ret: { kind: 'u32', value: 0 },
};

for (const [backend, factory] of factories) {
  test(`${backend}: live structured checker renders exact independent catalog JSON before arena reuse`, () => {
    let loads = 0;
    const engine = factory({
      load: () => {
        loads++;
        return renderer.load();
      },
    });
    const raw = factory();
    try {
      assert.ok(engine.checkProgram({ functions: [base] }).ok);
      assert.equal(loads, 0, 'successful structured checking does not load diagnostics');
      for (const row of irDiagnosticCases()) {
        let expected: ReturnType<A0Error['toJSON']> | undefined;
        try {
          validate(row.program);
        } catch (error) {
          assert.ok(error instanceof A0Error);
          expected = error.toJSON();
        }
        assert.ok(expected);
        assert.equal(expected.id, `A${String(row.id).padStart(4, '0')}`);
        const input = JSON.stringify(row.program);
        const actual = engine.checkProgram(row.program),
          reference = raw.checkProgram(row.program);
        assert.ok(
          !actual.ok &&
            !reference.ok &&
            actual.diagnostic &&
            'packet' in actual.diagnostic &&
            actual.diagnostic.rendered.ok,
          row.name,
        );
        assert.equal(actual.status, 8);
        assert.equal(actual.state[1], row.id);
        assert.deepEqual(actual.state, reference.state, 'rendering preserves checker state');
        assert.deepEqual(actual.specState, reference.specState);
        assert.deepEqual(actual.diagnostic.rendered.error.toJSON(), expected, row.name);
        assert.deepEqual(
          JSON.parse(new TextDecoder().decode(actual.diagnostic.packet.json)),
          expected,
        );
        assert.deepEqual(actual.diagnostic.packet.facts.slice(7, 10), actual.state.slice(109, 112));
        assert.equal(
          actual.diagnostic.rendered.location.path,
          undefined,
          'synthetic IR gains no physical source owner',
        );
        assert.equal(JSON.stringify(row.program), input, 'input IR stays immutable');
        const retained = JSON.stringify(actual);
        assert.ok(engine.checkProgram({ functions: [base] }).ok);
        assert.equal(
          JSON.stringify(actual),
          retained,
          'later checks cannot mutate copied packet/error data',
        );
      }
      assert.equal(loads, 1, 'renderer is reused');
    } finally {
      engine.close();
      raw.close();
    }
  });

  test(`${backend}: unrepresentable IR stays a pre-native refusal and unsupported options publish no JSON`, () => {
    let loads = 0;
    const engine = factory({
      load: () => {
        loads++;
        return renderer.load();
      },
    });
    try {
      for (const name of ['\ud800', 'a\udfff'])
        assert.throws(
          () => engine.checkProgram({ functions: [{ ...base, name }] }),
          /unpaired UTF-16 surrogate/,
        );
      for (const value of [-1, 0.5, 0x1_0000_0000])
        assert.throws(
          () => engine.checkProgram({ functions: [{ ...base, ret: { kind: 'u32', value } }] }),
          /unrepresentable native program IR: expected a u32 word/,
        );
      assert.equal(
        loads,
        0,
        'transport representation failures never claim a native catalog diagnostic',
      );
      assert.ok(engine.checkProgram({ functions: [base] }).ok);
    } finally {
      engine.close();
    }
    const unsupported = factory({ load: renderer.load, options: 2 });
    try {
      const row = irDiagnosticCases().find((row) => row.id === 307);
      assert.ok(row);
      const actual = unsupported.checkProgram(row.program);
      assert.ok(!actual.ok && actual.diagnostic && 'packet' in actual.diagnostic);
      assert.equal(actual.state[1], 307);
      assert.equal(actual.diagnostic.packet.status, 7);
      assert.equal(actual.diagnostic.packet.json.length, 0);
      assert.ok(!actual.diagnostic.rendered.ok);
    } finally {
      unsupported.close();
    }
  });
}
