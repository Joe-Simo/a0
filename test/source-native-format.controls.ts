/** Actual C-derived/direct/JS arena integration; explicit current artifacts, no skipped controls. */
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
import { type NativeApi, nativeSource, nativeSourceApi } from '../src/source-native.js';
import { PARSED_VECTOR_WIDTHS, SPEC_VECTOR_WIDTHS } from '../src/source-native-compose.js';
import type { NativeFormatOptions } from '../src/source-native-format.js';
import type { NativeDiagnosticOptions } from '../src/source-native-render.js';
import { readWasmWords } from '../src/wasm-words.js';
import { prepareJsSource } from '../tools/source-js-load.js';
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
import {
  assertProgramFormatting,
  assertProgramFormattingFailures,
} from './fixtures/arena-format/program-activation.js';
import type { ComponentResult } from './fixtures/arena-format/transport.js';

const frontendPath = process.env.A0_FORMAT_FRONTEND;
const formatPath = process.env.A0_FORMAT_COMPANION;
const arenaPath = process.env.A0_FORMAT_ARENA;
const diagnosticPath = process.env.A0_FORMAT_DIAGNOSTIC;
const jsPath = process.env.A0_FORMAT_JS;
assert.ok(
  frontendPath && formatPath && arenaPath && diagnosticPath && jsPath,
  'A0_FORMAT_FRONTEND/COMPANION/ARENA/DIAGNOSTIC/JS required',
);
const js = await prepareJsSource(jsPath);
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

