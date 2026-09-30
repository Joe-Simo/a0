/**
 * Build a0lang.com: site/page.a0, site/docs.a0 and site/play.a0 (each with what it `use`s) -> C -> wasm32
 * (clang + wasm-ld), the generic runtime (site/app.ts -> site/dist/app.js via tsc), the HTML
 * shells, and the self-hosted Geist fonts. Output: site/dist/. Nothing is deployed by this script.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { compile } from '../src/backends.js';
import { link } from '../src/link.js';
import { runTool } from '../src/toolchain.js';
import { wasmModuleBytes } from '../src/wasm.js';
import { prerender } from './site-render.js';

const out = join('site', 'dist');

/** Link an A0 entry program, compile it to C and wasm32, and write both to site/dist. */
interface Built {
  readonly size: string;
  readonly html: string;
  readonly css: string;
  readonly text: string;
}

async function buildProgram(entry: string, outName: string): Promise<Built> {
  // The io buffers are widened because a page writes its stylesheet and every string as words;
  // the input holds the play page's source text (480 bytes) and the state that echoes it.
  // site/app.ts (IN_CAP, OUT_CAP) must use the same capacities.
  const program = (await link(join('site', entry), (p) => readFile(p, 'utf8'))).program;
  // A0's own wasm32 backend (src/wasm.ts): the module is emitted directly, no C, no clang.
  const wasm = wasmModuleBytes(
    compile(program, 'wasm', { ioInputCapacity: 1024, ioOutputCapacity: 65536 }).text,
  );
  await writeFile(join(out, `${outName}.wasm`), wasm);
  // The same program, run once here through the reference interpreter: static HTML for
  // agents and crawlers that do not run JavaScript. The browser re-renders the same tree.
  const pre = prerender(program);
  return { size: `${outName}.wasm ${wasm.length} bytes (A0 wasm32 backend)`, ...pre };
}

/** Put the prerendered tree and stylesheet into a page shell. */
function fill(shell: string, built: Built): string {
  return shell
    .replace('</head>', `  <style>${built.css}</style>\n</head>`)
    .replace(/(<main id="app"[^>]*>)<\/main>/, `$1${built.html}</main>`);
}

/** Files for agents: llms.txt (the convention), the primer, the docs as text, robots, sitemap. */
async function writeAgentFiles(page: Built, docs: Built): Promise<void> {
  const primer = await readFile('MODEL_GUIDE.min.txt', 'utf8');
  const guide = await readFile('MODEL_GUIDE.txt', 'utf8');
  const llms = [
    '# A0',
    '',
    '> The programming language built for AI, not for people. Compact, exactly specified, validated before commit; one program compiles to native machine code, wasm, JavaScript, JVM, .NET, Metal, and SystemVerilog, verified against one oracle.',
    '',
    '## Start here',
    '',
    '- [Primer](https://a0lang.com/primer.txt): the whole language in 388 tokens; this is what a model receives before writing A0.',
    '- [Docs](https://a0lang.com/docs.txt): the reference as plain text (also at /docs/).',
    '- [Full guide](https://a0lang.com/llms-full.txt): primer, docs, and the home page text in one file.',
    '- [Benchmarks](https://a0lang.com/results/exec-benchmark.json): measured numbers behind every chart; losses included.',
    '- [Source](https://github.com/Joe-Simo/a0): MIT; `a0` binaries under Releases, no package manager needed.',
    '',
    '## Rules of the language, in one line each',
    '',
    '(In the Example line, `/` stands for a newline.)',
    '',
    ...primer
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => `- ${l}`),
    '',
  ].join('\n');
  await writeFile(join(out, 'llms.txt'), llms, 'utf8');
  await writeFile(
    join(out, 'llms-full.txt'),
    `# A0 primer (MODEL_GUIDE.min.txt)\n\n${primer}\n\n# A0 guide (MODEL_GUIDE.txt)\n\n${guide}\n\n# Docs\n\n${docs.text}\n\n# Home\n\n${page.text}\n`,
    'utf8',
  );
  await writeFile(join(out, 'primer.txt'), primer, 'utf8');
  await writeFile(join(out, 'docs.txt'), `${docs.text}\n`, 'utf8');
  await writeFile(join(out, 'index.txt'), `${page.text}\n`, 'utf8');
  await writeFile(
    join(out, 'robots.txt'),
    'User-agent: *\nAllow: /\nSitemap: https://a0lang.com/sitemap.xml\n',
    'utf8',
  );
  await writeFile(
    join(out, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
      'https://a0lang.com/',
      'https://a0lang.com/docs/',
      'https://a0lang.com/play/',
      'https://a0lang.com/llms.txt',
      'https://a0lang.com/primer.txt',
    ]
      .map((u) => `  <url><loc>${u}</loc></url>`)
      .join('\n')}\n</urlset>\n`,
    'utf8',
  );
  await mkdir(join(out, 'results'), { recursive: true });
  for (const f of [
    'exec-benchmark.json',
    'verification.json',
    'equivalence.json',
    'hardware.json',
    'tokens.json',
  ])
    await copyFile(join('results', f), join(out, 'results', f));
}

/**
 * Hosting config deployed with site/dist: clean URLs, immutable fonts, and security headers.
 * The CSP allows only same-origin scripts (app.js; the ld+json block is data and never runs),
 * wasm compilation, the runtime's generated <style>, self-hosted fonts, and same-origin fetches.
 */
const VERCEL = {
  cleanUrls: true,
  headers: [
    {
      source: '/(.*)',
      headers: [
        {
          key: 'Content-Security-Policy',
          value:
            "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    },
    {
      source: '/fonts/(.*)',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    },
  ],
} as const;

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
  await mkdir(join(out, 'play'), { recursive: true });
  const page = await buildProgram('page.a0', 'page');
  const docs = await buildProgram('docs.a0', 'docs');
  const play = await buildProgram('play.a0', 'play');
  const sizes = [page.size, docs.size, play.size];
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
  await writeFile(
    join(out, 'index.html'),
    fill(await readFile(join('site', 'index.html'), 'utf8'), page),
    'utf8',
  );
  await copyFile(join('site', 'favicon.svg'), join(out, 'favicon.svg'));
  await writeFile(
    join(out, 'docs', 'index.html'),
    fill(await readFile(join('site', 'docs.html'), 'utf8'), docs),
    'utf8',
  );
  await writeFile(
    join(out, 'play', 'index.html'),
    fill(await readFile(join('site', 'play.html'), 'utf8'), play),
    'utf8',
  );
  await writeAgentFiles(page, docs);
  await copyFonts();
  await writeFile(join(out, 'vercel.json'), `${JSON.stringify(VERCEL, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `site/dist: ${sizes.join(', ')}, app.js, index.html, docs/index.html, play/index.html (prerendered), llms.txt, fonts/\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
