import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { type Arm64Module, assembleArm64Text } from '../src/arm64enc.js';
import { compile } from '../src/backends.js';
import { makeIo, parseAndValidate, run, type TypedFunc, type TypedProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { IMPORTS, linkMachO } from '../src/macho.js';
import { closures, generateCorpus, ioFreeSubset } from '../tools/corpus.js';

/**
 * compiler/macho.a0 against src/macho.ts: the arm64 modules of the corpus and the examples
 * (src/arm64.ts text, encoded by src/arm64enc.ts), each whole program and each example function closure,
 * once as is (entry: its first label) and once with a small `_main` that reaches an import
 * through its stub and a bss symbol by page21 / pageoff12, must link to the same bytes.
 */

/** Cases not yet matching byte for byte, with the reason. Empty: every case matches. */
const SKIPS: ReadonlyMap<string, string> = new Map();

/** The input table of compiler/macho.a0 (layout at the top of that file). */
function machoInput(mod: Arm64Module, entry: string): number[][] {
  const labels = [...mod.labels];
  const ids = new Map<string, number>();
  for (const [i, n] of IMPORTS.entries()) ids.set(n, i);
  for (const [k, b] of mod.bss.entries()) ids.set(b.name, 3 + k);
  for (const [k, [n]] of labels.entries()) ids.set(n, 3 + mod.bss.length + k);
  const flat = [
    mod.words.length,
    mod.relocations.length,
    mod.bss.length,
    labels.length,
    mod.bssSize,
    mod.bssAlign,
    mod.labels.get(entry) as number,
    0,
    ...mod.words,
    ...mod.relocations.flatMap((r) => [
      r.offset,
      ['branch26', 'page21', 'pageoff12'].indexOf(r.kind),
      ids.get(r.symbol) ?? 0xffffffff,
    ]),
    ...mod.bss.map((b) => b.offset),
    ...labels.map(([, o]) => o),
  ];
  if (flat.length > 65536) throw new Error('input over 65536 words');
  return Array.from({ length: 512 }, (_, p) =>
    Array.from({ length: 128 }, (_, i) => (flat[p * 128 + i] ?? 0) >>> 0),
  );
}

const HARNESS = (first: string): string =>
  `\t.text\n\t.globl _main\n\t.p2align 2\n_main:\n\tbl ${first}\n\tbl _write\n\tbl _mmap\n\tadrp x9, _a0_buf@PAGE\n\tadd x9, x9, _a0_buf@PAGEOFF\n\tadrp x10, _a0_cnt@PAGE\n\tadd x10, x10, _a0_cnt@PAGEOFF\n\tb ${first}\n\t.zerofill __DATA,__bss,_a0_buf,40000,4\n\t.zerofill __DATA,__bss,_a0_cnt,8,3\n`;

async function cases(): Promise<[string, Arm64Module, string][]> {
  const programs: [string, TypedProgram][] = [['corpus', generateCorpus()]];
  for (const f of (await readdir('examples')).filter((f) => f.endsWith('.a0')).sort())
    programs.push([f, parseAndValidate(await readFile(`examples/${f}`, 'utf8'))]);
  const out: [string, Arm64Module, string][] = [];
  for (const [label, program] of programs) {
    const subset = ioFreeSubset(program);
    if (subset.functions.length === 0) continue;
    const sources: [string, TypedProgram][] = [[label, subset]];
    // The function closures of the examples (the corpus ones repeat its whole module piecewise
    // and would make the test minutes long).
    if (label !== 'corpus')
      for (const [l, src] of closures(label, subset)) sources.push([l, parseAndValidate(src)]);
    for (const [l, p] of sources) {
      const text = compile(p, 'arm64').text;
      const mod = assembleArm64Text(text);
      const first = [...mod.labels.keys()][0] as string;
      out.push([l, mod, first]);
      out.push([`${l} +_main`, assembleArm64Text(text + HARNESS(first)), '_main']);
    }
  }
  return out;
}

test('compiler/macho.a0 writes the bytes of src/macho.ts on the corpus and example modules', async () => {
  const program = (await link('compiler/macho.a0', (p) => readFile(p, 'utf8'))).program;
  const machoio = program.byName.get('machoio') as TypedFunc;
  const all = await cases();
  let matched = 0;
  const failures: string[] = [];
  for (const [label, mod, entry] of all) {
    if (SKIPS.has(label)) continue;
    const want = linkMachO(mod, entry);
    const io = makeIo();
    run(machoio, [machoInput(mod, entry), io], { fuel: 1e10 });
    const got = Buffer.from(io.output);
    if (io.output.length === want.length && got.equals(want)) matched += 1;
    else {
      const at = io.output.findIndex((b, i) => b !== want[i]);
      failures.push(
        `${label}: ${io.output.length} vs ${want.length} bytes, first difference at ${at}`,
      );
    }
  }
  process.stdout.write(
    `macho.a0: ${matched} of ${all.length} modules byte for byte (${SKIPS.size} skipped)\n`,
  );
  assert.deepEqual(failures, []);
  assert.equal(matched + SKIPS.size, all.length);
});

test('compiler/macho.a0 refuses an undefined symbol and a misaligned relocation', async () => {
  const program = (await link('compiler/macho.a0', (p) => readFile(p, 'utf8'))).program;
  const machoio = program.byName.get('machoio') as TypedFunc;
  const mod = assembleArm64Text('_main:\n\tbl _nowhere\n\tret\n');
  const io = makeIo();
  run(machoio, [machoInput(mod, '_main'), io], { fuel: 1e9 });
  assert.deepEqual(io.output, [0xffffffff]);
  assert.throws(() => linkMachO(mod, '_main'), /undefined symbol/);
  const bad = { ...mod, relocations: [{ offset: 2, kind: 'branch26' as const, symbol: '_write' }] };
  const io2 = makeIo();
  run(machoio, [machoInput(bad, '_main'), io2], { fuel: 1e9 });
  assert.deepEqual(io2.output, [0xffffffff]);
});
