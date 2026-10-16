import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Value } from '../../src/core.js';
import { runTool, type ToolInfo } from '../../src/toolchain.js';
import type { Case } from '../../tools/corpus.js';

export type ModelArchitecture = 'riscv64' | 'arm32';
export interface PortModel {
  readonly mem: Buffer;
  readonly instructions: number;
  call(
    name: string,
    args: readonly (number | bigint | boolean)[],
    options?: { sret: number },
  ): number;
  store(address: number, width: number, value: number | bigint): void;
  load(address: number, width: number): number | bigint;
}
interface ModelModule {
  readonly Model: new (elf: Buffer) => PortModel;
  verifyModel(): unknown;
}

export async function instructionModel(architecture: ModelArchitecture): Promise<ModelModule> {
  const file = architecture === 'riscv64' ? 'rv64-model.mjs' : 'a32-model.mjs';
  const imported = await import(pathToFileURL(resolve('test/fixtures/native-ports', file)).href);
  return {
    Model: architecture === 'riscv64' ? imported.RV64 : imported.A32,
    verifyModel: imported.verifyModel,
  };
}

function assemblerArgs(architecture: ModelArchitecture): string[] {
  return architecture === 'riscv64'
    ? ['-target', 'riscv64-unknown-linux-gnu', '-march=rv64im', '-mabi=lp64']
    : ['-target', 'armv7-linux-gnueabihf', '-marm', '-march=armv7-a'];
}

/** Probe a fixed program, so missing cross tools are distinct from emitter failures. */
export async function crossLinkUnavailable(
  architecture: ModelArchitecture,
  clang: ToolInfo,
  dir: string,
): Promise<string | false> {
  assert.ok(clang.path);
  const header =
    architecture === 'riscv64'
      ? '.option norvc\n.option norelax\n'
      : '.syntax unified\n.arch armv7-a\n.arm\n.eabi_attribute 28,1\n';
  const ret = architecture === 'riscv64' ? 'ret' : 'bx lr';
  const assembly = join(dir, `probe-${architecture}.s`);
  await writeFile(assembly, `${header}.text\n.globl native_probe\nnative_probe:\n${ret}\n`);
  const result = runTool(
    clang.path,
    [
      ...assemblerArgs(architecture),
      '-nostdlib',
      '-fuse-ld=lld',
      '-Wl,-e,native_probe',
      assembly,
      '-o',
      join(dir, `probe-${architecture}.elf`),
    ],
    { timeoutMs: 60_000 },
  );
  return result.ok
    ? false
    : `${architecture} clang/lld cross-linking unavailable: ${result.stderr.split('\n')[0]}`;
}

export async function assembleModel(
  architecture: ModelArchitecture,
  clang: ToolInfo,
  dir: string,
  text: string,
  entry: string,
): Promise<PortModel> {
  assert.ok(clang.path);
  const assembly = join(dir, 'module.s');
  const elf = join(dir, 'program.elf');
  await writeFile(assembly, text);
  const result = runTool(
    clang.path,
    [
      ...assemblerArgs(architecture),
      '-nostdlib',
      '-fuse-ld=lld',
      '-Wl,-Ttext=0x10000',
      `-Wl,-e,${entry}`,
      assembly,
      '-o',
      elf,
    ],
    { timeoutMs: 60_000 },
  );
  assert.ok(result.ok, result.stderr);
  const model = await instructionModel(architecture);
  model.verifyModel();
  return new model.Model(await readFile(elf));
}

function scalar(value: Value): number {
  assert.ok(typeof value === 'number' || typeof value === 'boolean');
  return Number(value);
}

/** Independent machine decoding plus independent bigint/truth-table expected values. */
export function assertModelCases(
  architecture: ModelArchitecture,
  cpu: PortModel,
  cases: readonly Case[],
): void {
  const word = (value: number): number | bigint =>
    architecture === 'riscv64' ? BigInt(value) : value;
  const io = 0x2000000;
  for (const item of cases) {
    cpu.mem.fill(0, io, io + 4 * (256 + 1024 + 3));
    const args: (number | bigint)[] = item.args.map(scalar);
    if (item.input !== undefined) {
      for (const [i, value] of item.input.entries()) cpu.store(io + i * 4, 4, word(value));
      cpu.store(io + 256 * 4, 4, word(item.input.length));
      args.push(word(io));
    }
    assert.equal(
      cpu.call(`a0_${item.functionName}`, args),
      scalar(item.expected),
      `${item.functionName}(${item.args.map(scalar)})`,
    );
    if (item.expectedOutput !== undefined) {
      const count = Number(cpu.load(io + (256 + 2 + 1024) * 4, 4));
      const output = Array.from({ length: count }, (_, i) =>
        Number(cpu.load(io + (256 + 2 + i) * 4, 4)),
      );
      assert.deepEqual(output, item.expectedOutput, item.functionName);
    }
  }
  for (const [i, value] of [11, 12, 13, 0, 0].entries()) cpu.store(io + i * 4, 4, word(value));
  cpu.call('a0_abi_pack', [word(io), 4, true, 17, 19, 23, 29, 77], { sret: io });
  assert.deepEqual(
    Array.from({ length: 5 }, (_, i) => Number(cpu.load(io + i * 4, 4))),
    [11, 77, 13, 92, 1],
    'sret may alias an aggregate parameter',
  );
  assert.ok(cpu.instructions > 1000);
}
