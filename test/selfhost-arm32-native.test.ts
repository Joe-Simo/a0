import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findClang } from '../src/toolchain.js';
import { ABI_SOURCE, abiCases } from './fixtures/native-ports/abi.js';
import { NATIVE_PORT_PURE_SOURCE, nativePortPureCases } from './fixtures/native-ports/semantic.js';
import {
  assembleModel,
  assertModelCases,
  crossLinkUnavailable,
  instructionModel,
} from './helpers/native-port-model.js';
import {
  buildNativeSourceCompiler,
  type NativeSourceCompiler,
} from './helpers/native-source-compiler.js';
import { assertSourcePacketBoundaries } from './helpers/source-packet-boundaries.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
let scratch: string | undefined;
let prepared: Promise<NativeSourceCompiler> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});
function prepare(): Promise<NativeSourceCompiler> {
  prepared ??= (async () => {
    scratch = await mkdtemp(join(tmpdir(), 'a0-arm32-source-'));
    return buildNativeSourceCompiler({
      module: 'compiler/emit_arm32.a0',
      entry: 'emitarm32io',
      dir: scratch,
      clang,
    });
  })();
  return prepared;
}

test('arm32 independent instruction model matches fixed ISA register/flag vectors', async () => {
  (await instructionModel('arm32')).verifyModel();
});

test('seed-built A0 arm32 source packets reject capacity and incomplete framing before output', {
  skip,
}, async () => {
  const compiler = await prepare();
  assertSourcePacketBoundaries(compiler);
  const strict = compiler.runSource('profile strict\nfn f -> u32\nret 0\nend\n');
  assert.equal(strict.code, 2);
  assert.equal(strict.text, '');
  for (const source of [
    'fn f io -> u32\nw write p0 3\nret 0\nend\n',
    'fn f (u32,io) -> u32\nx at p0 0\nret x\nend\n',
  ]) {
    const got = compiler.runSource(source);
    assert.equal(got.code, 2);
    assert.equal(got.text, '');
  }
});

test('seed-built A0 arm32 ELF bytes preserve independent semantics and aggregate ABI in an instruction model', {
  skip,
}, async (t) => {
  const compiler = await prepare();
  assert.ok(scratch);
  const unavailable = await crossLinkUnavailable('arm32', clang, scratch);
  if (unavailable) {
    t.skip(unavailable);
    return;
  }
  const emitted = compiler.runSource(NATIVE_PORT_PURE_SOURCE + ABI_SOURCE);
  assert.equal(emitted.code, 0, emitted.stderr);
  const cases = [...nativePortPureCases(), ...abiCases()];
  assert.ok(cases.length > 3000);
  const cpu = await assembleModel('arm32', clang, scratch, emitted.text, 'a0_cadd_v');
  assertModelCases('arm32', cpu, cases);
  // This executes an independent instruction model, not ARM/RISC hardware or QEMU.
});
