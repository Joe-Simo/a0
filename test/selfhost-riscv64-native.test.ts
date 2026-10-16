import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findClang } from '../src/toolchain.js';
import { ABI_SOURCE, abiCases } from './fixtures/native-ports/abi.js';
import { NATIVE_PORT_SOURCE, nativePortCases } from './fixtures/native-ports/semantic.js';
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
    scratch = await mkdtemp(join(tmpdir(), 'a0-riscv64-source-'));
    return buildNativeSourceCompiler({
      module: 'compiler/emit_riscv64.a0',
      entry: 'emitriscvio',
      dir: scratch,
      clang,
    });
  })();
  return prepared;
}

test('riscv64 independent instruction model matches fixed ISA register/flag vectors', async () => {
  (await instructionModel('riscv64')).verifyModel();
});

test('seed-built A0 riscv64 source packets reject capacity and incomplete framing before output', {
  skip,
}, async () => {
  const compiler = await prepare();
  assertSourcePacketBoundaries(compiler);
  const strict = compiler.runSource('profile strict\nfn f -> u32\nret 0\nend\n');
  assert.equal(strict.code, 2);
  assert.equal(strict.text, '');
});

test('seed-built A0 riscv64 ELF bytes preserve independent semantics and aggregate ABI in an instruction model', {
  skip,
}, async (t) => {
  const compiler = await prepare();
  assert.ok(scratch);
  const unavailable = await crossLinkUnavailable('riscv64', clang, scratch);
  if (unavailable) {
    t.skip(unavailable);
    return;
  }
  const emitted = compiler.runSource(NATIVE_PORT_SOURCE + ABI_SOURCE);
  assert.equal(emitted.code, 0, emitted.stderr);
  const cases = [...nativePortCases(), ...abiCases()];
  assert.ok(cases.length > 3000);
  const cpu = await assembleModel('riscv64', clang, scratch, emitted.text, 'a0_cadd_v');
  assertModelCases('riscv64', cpu, cases);
  // This executes an independent instruction model, not ARM/RISC hardware or QEMU.
});
