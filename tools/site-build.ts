/**
 * Build a0lang.com: site/page.a0 + examples/life.a0 -> C -> wasm32 (clang + wasm-ld), and the
 * generic runtime (site/app.ts -> site/dist/app.js via tsc). Output: site/dist/.
 * Nothing is deployed by this script.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compile } from '../src/backends.js';
import { link } from '../src/link.js';
import { compileWasm, runTool } from '../src/toolchain.js';

async function main(): Promise<void> {
  const out = join('site', 'dist');
  await mkdir(out, { recursive: true });
  // The site is one A0 program: site/page.a0 and what it `use`s (examples/life.a0), linked
  // into one namespace. The io buffers are widened because the page writes its stylesheet
  // and every string as words.
  const program = (await link(join('site', 'page.a0'), (p) => readFile(p, 'utf8'))).program;
  const c = compile(program, 'c', { ioInputCapacity: 512, ioOutputCapacity: 65536 }).text;
  const wasm = await compileWasm(c);
  await writeFile(join(out, 'page.wasm'), wasm.bytes);
  await writeFile(join(out, 'page.c'), c, 'utf8');
  const sizes = [`page.wasm ${wasm.bytes.length} bytes`];
  const compiler = wasm.compiler;
  const tsc = join('node_modules', '.bin', 'tsc');
  const r = runTool(tsc, [
    '--strict',
    '--target',
    'es2022',
    '--module',
    'es2022',
    '--moduleResolution',
    'bundler',
    '--lib',
    'es2022,dom',
    '--types',
    'node',
    '--outDir',
    out,
    join('site', 'app.ts'),
  ]);
  if (!r.ok) throw new Error(`tsc failed:\n${r.stdout}${r.stderr}`);
  await copyFile(join('site', 'index.html'), join(out, 'index.html'));
  process.stdout.write(`site/dist: ${sizes.join(', ')} (${compiler}), app.js, index.html\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
