/**
 * Build the browser demo: examples/life.a0 -> C -> wasm32 (clang + wasm-ld), the DOM
 * adapter (site/app.ts -> site/dist/app.js via tsc), and the page. Output: site/dist/.
 * Nothing is deployed by this script.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { compileWasm, runTool } from '../src/toolchain.js';

async function main(): Promise<void> {
  const out = join('site', 'dist');
  await mkdir(out, { recursive: true });
  // Both A0 programs of the site: the page itself and the Life component.
  const sizes: string[] = [];
  let compiler = '';
  for (const [name, source] of [
    ['life', join('examples', 'life.a0')],
    ['page', join('site', 'page.a0')],
  ] as const) {
    const program = parseAndValidate(await readFile(source, 'utf8'));
    const c = compile(program, 'c').text;
    const wasm = await compileWasm(c);
    await writeFile(join(out, `${name}.wasm`), wasm.bytes);
    await writeFile(join(out, `${name}.c`), c, 'utf8');
    sizes.push(`${name}.wasm ${wasm.bytes.length} bytes`);
    compiler = wasm.compiler;
  }
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
