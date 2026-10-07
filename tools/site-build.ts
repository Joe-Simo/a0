/**
 * Build a0lang.com: site/page.a0 and site/docs.a0 (generated first by the A0 site generator,
 * tools/site-gen.ts), each with what it `use`s -> wasm32
 * by the optimizer and the wasm emitter written in A0 (compiler/optimize.a0 and
 * compiler/emit_wasm.a0, built by the bootstrap's C seed: see tools/selfhost-wasm.ts;
 * src/optimize.ts and src/wasm.ts are kept only as the byte-for-byte reference), the generic
 * runtime (site/app.ts -> site/dist/app.js via tsc), the HTML
 * shells, and the self-hosted Geist fonts. Output: site/dist/. Nothing is deployed by this script.
 */

import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { COMPILER_VERSION } from '../src/backends.js';
import { link } from '../src/link.js';
import { findClang, runTool, type ToolInfo } from '../src/toolchain.js';
import { BUILD_DIR } from './bootstrap.js';
import { LIVE_PROGRAMS, type LiveProgramSpec } from './live-programs.js';
import { a0WasmFromTables, buildWasmTool, typescriptWasm } from './selfhost-wasm.js';
import {
  codeDigest,
  HOST,
  keyOf,
  openCache,
  readEntry,
  type SiteCache,
  sha256,
  toolFile,
  writeEntry,
  writeTool,
} from './site-cache.js';
import { buildGenerator, generate } from './site-gen.js';
import { fillShell, SITE_CSP as PAGE_CSP, type Prerendered, prerender } from './site-render.js';
import { loadSource, systemLoad } from './system-load.js';

const out = join('site', 'dist');

/** Told whether a lookup in the cache hit. */
export type Note = (hit: boolean) => void;

/** What a cached program is keyed by besides its own linked sources. */
export interface Keys {
  readonly cache: SiteCache;
  /** SHA-256 of the A0 wasm tool's bytes: the programs it writes are a function of them. */
  readonly tool: string;
  /** The code of this build: the import closure of tools/site-build.ts. */
  readonly code: string;
  readonly note: Note;
}

/** The largest page program a visitor downloads: each page's wasm must stay under this many bytes. */
export const WASM_BUDGET = 1_000_000;

/** Link an A0 entry program, compile it to C and wasm32, and write both to site/dist. */
interface Built {
  readonly size: string;
  readonly html: string;
  readonly css: string;
  readonly text: string;
}

/** The stored files of `kind/key`, or undefined on a miss (or with the cache off); the lookup is noted. */
async function lookup(
  keys: Keys,
  kind: string,
  key: string,
): Promise<Map<string, Buffer> | undefined> {
  if (keys.cache.dir === undefined) return undefined;
  const hit = await readEntry(keys.cache, kind, key);
  keys.note(hit !== undefined);
  return hit;
}

/**
 * Link an A0 entry program, compile it to C and wasm32, and write the wasm to `outDir` with its
 * prerendered page. Keyed by the linked sources of the program, its io layout, the wasm tool, and
 * the code of this build: a hit writes the stored bytes; a miss builds them, checks them against
 * the TypeScript reference, and stores them.
 */
export async function buildProgram(
  a0w: string,
  entry: string,
  outName: string,
  keys: Keys,
  outDir = out,
): Promise<Built> {
  // The io buffers are widened because a page writes its stylesheet and every string as words;
  // the input holds an event, a text field and the page state.
  // site/app.ts (IN_CAP, OUT_CAP) must use the same capacities.
  const linked = await link(join('site', entry), (p) => readFile(p, 'utf8'), { root: '.' });
  const layout = { ioInputCapacity: 1024, ioOutputCapacity: 131072 };
  const key = keyOf(
    'program',
    outName,
    JSON.stringify(layout),
    keys.tool,
    keys.code,
    HOST,
    linked.text,
  );
  const hit = await lookup(keys, 'program', key);
  const stored = hit?.get('program.wasm');
  const storedPage = hit?.get('prerendered.json');
  let wasm: Uint8Array;
  let page: Prerendered;
  if (stored !== undefined && storedPage !== undefined) {
    wasm = stored;
    page = JSON.parse(storedPage.toString('utf8')) as Prerendered;
  } else {
    // The optimizer and the wasm emitter written in A0 write the module; `compile(program,
    // 'wasm')` (src/optimize.ts, then src/wasm.ts) must give the same bytes.
    wasm = a0WasmFromTables(a0w, linked.program, layout, true).bytes;
    if (
      Buffer.compare(
        Buffer.from(wasm),
        Buffer.from(typescriptWasm(linked.program, layout, true)),
      ) !== 0
    )
      throw new Error(`${entry}: the A0 optimizer and wasm emitter differ from src/wasm.ts`);
    if (wasm.length > WASM_BUDGET)
      throw new Error(`${outName}.wasm is ${wasm.length} bytes, over the budget of ${WASM_BUDGET}`);
    // The same program, run once here through the reference interpreter: static HTML for
    // agents and crawlers that do not run JavaScript. The browser re-renders the same tree.
    page = prerender(linked.program);
    await writeEntry(keys.cache, 'program', key, {
      'program.wasm': wasm,
      'prerendered.json': JSON.stringify(page),
    });
  }
  await writeFile(join(outDir, `${outName}.wasm`), wasm);
  return {
    size: `${outName}.wasm ${wasm.length} bytes (compiler/optimize.a0 and emit_wasm.a0, equal to src/wasm.ts)`,
    ...page,
  };
}

