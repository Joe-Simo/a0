/** Actual C-first proof for the structured format-only API; requires current explicit artifacts. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatSource, parseSource } from '../src/source.js';
import { type NativeApi, nativeSource, nativeSourceApi } from '../src/source-native.js';
import { readWasmWords } from '../src/wasm-words.js';
import { prepareSourceFormat, prepareSourceFrontend } from '../tools/source-native-load.js';
import {
  assertProgramFormatting,
  assertProgramFormattingFailures,
  authoringProgram,
} from './fixtures/arena-format/program-activation.js';

const frontendPath = process.env.A0_PROGRAM_FORMAT_FRONTEND;
const formatPath = process.env.A0_PROGRAM_FORMAT_COMPANION;
assert.ok(frontendPath && formatPath, 'A0_PROGRAM_FORMAT_FRONTEND/COMPANION required');
const prepared = await prepareSourceFrontend(frontendPath);
assert.equal(prepared.build.diagnosticPorts, 'arena-v1');
const frontend = new WebAssembly.Module(await readFile(join(frontendPath, 'frontend.wasm')));
const companion = await prepareSourceFormat(formatPath);
const factory = () => nativeSource(frontend, undefined, companion);

test('C-derived: formatting-only IR upload retains authoring and printed files enter actual graph checks', async () => {
  const engine = factory(),
    peer = factory();
  try {
    await assertProgramFormatting(engine, peer);
  } finally {
    engine.close();
    peer.close();
  }
});
test('C-derived: formatting-only IR upload preserves representation refusals, recovery and lifetime', () => {
  const engine = factory(),
    peer = factory();
  try {
    assertProgramFormattingFailures(engine, peer);
  } finally {
    engine.close();
    peer.close();
  }
});
test('C-derived: active builder PS/A128 are used without stale published state, parsing or checker finish', () => {
  const api = new WebAssembly.Instance(frontend).exports as unknown as NativeApi;
  let uploadOnly = false;
  const engine = nativeSourceApi(
    {
      ...api,
      frontend_state() {
        assert.equal(uploadOnly, false, 'must not read previous published M');
        return api.frontend_state();
      },
      frontend_specs() {
        assert.equal(uploadOnly, false, 'must not read previous published PS');
        return api.frontend_specs();
      },
      frontend_ir_finish() {
        assert.equal(uploadOnly, false, 'format activation must not check IR');
        return api.frontend_ir_finish();
      },
      frontend_parse(pointer, length, budget) {
        assert.equal(uploadOnly, false, 'format activation must not parse source');
        return api.frontend_parse(pointer, length, budget);
      },
      frontend_parse_unit(pointer, length, budget) {
        assert.equal(uploadOnly, false, 'format activation must not parse a unit');
        return api.frontend_parse_unit(pointer, length, budget);
      },
    },
    undefined,
    undefined,
    companion,
  );
  try {
    const old = engine.parse('fn previous -> bool\nret true\nend\n');
    assert.ok(old.ok);
    const program = authoringProgram();
    uploadOnly = true;
    const active = engine.activateProgramForFormat(program);
    assert.ok(active.ok);
    assert.throws(() => engine.format(old), /current result owned/);
    const parsed = readWasmWords(api.memory.buffer, api.frontend_ir_state(), 128).slice();
    assert.equal(parsed[0], 0);
    assert.equal(parsed[93], 1);
    assert.equal(parsed[96], 0, 'generic input stays unchecked');
    assert.equal(parsed[60], 128);
    const specs = readWasmWords(
      api.memory.buffer,
      api.frontend_view(parsed[59] as number),
      128,
    ).slice();
    assert.equal(specs[6], parsed[6], 'PS source belongs to current builder');
    assert.equal(specs[24], 0xffff_ffff);
    assert.equal(specs[92], 1);
    assert.ok((specs[42] as number) > 0, 'real example storage, not stale previous PS');
    assert.ok((specs[45] as number) > 0, 'real contract storage');
    assert.deepEqual(specs.slice(80, 86), parsed.slice(62, 68));
    const output = engine.format(active.input, { mapping: true });
    assert.ok(output.ok);
    assert.equal(output.text, formatSource(program));
    assert.ok(output.text.includes('# intermediate Ω'));
    assert.ok(output.text.includes('# separate Program tail 😀'));
    assert.deepEqual(engine.revision(active.input, { kind: 'semantic' }), { ok: false, status: 7 });
  } finally {
    engine.close();
  }
});
test('C-derived: missing formatter returns unavailable before IR initialization and leaves checked pages intact', () => {
  const api = new WebAssembly.Instance(frontend).exports as unknown as NativeApi;
  let initializations = 0;
  const engine = nativeSourceApi({
    ...api,
    frontend_ir_init(pointer, length, budget, strict) {
      initializations++;
      return api.frontend_ir_init(pointer, length, budget, strict);
    },
  });
  try {
    const previous = engine.parse('fn previous\nret A\nend\n');
    assert.ok(previous.ok);
    const state = readWasmWords(api.memory.buffer, api.frontend_state(), 128).slice();
    const specs = readWasmWords(api.memory.buffer, api.frontend_specs(), 128).slice();
    assert.deepEqual(engine.activateProgramForFormat(parseSource('fn next\nret A\nend\n')), {
      ok: false,
      reason: 'unavailable',
    });
    assert.equal(initializations, 0);
    assert.deepEqual(readWasmWords(api.memory.buffer, api.frontend_state(), 128), state);
    assert.deepEqual(readWasmWords(api.memory.buffer, api.frontend_specs(), 128), specs);
  } finally {
    engine.close();
  }
});
