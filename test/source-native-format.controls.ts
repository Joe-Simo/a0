/** Actual C-derived/direct arena integration; explicit current artifact paths, no skipped controls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { formatProgram, isPrimitive, type Type } from '../src/core.js';
import { link } from '../src/link.js';
import { formatSource, parseSource } from '../src/source.js';
import { type DirectFunction, directSource } from '../src/source-direct.js';
import { nativeSource } from '../src/source-native.js';
import type { NativeFormatOptions } from '../src/source-native-format.js';
import type { NativeDiagnosticOptions } from '../src/source-native-render.js';
import {
  prepareSourceDiagnostic,
  prepareSourceFormat,
  prepareSourceFrontend,
} from '../tools/source-native-load.js';
import { assertCase } from './fixtures/arena-format/assertions.js';
import {
  formattingCases,
  pressureCases,
  revisionCases,
  type SourceCase,
  selfCase,
} from './fixtures/arena-format/cases.js';
import type { ComponentResult } from './fixtures/arena-format/transport.js';

const frontendPath = process.env.A0_FORMAT_FRONTEND;
const formatPath = process.env.A0_FORMAT_COMPANION;
const arenaPath = process.env.A0_FORMAT_ARENA;
const diagnosticPath = process.env.A0_FORMAT_DIAGNOSTIC;
assert.ok(
  frontendPath && formatPath && arenaPath && diagnosticPath,
  'A0_FORMAT_FRONTEND/COMPANION/ARENA/DIAGNOSTIC required',
);
const companion = await prepareSourceFormat(formatPath);
const diagnostic = await prepareSourceDiagnostic(diagnosticPath);
const native = await prepareSourceFrontend(frontendPath);
assert.equal(native.build.diagnosticPorts, 'arena-v1');
const frontend = new WebAssembly.Module(await readFile(join(frontendPath, 'frontend.wasm')));
const arena = new WebAssembly.Module(await readFile(arenaPath));
const linked = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
assert.equal(
  createHash('sha256').update(formatProgram(linked.program)).digest('hex'),
  native.build.sourceSHA256,
  'C fixture must contain the current A0 frontend closure',
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
const value = (type: Type) => ({ words: words(type), scalar: isPrimitive(type) });
const functions: Record<string, DirectFunction> = {};
for (const name of names) {
  const fn = linked.program.byName.get(name);
  assert.ok(fn, name);
  functions[name] = { params: fn.params.map(value), result: value(fn.result) };
}
const direct = new WebAssembly.Module(
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
  [
    'C-derived',
    (formatting?: NativeFormatOptions, diagnostics?: NativeDiagnosticOptions) =>
      nativeSource(frontend, diagnostics, formatting),
  ],
  [
    'direct',
    (formatting?: NativeFormatOptions, diagnostics?: NativeDiagnosticOptions) =>
      directSource({ frontend: direct, arena, functions }, diagnostics, formatting),
  ],
] as const;
const simple = '# 😀\nfn identity\nret A\nend\n';

function checkRows(engine: ReturnType<typeof nativeSource>, rows: readonly SourceCase[]): void {
  for (const row of rows) {
    if (!row.requests.length) continue; // Invalid legacy spellings are tested by their own parser controls.
    const parsed = row.checked
      ? engine.parse(row.source, 100_000_000)
      : engine.parseUnit(row.source, 100_000_000);
    const state = [...parsed.state],
      specs = [...parsed.specState];
    const results: ComponentResult[] = row.requests.map((request) => {
      if (request.operation === 0) {
        const scope = (['function', 'program', 'source'] as const)[request.mode];
        assert.ok(scope);
        const result = engine.format(parsed, {
          scope,
          functionIndex: request.id,
          mapping: request.mapping,
          skipSpecs: request.skip,
        });
        assert.ok(!('reason' in result), row.name);
        return {
          operation: 0,
          code: result.status,
          text: result.ok ? result.text : '',
          bytes: result.ok ? Buffer.from(result.bytes) : Buffer.alloc(0),
          facts: result.facts,
          events: result.ok ? Array.from(result.events) : [],
        };
      }
      const kind = (['function', 'program', 'semantic'] as const)[request.mode];
      assert.ok(kind);
      const result = engine.revision(parsed, {
        kind,
        functionIndex: request.id,
      });
      assert.ok(!('reason' in result), row.name);
      return {
        operation: 1,
        code: result.status,
        text: result.ok ? result.revision : '',
        bytes: result.ok ? Buffer.from(result.bytes) : Buffer.alloc(0),
        facts: [],
        events: [],
      };
    });
    // sourceUnit completes raw spec grammar successfully; arena_parse alone reports pending7.
    const initial = !row.checked && row.initial === 7 ? 0 : row.initial;
    assertCase(
      { ...row, initial },
      {
        code: parsed.status,
        diagnostic: parsed.state[15] as number,
        functions: (parsed.state[42] as number) / 14,
        results,
      },
    );
    assert.deepEqual(parsed.state, state, `${row.name}: parsed state is immutable`);
    assert.deepEqual(parsed.specState, specs, `${row.name}: spec state is immutable`);
  }
}

for (const [backend, factory] of factories) {
  test(`${backend}: SDK bytes/maps and historical/semantic hashes match independent complete corpus controls`, () => {
    const engine = factory(companion);
    try {
      checkRows(engine, [...formattingCases(), ...revisionCases()]);
    } finally {
      engine.close();
    }
  });

  test(`${backend}: SDK keeps full-word mappings, deep data, compiler and application programs`, async () => {
    const engine = factory(companion);
    try {
      checkRows(engine, pressureCases());
      for (const entry of ['examples/life.a0', 'compiler/source_frontend.a0']) {
        const program = await link(entry, (path) => readFile(path, 'utf8'));
        checkRows(engine, [selfCase(formatProgram(program.program))]);
      }
    } finally {
      engine.close();
    }
  });

  test(`${backend}: snapshots are private/current, optional loads lazy, packets and maps detached across arena resets`, () => {
    let loads = 0;
    const engine = factory(
      {
        load() {
          loads++;
          return companion.load();
        },
      },
      diagnostic,
    );
    const plain = factory();
    const other = factory(companion);
    try {
      const parsed = engine.parse(simple);
      assert.ok(parsed.ok);
      assert.equal(loads, 0);
      const formatted = engine.format(parsed, { mapping: true });
      assert.ok(formatted.ok);
      const expectedText = formatted.text,
        expectedBytes = [...formatted.bytes],
        expectedEvents = [...formatted.events];
      const hashed = engine.revision(parsed);
      assert.ok(hashed.ok);
      assert.equal(loads, 1);
      (parsed.state as number[]).fill(0xffff_ffff);
      (parsed.specState as number[]).fill(0xffff_ffff);
      Object.assign(parsed.program, { functions: [] });
      const second = engine.format(parsed, { mapping: true });
      assert.ok(second.ok);
      assert.equal(second.text, expectedText, 'caller changes cannot forge native state');
      assert.deepEqual([...second.events], expectedEvents);
      assert.throws(() => engine.format({ ...parsed }), /current result owned/);
      assert.throws(() => other.revision(parsed), /current result owned/);
      assert.deepEqual(plain.format(plain.parse(simple)), { ok: false, reason: 'unavailable' });
      assert.throws(() => engine.parse(`# \ud800\n${simple}`), /unpaired UTF-16/);
      assert.ok(engine.revision(parsed).ok, 'transport refusal did not reset the arena');
      const failure = engine.parse('fn f\nret missing\nend\n');
      assert.ok(!failure.ok && failure.diagnostic && 'packet' in failure.diagnostic);
      assert.ok(failure.diagnostic.rendered.ok, 'diagnostic shared component remains live');
      const packet = JSON.stringify(failure.diagnostic);
      const failedFormat = engine.format(failure);
      assert.ok(!failedFormat.ok && 'status' in failedFormat);
      assert.equal(failedFormat.status, failure.status, 'preserves existing first error');
      const failedHash = engine.revision(failure);
      assert.ok(!failedHash.ok && 'status' in failedHash);
      assert.equal(failedHash.status, failure.status);
      assert.throws(() => engine.format(parsed), /current result owned/);
      const resource = engine.parse(simple, 0);
      assert.equal(resource.status, 4);
      const resourceFormat = engine.format(resource);
      assert.deepEqual(resourceFormat, { ok: false, reason: 'incomplete-ir', sourceStatus: 4 });
      assert.deepEqual(engine.revision(resource), {
        ok: false,
        reason: 'incomplete-ir',
        sourceStatus: 4,
      });
      engine.parse(simple);
      assert.equal(JSON.stringify(failure.diagnostic), packet, 'diagnostic packet detached');
      assert.equal(formatted.text, expectedText);
      assert.deepEqual([...formatted.bytes], expectedBytes);
      assert.deepEqual([...formatted.events], expectedEvents);
      assert.ok(hashed.revision.match(/^[0-9a-f]{64}$/));
      assert.equal(loads, 1);
    } finally {
      engine.close();
      plain.close();
      other.close();
    }
  });

  test(`${backend}: SDK formats typed IR and composed source units without reparsing or host printing`, () => {
    const engine = factory(companion);
    try {
      const first = engine.parseUnit('fn inc\nx add A 1\nret x\nend\n');
      const second = engine.parseUnit('fn main\nx call inc 4\nret x\nend\n');
      assert.ok(first.ok && second.ok);
      const checked = engine.checkUnits([first, second], 'canonical');
      assert.ok(checked.ok);
      const formatted = engine.format(checked);
      assert.ok(formatted.ok);
      assert.equal(
        formatted.text,
        formatSource(
          parseSource('fn inc\nx add A 1\nret x\nend\nfn main\nx call inc 4\nret x\nend\n'),
        ),
      );
      assert.ok(engine.revision(checked, { kind: 'semantic', functionIndex: 1 }).ok);
      const result = engine.checkProgram(checked.program);
      assert.ok(result.ok);
      const again = engine.format(result);
      assert.ok(again.ok);
      assert.equal(again.text, formatted.text);
      assert.throws(() => engine.revision(checked), /current result owned/);
    } finally {
      engine.close();
    }
  });

  test(`${backend}: complete parser state propagates actual formatter allocation failures atomically`, () => {
    const engine = factory(companion);
    try {
      // Discover the exact parser storage requirement, without assuming allocation sizes.
      // The final successful state leaves no allocation word for a new output/event vector.
      let low = 0,
        high = 100_000;
      assert.equal(engine.parseUnit(simple, high).status, 0);
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const result = engine.parseUnit(simple, middle);
        assert.ok(result.status === 0 || result.status === 4);
        if (result.status === 0) high = middle;
        else low = middle + 1;
      }
      const parsed = engine.parseUnit(simple, low);
      assert.equal(parsed.status, 0);
      assert.equal(parsed.state[93], 1, 'complete real schema1 input');
      const state = [...parsed.state],
        specs = [...parsed.specState];
      const format = engine.format(parsed, { mapping: true });
      assert.ok(!format.ok && 'status' in format);
      assert.equal(format.status, 4);
      assert.deepEqual(format.facts.slice(4, 7), [0, 0, 0]);
      assert.equal(format.facts[9], 0);
      const revision = engine.revision(parsed);
      assert.deepEqual(revision, { ok: false, status: 4 });
      assert.deepEqual(parsed.state, state);
      assert.deepEqual(parsed.specState, specs);
      const fresh = engine.parse(simple);
      assert.ok(engine.format(fresh).ok, 'the next owned session starts cleanly');
    } finally {
      engine.close();
    }
  });
}