test('C-derived: restored unit tables and contract-token storage belong to the new arena', () => {
  const api = new WebAssembly.Instance(frontend).exports as unknown as NativeApi;
  const engine = nativeSourceApi(api, undefined, undefined, companion);
  const vector = (handle: number, count: number): Uint32Array =>
    Uint32Array.from(readWasmWords(api.memory.buffer, api.frontend_view(handle), count));
  const source =
    '# header\r\nprofile strict\r\nuse "dep😀.a0"\r\nfn contracts _ _ _ -> _\r\npre lt C 10\r\npost eq A r\r\nret A\r\nend\r\n# tail\r\n';
  try {
    const unit = engine.parseUnit(source);
    assert.ok(unit.ok);
    const parsed = [...unit.state],
      specs = [...unit.specState];
    const original = new Map(
      PARSED_VECTOR_WIDTHS.map(([slot]) => [
        slot,
        vector(parsed[slot] as number, parsed[slot + 1] as number),
      ]),
    );
    const originalSpecs = new Map(
      [...SPEC_VECTOR_WIDTHS.map(([slot]) => slot), 59].map((slot) => [
        slot,
        vector(specs[slot] as number, specs[slot + 1] as number),
      ]),
    );
    assert.ok((originalSpecs.get(59)?.length ?? 0) > 0, 'real contract-token storage');
    const before = engine.format(unit, { mapping: true });
    assert.ok(before.ok);
    engine.parse(simple);
    const active = engine.activateUnitForFormat(unit);
    assert.ok(active.ok);
    const restored = Array.from(readWasmWords(api.memory.buffer, api.frontend_ir_state(), 128));
    const restoredSpecs = vector(restored[59] as number, restored[60] as number);
    assert.deepEqual(
      vector(restored[6] as number, restored[7] as number),
      Uint32Array.from(new TextEncoder().encode(source)),
      'original UTF8 and CRLF bytes, without graph composition',
    );
    for (const [slot, words] of original)
      assert.deepEqual(vector(restored[slot] as number, restored[slot + 1] as number), words);
    for (const [slot, words] of originalSpecs)
      assert.deepEqual(
        vector(restoredSpecs[slot] as number, restoredSpecs[slot + 1] as number),
        words,
      );
    for (const slot of [0, 8, 10, 24, 25, 26, 30, 93, 96])
      assert.equal(restored[slot], parsed[slot], `retained parser fact ${slot}`);
    assert.deepEqual([...restoredSpecs.slice(53, 59)], [0, 0, 0, 0, 0, 0]);
    assert.equal(restoredSpecs[6], restored[6], 'same new source ownership');
    assert.deepEqual([...restoredSpecs.slice(80, 86)], restored.slice(62, 68));
    const after = engine.format(active.input, { mapping: true });
    assert.ok(after.ok);
    assert.deepEqual(after.bytes, before.bytes);
    assert.deepEqual(after.events, before.events);
  } finally {
    engine.close();
  }
});
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
  [
    'JS',
    (formatting?: NativeFormatOptions, diagnostics?: NativeDiagnosticOptions) =>
      js.instantiate(diagnostics, formatting),
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
  test(`${backend}: structured formatting-only activation retains authoring and reenters checked graphs through source`, async () => {
    const engine = factory(companion),
      peer = factory(companion);
    try {
      await assertProgramFormatting(engine, peer);
    } finally {
      engine.close();
      peer.close();
    }
  });
  test(`${backend}: structured formatting activation preserves refusals, recovery and lifetime`, () => {
    const engine = factory(companion),
      peer = factory(companion);
    try {
      assertProgramFormattingFailures(engine, peer);
    } finally {
      engine.close();
      peer.close();
    }
  });

  test(`${backend}: explicit unit formatting activation restores imports and metadata after graph checking`, () => {
    const engine = factory(companion);
    const peer = factory(companion);
    const source =
      '# header\r\nprofile strict # profile\r\n# import lead\r\nuse "dep😀.a0" # import\r\n# function\r\nfn local\r\nex 1 -> 1 # example\r\npre lt A 10 # pre\r\npost eq A r # post\r\nx external A # node\r\nret x # return\r\nend # end\r\n# tail\r\n';
    try {
      const refused = engine.parseUnit('fn f\nret\nend\n');
      assert.ok(!refused.ok);
      const unit = engine.parseUnit(source);
      assert.ok(unit.ok);
      const before = engine.format(unit, { mapping: true });
      assert.ok(before.ok);
      assert.equal(before.text, formatSource(parseSource(source)));
      const revision = engine.revision(unit);
      const semantic = engine.revision(unit, { kind: 'semantic' });
      const dependency = engine.parseUnit('profile strict\nfn external\nret A\nend\n');
      assert.ok(dependency.ok);
      const graph = engine.checkUnits([dependency, unit], 'strict');
      assert.ok(graph.ok);
      const foreign = peer.parseUnit(source);
      assert.ok(foreign.ok);
      for (const invalid of [refused, foreign, { ...unit }])
        assert.throws(() => engine.activateUnitForFormat(invalid), /parsed unit owned/);
      for (const budget of [-1, 0.5, NaN, Infinity, 0x1_0000_0000])
        assert.throws(() => engine.activateUnitForFormat(unit, budget), /allocation budget/);
      assert.ok(engine.format(graph).ok, 'preflight refusals leave the live graph intact');

      (unit.state as number[]).fill(0xffff_ffff);
      (unit.specState as number[]).fill(0xffff_ffff);
      Object.assign(unit.program, { functions: [], uses: ['forged.a0'], profile: undefined });
      const activated = engine.activateUnitForFormat(unit);
      assert.ok(activated.ok);
      assert.deepEqual(Object.keys(activated.input), [], 'formatting input exposes no checked IR');
      assert.throws(() => engine.format(graph), /current result owned/);
      assert.throws(() => engine.format(unit), /current result owned/);
      assert.throws(() => engine.format({ ...activated.input }), /current result owned/);
      assert.throws(() => peer.format(activated.input), /current result owned/);
      const formatted = engine.format(activated.input, { mapping: true });
      assert.ok(formatted.ok);
      assert.equal(formatted.text, before.text);
      assert.deepEqual(formatted.bytes, before.bytes);
      assert.deepEqual(formatted.events, before.events);
      assert.deepEqual(engine.revision(activated.input), revision);
      assert.deepEqual(engine.revision(activated.input, { kind: 'semantic' }), semantic);
      assert.ok(engine.checkUnits([dependency, unit], 'strict').ok);
      assert.throws(() => engine.format(activated.input), /current result owned/);

      const noBudget = engine.activateUnitForFormat(unit, 0);
      assert.deepEqual(noBudget, { ok: false, status: 4 });
      const recovered = engine.activateUnitForFormat(unit);
      assert.ok(recovered.ok && engine.format(recovered.input).ok);
      engine.parse(simple);
      assert.throws(() => engine.format(recovered.input), /current result owned/);
      const next = engine.activateUnitForFormat(unit);
      assert.ok(next.ok);
      engine.checkProgram(parseSource(simple));
      assert.throws(() => engine.revision(next.input), /current result owned/);
      const previous = engine.activateUnitForFormat(unit);
      const current = engine.activateUnitForFormat(unit);
      assert.ok(previous.ok && current.ok);
      assert.throws(() => engine.format(previous.input), /current result owned/);
      engine.close();
      assert.throws(() => engine.activateUnitForFormat(unit), /closed/);
      assert.throws(() => engine.format(current.input), /closed/);
      assert.equal(formatted.text, before.text, 'detached output survives close');
    } finally {
      engine.close();
      peer.close();
    }
  });

  test(`${backend}: unit activation preserves functionless files and nested specification storage`, () => {
    const engine = factory(companion);
    try {
      for (const source of [
        '# head\nprofile strict # profile\nuse "dep😀.a0" # import\n# file tail\n',
        'fn nested -> _x3\nex -> [7*3]\na [7*3]\nret a\nend\n',
      ]) {
        const unit = engine.parseUnit(source);
        assert.ok(unit.ok);
        const before = engine.format(unit, { mapping: true });
        assert.ok(before.ok);
        const hash = engine.revision(unit);
        engine.parse(simple);
        const active = engine.activateUnitForFormat(unit);
        assert.ok(active.ok);
        const after = engine.format(active.input, { mapping: true });
        assert.ok(after.ok);
        assert.equal(after.text, formatSource(parseSource(source)));
        assert.deepEqual(after.bytes, before.bytes);
        assert.deepEqual(after.events, before.events);
        assert.deepEqual(engine.revision(active.input), hash);
      }
    } finally {
      engine.close();
    }
  });

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