/**
 * Compile a live program (site/live.ts runs it frame by frame; there is nothing to prerender): the
 * same A0 optimizer and wasm emitter, with the io sizes of its spec and only `frame` exported.
 * Cached like a page program, keyed by its spec.
 */
async function buildLive(
  a0w: string,
  spec: LiveProgramSpec,
  keys: Keys,
  outDir = out,
): Promise<string> {
  const linked = await link(join('site', spec.entry), (p) => readFile(p, 'utf8'), { root: '.' });
  const layout = {
    ioInputCapacity: spec.inputWords,
    ioOutputCapacity: spec.outputWords,
    exports: ['frame'],
  };
  const key = keyOf(
    'live',
    JSON.stringify(spec),
    JSON.stringify(layout),
    keys.tool,
    keys.code,
    HOST,
    linked.text,
  );
  const hit = await lookup(keys, 'live', key);
  let wasm: Uint8Array | undefined = hit?.get('live.wasm');
  if (wasm === undefined) {
    wasm = a0WasmFromTables(a0w, linked.program, layout, true).bytes;
    if (
      Buffer.compare(
        Buffer.from(wasm),
        Buffer.from(typescriptWasm(linked.program, layout, true)),
      ) !== 0
    )
      throw new Error(`${spec.entry}: the A0 optimizer and wasm emitter differ from src/wasm.ts`);
    await writeEntry(keys.cache, 'live', key, { 'live.wasm': wasm });
  }
  await writeFile(join(outDir, `${spec.name}.wasm`), wasm);
  return `${spec.name}.wasm ${wasm.length} bytes (live program, equal to src/wasm.ts)`;
}

/**
 * The A0 wasm tool (`a0w`, the optimizer and emitter of compiler/), from the cache when its key is
 * there: the linked compiler sources, COMPILER_VERSION, the code that builds the tool (its import
 * closure), clang and the host. On a miss it is built by buildWasmTool and stored.
 */
export async function wasmTool(
  clang: ToolInfo,
  cache: SiteCache,
  note: Note,
): Promise<{ exe: string; digest: string }> {
  const boot = await link('compiler/boot.a0', (p) => readFile(p, 'utf8'));
  const key = keyOf(
    'wasmtool',
    COMPILER_VERSION,
    codeDigest(['tools/selfhost-wasm.ts']),
    HOST,
    clang.version ?? '',
    boot.text,
  );
  const exe = join(BUILD_DIR, 'a0w', 'a0w');
  const hit = cache.dir === undefined ? undefined : await readEntry(cache, 'wasmtool', key);
  if (cache.dir !== undefined) note(hit !== undefined);
  const bytes = hit?.get('a0w');
  if (bytes !== undefined) {
    await writeTool(bytes, exe);
    return { exe, digest: sha256(bytes) };
  }
  const built = await buildWasmTool(clang);
  const exeBytes = await readFile(toolFile(built.exe));
  await writeEntry(cache, 'wasmtool', key, { a0w: exeBytes });
  return { exe: built.exe, digest: sha256(exeBytes) };
}

/** A timed phase of the build, with how its cache lookups went. */
type Phase = {
  readonly name: string;
  readonly ms: number;
  readonly hits: number;
  readonly lookups: number;
};

/** The phases of one run, timed, and the machine's load when it started (tools/system-load.ts). */
class Timer {
  private readonly phases: Phase[] = [];
  readonly load = `${systemLoad().toFixed(2)} (${loadSource()})`;

  /** Run `body`, recording its time; `body` is told of each cache lookup it makes. */
  async phase<T>(name: string, body: (note: Note) => Promise<T>): Promise<T> {
    const start = performance.now();
    let hits = 0;
    let lookups = 0;
    try {
      return await body((hit) => {
        lookups += 1;
        if (hit) hits += 1;
      });
    } finally {
      this.phases.push({ name, ms: performance.now() - start, hits, lookups });
    }
  }

