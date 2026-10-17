/** Isolated measurement process: load only the measured checkout's frontend before sampling RSS. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { compile as Compile } from '../src/backends.js';
import type { formatProgram as FormatProgram } from '../src/core.js';
import type { link as Link } from '../src/link.js';
import { systemLoad } from './system-load.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const implementation = option('implementation');
if (implementation === undefined) throw new Error('missing implementation');
const fixtures = JSON.parse(readFileSync(0, 'utf8')) as {
  root: string;
  entry: string;
  canonical: [string, string][];
  dense: [string, string][];
};
const hash = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
const read = (path: string): Promise<string> => readFile(path, 'utf8');
const { link } = (await import(pathToFileURL(join(implementation, 'dist/src/link.js')).href)) as {
  link: typeof Link;
};
const builtVersion = (await import(
  pathToFileURL(join(implementation, 'dist/src/targets.js')).href
)) as { COMPILER_VERSION: string };
const sourceVersion = /COMPILER_VERSION = '([^']+)'/.exec(
  await read(join(implementation, 'src/targets.ts')),
)?.[1];
if (sourceVersion !== builtVersion.COMPILER_VERSION)
  throw new Error('baseline build is stale: rebuild with tsc --incremental false');
const implementationHashes = Object.fromEntries(
  await Promise.all(
    ['link', 'core', 'dense'].map(async (name) => [
      name,
      {
        source: hash(await read(join(implementation, `src/${name}.ts`))),
        built: hash(await read(join(implementation, `dist/src/${name}.js`))),
      },
    ]),
  ),
);
const dense = option('surface') === 'dense';
const texts = new Map(dense ? fixtures.dense : fixtures.canonical);
const reader = async (path: string): Promise<string> => {
  const text = texts.get(path);
  if (text === undefined) throw new Error(`source snapshot missing: ${path}`);
  return text;
};
const options = { root: fixtures.root, dense };
for (let n = 0; n < 5; n += 1) await link(fixtures.entry, reader, options);
const samples: { ms: number; loadBefore: number; loadAfter: number }[] = [];
let linked = await link(fixtures.entry, reader, options);
for (let n = 0; n < 15; n += 1) {
  const loadBefore = systemLoad();
  const start = performance.now();
  linked = await link(fixtures.entry, reader, options);
  const ms = performance.now() - start;
  samples.push({ ms, loadBefore, loadAfter: systemLoad() });
}
// Sample before importing the backend or formatting/emitting the linked program. Both source
// snapshots and warmup allocations remain included; this is not parser-only memory.
const frontendWorkerPeakRssKiB = process.resourceUsage().maxRSS;
const { formatProgram } = (await import(
  pathToFileURL(join(implementation, 'dist/src/core.js')).href
)) as { formatProgram: typeof FormatProgram };
const { compile } = (await import(
  pathToFileURL(join(implementation, 'dist/src/backends.js')).href
)) as {
  compile: typeof Compile;
};
const artifacts = Object.fromEntries(
  (['js', 'c', 'wasm'] as const).map((target) => {
    const text = compile(linked.program, target).text;
    const bytes = Buffer.from(text, target === 'wasm' ? 'base64' : 'utf8');
    return [
      target,
      {
        format: target === 'wasm' ? 'wasm-binary' : 'utf8-source',
        bytes: bytes.length,
        sha256: hash(bytes),
      },
    ];
  }),
);
process.stdout.write(
  JSON.stringify({
    samples,
    compilerVersion: builtVersion.COMPILER_VERSION,
    implementationHashes,
    medianMs: samples.map((s) => s.ms).sort((a, b) => a - b)[Math.floor(samples.length / 2)],
    loadWithinLimit: samples.every((s) => s.loadBefore <= 10 && s.loadAfter <= 10),
    frontendWorkerPeakRssKiB,
    programSha256: hash(formatProgram(linked.program)),
    inputSha256: hash(
      JSON.stringify(fixtures.canonical.map(([p, t]) => [p.slice(fixtures.root.length), t])),
    ),
    artifacts,
  }),
);
