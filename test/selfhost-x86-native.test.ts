import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseAndValidate, type Type, type TypedProgram, type Value } from '../src/core.js';
import { findClang, runTool, spawnWithInput } from '../src/toolchain.js';
import type { Case } from '../tools/corpus.js';
import { cDriver } from '../tools/verify.js';
import { ABI_SOURCE, abiCases } from './fixtures/native-ports/abi.js';
import { NATIVE_PORT_SOURCE, nativePortCases } from './fixtures/native-ports/semantic.js';
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
    scratch = await mkdtemp(join(tmpdir(), 'a0-x86-source-'));
    return buildNativeSourceCompiler({
      module: 'compiler/emit_x86_64.a0',
      entry: 'emitx86io',
      dir: scratch,
      clang,
    });
  })();
  return prepared;
}
const scalar = (value: Value): number => {
  assert.ok(typeof value === 'number' || typeof value === 'boolean');
  return Number(value);
};
const cType = (type: Type): string => {
  assert.ok(type === 'u32' || type === 'bool' || type === 'io');
  return type === 'u32' ? 'uint32_t' : type === 'bool' ? 'bool' : 'a0_io*';
};
function nativeHeader(program: TypedProgram): string {
  const declarations = program.functions.flatMap((fn) => {
    if (!(fn.result === 'u32' || fn.result === 'bool')) return [];
    if (!fn.params.every((type) => type === 'u32' || type === 'bool' || type === 'io')) return [];
    return [
      `extern ${cType(fn.result)} a0_${fn.name}(${fn.params.map(cType).join(',') || 'void'});`,
    ];
  });
  return `#include <stdint.h>
#include <stdbool.h>
typedef struct { uint32_t input[256],ninput,position,output[1024],noutput; } a0_io;
${declarations.join('\n')}
extern void a0_abi_pack(uint32_t*,const uint32_t*,uint32_t,bool,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t);
static int sret_alias_probe(void) {
  uint32_t value[5] = {11,12,13,0,0};
  a0_abi_pack(value,value,4,true,17,19,23,29,77);
  return value[0] != 11 || value[1] != 77 || value[2] != 13 || value[3] != 92 || value[4] != 1;
}
`;
}
function caseInput(program: TypedProgram, cases: readonly Case[]): string {
  const names = new Map(program.functions.map((fn, i) => [fn.name, i]));
  return `${cases
    .map((item) =>
      [
        names.get(item.functionName),
        ...item.args.map(scalar),
        ...(item.input === undefined ? [] : [item.input.length, ...item.input]),
      ].join(' '),
    )
    .join('\n')}\n`;
}

test('seed-built A0 x86 source packets reject capacity and incomplete framing before output', {
  skip,
}, async () => {
  const compiler = await prepare();
  assertSourcePacketBoundaries(compiler);
  for (const source of [
    'profile strict\nfn f -> u32\nret 0\nend\n',
    'profile strict\nfn f u32 -> (u32,bool)\nr cdiv p0 0\nret r\nend\n',
  ]) {
    const got = compiler.runSource(source);
    assert.equal(got.code, 2);
    assert.equal(got.text, '');
  }
});

test('seed-built A0 x86 assembly preserves independent arithmetic, IO and aggregate ABI oracles', {
  skip:
    skip ||
    (process.platform !== 'linux' || process.arch !== 'x64'
      ? 'generated Linux x86-64 runtime test requires a Linux x86-64 host'
      : false),
}, async () => {
  const compiler = await prepare();
  assert.ok(scratch && clang.path);
  const source = NATIVE_PORT_SOURCE + ABI_SOURCE;
  const program = parseAndValidate(source);
  const cases = [...nativePortCases(), ...abiCases()];
  assert.ok(cases.length > 3000);
  const emitted = compiler.runSource(source);
  assert.equal(emitted.code, 0, emitted.stderr);
  const assembly = join(scratch, 'module.s');
  const driver = join(scratch, 'driver.c');
  const exe = join(scratch, 'program');
  await writeFile(assembly, emitted.text);
  await writeFile(
    driver,
    cDriver(program, nativeHeader(program)).replace(
      'int main(void) {',
      'int main(void) { if (sret_alias_probe()) return 91;',
    ),
  );
  const built = runTool(
    clang.path,
    ['-O2', '-Wall', '-Wextra', '-Werror', assembly, driver, '-o', exe],
    {
      timeoutMs: 60_000,
    },
  );
  assert.ok(built.ok, built.stderr);
  const ran = spawnWithInput(exe, Buffer.from(caseInput(program, cases)), { timeout: 60_000 });
  assert.equal(ran.error, undefined);
  assert.equal(ran.status, 0, ran.stderr.toString());
  const lines = ran.stdout.toString('utf8').trim().split('\n');
  assert.equal(lines.length, cases.length);
  for (const [i, item] of cases.entries()) {
    assert.equal(
      lines[i],
      [scalar(item.expected), ...(item.expectedOutput ?? [])].join(' '),
      `${item.functionName}(${item.args.map(scalar)})`,
    );
  }
  assert.ok((await readFile(assembly, 'utf8')).includes('a0_abi_pack:'));
});