  /** One line per phase: its seconds and its cache outcome ('-' when it made no lookup). */
  table(): string {
    const lines = [`phases (load ${this.load}):`];
    let total = 0;
    for (const p of this.phases) {
      total += p.ms;
      const cache =
        p.lookups === 0
          ? '-'
          : p.hits === p.lookups
            ? 'hit'
            : p.hits === 0
              ? 'miss'
              : `${p.hits}/${p.lookups} hit`;
      lines.push(`  ${p.name.padEnd(26)} ${(p.ms / 1000).toFixed(2).padStart(8)} s  ${cache}`);
    }
    lines.push(`  ${'total'.padEnd(26)} ${(total / 1000).toFixed(2).padStart(8)} s`);
    return lines.join('\n');
  }
}

/** Files for agents: llms.txt (the convention), the primer, the docs as text, robots, sitemap. */
async function writeAgentFiles(page: Built, docs: Built, bench: Built): Promise<void> {
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
    '- [Benchmarks](https://a0lang.com/benchmarks): method, charts and losses (also at /benchmarks.txt); raw numbers in https://a0lang.com/results/exec-benchmark.json.',
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
    `# A0 primer (MODEL_GUIDE.min.txt)\n\n${primer}\n\n# A0 guide (MODEL_GUIDE.txt)\n\n${guide}\n\n# Docs\n\n${docs.text}\n\n# Benchmarks\n\n${bench.text}\n\n# Home\n\n${page.text}\n`,
    'utf8',
  );
  await writeFile(join(out, 'benchmarks.txt'), `${bench.text}\n`, 'utf8');
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
      'https://a0lang.com/benchmarks',
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
 * The site's Content-Security-Policy. It allows only same-origin scripts (app.js;
 * the ld+json block is data and never runs), wasm compilation, the runtime's generated <style>
 * and computed bar widths, self-hosted fonts, and same-origin fetches. No framing.
 */
export const SITE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SCRIPT_CACHE = 'public, max-age=60, stale-while-revalidate=600';

/** Hosting config deployed with site/dist: clean URLs, immutable fonts, and security headers. */
export const VERCEL = {
  cleanUrls: true,
  // /benchmarks (no trailing slash) is served from benchmarks/index.html, the way /docs/ is.
  rewrites: [{ source: '/benchmarks', destination: '/benchmarks/index.html' }],
  // The playground page was removed; old links land on the home page. `/play/` is listed on its
  // own: with cleanUrls the bare `/play/:path*` pattern did not catch the trailing slash (404).
  redirects: [
    { source: '/play', destination: '/', permanent: true },
    { source: '/play/', destination: '/', permanent: true },
    { source: '/play/:path*', destination: '/', permanent: true },
  ],
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: SITE_CSP },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        {
          key: 'Permissions-Policy',
          value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        },
      ],
    },
    {
      source: '/fonts/(.*)',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    },
    // The programs and scripts are not fingerprinted, so a long cache would serve old code after a deploy: a short one,
    // and a bounded window in which a stale copy is served while a fresh one is fetched.
    {
      source: '/(.*)\\.wasm',
      headers: [{ key: 'Cache-Control', value: SCRIPT_CACHE }],
    },
    {
      source: '/(app|wire|live)\\.js',
      headers: [{ key: 'Cache-Control', value: SCRIPT_CACHE }],
    },
    {
      source: '/live/(.*)',
      headers: [{ key: 'Cache-Control', value: SCRIPT_CACHE }],
    },
  ],
} as const;

/**
 * The repository-root config for a git-connected Vercel project: nothing is built on Vercel (the site build needs clang,
 * which its build image does not have), the prebuilt site in `deploy/` is served as it is with the same headers and redirects.
 */
export const ROOT_VERCEL = {
  ...VERCEL,
  framework: null,
  installCommand: null,
  buildCommand: null,
  outputDirectory: 'deploy',
} as const;

