/**
 * Build a0lang.com: site/page.a0 and site/docs.a0 (each with what it `use`s) -> C -> wasm32
 * (clang + wasm-ld), the generic runtime (site/app.ts -> site/dist/app.js via tsc), the HTML
 * shells, and the self-hosted Geist fonts. Output: site/dist/. Nothing is deployed by this script.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { compile } from '../src/backends.js';
import { link } from '../src/link.js';
import { compileWasm, runTool } from '../src/toolchain.js';

const out = join('site', 'dist');

/** Link an A0 entry program, compile it to C and wasm32, and write both to site/dist. */
async function buildProgram(entry: string, outName: string): Promise<string> {
  // The io buffers are widened because a page writes its stylesheet and every string as words.
  const program = (await link(join('site', entry), (p) => readFile(p, 'utf8'))).program;
  const c = compile(program, 'c', { ioInputCapacity: 512, ioOutputCapacity: 65536 }).text;
  const wasm = await compileWasm(c);
  await writeFile(join(out, `${outName}.wasm`), wasm.bytes);
  await writeFile(join(out, `${outName}.c`), c, 'utf8');
  return `${outName}.wasm ${wasm.bytes.length} bytes (${wasm.compiler})`;
}

/** Copy the variable Geist faces out of the `geist` package into site/dist/fonts. */
async function copyFonts(): Promise<void> {
  // `geist/package.json` is not exported by the package, so resolve an exported entry and walk
  // up to its dist directory, which holds the fonts.
  const fonts = join(dirname(createRequire(import.meta.url).resolve('geist/font')), 'fonts');
  await mkdir(join(out, 'fonts'), { recursive: true });
  for (const f of [
    'geist-sans/Geist-Variable.woff2',
    'geist-mono/GeistMono-Variable.woff2',
    'geist-pixel/GeistPixel-Square.woff2',
  ])
    await copyFile(join(fonts, f), join(out, 'fonts', f.slice(f.indexOf('/') + 1)));
}

async function main(): Promise<void> {
  await mkdir(join(out, 'docs'), { recursive: true });
  const sizes = [await buildProgram('page.a0', 'page'), await buildProgram('docs.a0', 'docs')];
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
  await copyFile(join('site', 'favicon.svg'), join(out, 'favicon.svg'));
  await copyFile(join('site', 'docs.html'), join(out, 'docs', 'index.html'));
  await copyFonts();
  process.stdout.write(
    `site/dist: ${sizes.join(', ')}, app.js, index.html, docs/index.html, fonts/\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