/** The page Vercel serves for an unknown path: the docs header and footer, one line and a link home. Static, no script. */
function notFoundPage(docs: { readonly html: string; readonly css: string }): string {
  const header = /<header[\s\S]*?<\/header>/.exec(docs.html)?.[0] ?? '';
  const footer = /<footer[\s\S]*?<\/footer>/.exec(docs.html)?.[0] ?? '';
  const csp = PAGE_CSP.replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <link rel="preload" href="/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <title>Page not found - A0</title>
  <style>${docs.css}</style>
</head>
<body>
  ${header}
  <main id="content" class="center"><h1>Page not found</h1><p>There is nothing at this address. <a href="/">Go to the home page</a>, the <a href="/docs/">docs</a> or the <a href="/benchmarks">benchmarks</a>.</p></main>
  ${footer}
</body>
</html>
`;
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
  const timer = new Timer();
  const cache = openCache({ enabled: !process.argv.includes('--no-cache') });
  // The page programs are generated by the A0 site generator (site/gen/sitegen.a0) from the
  // templates and results files, natively.
  const generator = await timer.phase('generator', (note) =>
    buildGenerator('sitegen', { cache, onCache: note }),
  );
  await timer.phase('templates', async (note) => {
    for (const [tpl, name] of [
      ['page.tpl', 'page.a0'],
      ['docs.tpl', 'docs.a0'],
      ['bench.tpl', 'bench.a0'],
    ] as const)
      await writeFile(
        join('site', name),
        await generate(generator, join('site', 'gen', tpl), { cache, onCache: note }),
        'utf8',
      );
  });
  await mkdir(join(out, 'docs'), { recursive: true });
  await mkdir(join(out, 'benchmarks'), { recursive: true });
  const clang = findClang();
  if (clang.path === undefined) throw new Error('clang not found (it builds the A0 wasm emitter)');
  const tool = await timer.phase('A0 wasm tool', (note) => wasmTool(clang, cache, note));
  const code = codeDigest(['tools/site-build.ts']);
  const keys = (note: Note): Keys => ({ cache, tool: tool.digest, code, note });
  const page = await timer.phase('page program', (note) =>
    buildProgram(tool.exe, 'page.a0', 'page', keys(note)),
  );
  const docs = await timer.phase('docs program', (note) =>
    buildProgram(tool.exe, 'docs.a0', 'docs', keys(note)),
  );
  const bench = await timer.phase('bench program', (note) =>
    buildProgram(tool.exe, 'bench.a0', 'bench', keys(note)),
  );
  const sizes = [page.size, docs.size, bench.size];
  sizes.push(
    ...(await timer.phase('live programs', async (note) => {
      const lines: string[] = [];
      for (const spec of LIVE_PROGRAMS) lines.push(await buildLive(tool.exe, spec, keys(note)));
      return lines;
    })),
  );
  await timer.phase('app.js (tsc)', async () => {
    // resolve typescript from this file, not from the working directory (worktrees share the parent's modules)
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const r = runTool(process.execPath, [
      tsc,
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
  });
  await timer.phase('pages and shells', async () => {
    await writeFile(
      join(out, 'index.html'),
      fillShell(await readFile(join('site', 'index.html'), 'utf8'), page),
      'utf8',
    );
    await copyFile(join('site', 'favicon.svg'), join(out, 'favicon.svg'));
    // touch icon, 32px favicon and the social preview images, made by tools/og-cards.ts (bun run og-cards)
    for (const f of ['apple-touch-icon.png', 'favicon-32.png'])
      await copyFile(join('site', f), join(out, f));
    await cp(join('site', 'og'), join(out, 'og'), { recursive: true });
    await writeFile(
      join(out, 'docs', 'index.html'),
      fillShell(await readFile(join('site', 'docs.html'), 'utf8'), docs),
      'utf8',
    );
    await writeFile(
      join(out, 'benchmarks', 'index.html'),
      fillShell(await readFile(join('site', 'bench.html'), 'utf8'), bench),
      'utf8',
    );
    await writeFile(join(out, '404.html'), notFoundPage(docs), 'utf8');
    await writeAgentFiles(page, docs, bench);
    await copyFonts();
    await writeFile(join(out, 'vercel.json'), `${JSON.stringify(VERCEL, null, 2)}\n`, 'utf8');
  });
  if (process.argv.includes('--publish'))
    await timer.phase('publish copy', async () => {
      // the committed copy a git-connected Vercel project serves (see ROOT_VERCEL)
      await rm('deploy', { recursive: true, force: true });
      await cp(out, 'deploy', { recursive: true });
      await writeFile(
        'vercel.json',
        `${JSON.stringify(ROOT_VERCEL, null, 2)}
`,
        'utf8',
      );
    });
  process.stdout.write(
    `site/dist: ${sizes.join(', ')}, app.js, index.html, docs/index.html (prerendered), llms.txt, fonts/\n`,
  );
  process.stderr.write(`${timer.table()}\n`);
}

// run only when executed directly, so a test can import ROOT_VERCEL without building the site
if (/site-build\.[jt]s$/.test(process.argv[1] ?? ''))
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
