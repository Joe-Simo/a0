/**
 * Content-addressed step cache. A gate step is keyed by a hash of everything it reads (the import
 * closure of its entry files plus the data files it consumes, from gate-scope's static map), its
 * command line, COMPILER_VERSION, the node version and the platform. A step whose key matches a
 * previous PASSING run on this machine is skipped and reported as `cached (key)`.
 *
 * The cache lives in .a0-cache/step-cache.json (git-ignored, per checkout). Steps that measure time
 * never cache: exec-bench, lang-axes, bench, par-bench, wasm-bench, edit-loop-bench, native-check.
 * The key does not cover installed toolchains (clang, java, simulators): after upgrading one, run
 * with `--no-cache`.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildStepMap, type StepId } from './gate-scope.js';

/** Steps whose output is a timing: they always run. */
export const NEVER_CACHED: readonly string[] = [
  'exec-bench',
  'lang-axes',
  'bench',
  'par-bench',
  'wasm-bench',
  'edit-loop-bench',
  'native-check',
];

export const isCacheable = (step: string): boolean =>
  !NEVER_CACHED.includes(step) && step !== 'build' && step !== 'lint';

const walk = (root: string, dir: string, ext: RegExp): string[] => {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(root, `${dir}/${e.name}`, ext)
      : ext.test(e.name)
        ? [`${dir}/${e.name}`]
        : [],
  );
};

const CONFIG = ['package.json', 'bun.lock', 'tsconfig.json', 'biome.json'];

/** Files a step reads. typecheck reads all TypeScript; the rest use the import closure plus data. */
export function stepFiles(root: string, step: StepId): string[] {
  if (step === 'typecheck') {
    return [
      ...CONFIG,
      ...['src', 'test', 'tools'].flatMap((d) => walk(root, d, /\.ts$/)),
      'site/wire.ts',
    ].filter((f) => existsSync(join(root, f)));
  }
  const closure = buildStepMap(root).closures.get(step) ?? new Set<string>();
  const extra: string[] = [...CONFIG];
  // inputs no import names: the corpus oracle lives in tools/corpus.ts (an import); the site and
  // the unit tests also read results, examples, the compiler sources and the guides
  if (step === 'site') extra.push(...walk(root, 'results', /\.json$/), ...walk(root, 'site', /./));
  if (step === 'test') {
    extra.push(...walk(root, 'examples', /\.a0$/), ...walk(root, 'compiler', /\.a0$/));
    extra.push(...walk(root, 'src', /\.ts$/), ...walk(root, 'tools', /\.ts$/));
    extra.push(
      ...readdirSync(root).filter((f) => /^MODEL_GUIDE.*\.txt$/.test(f)),
      ...walk(root, 'experiments', /\.txt$/),
    );
  }
  for (const r of ['verify', 'app', 'selfhost', 'selfhost-c', 'bootstrap', 'equiv', 'hw']) {
    if (r === step) extra.push(...walk(root, 'tools', /\.ts$/).filter((f) => closure.has(f)));
  }
  return [...new Set([...closure, ...extra])].filter((f) => existsSync(join(root, f))).sort();
}

export function compilerVersion(root: string): string {
  const p = join(root, 'src', 'backends.ts');
  const m = existsSync(p) ? /COMPILER_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(p, 'utf8')) : null;
  return m?.[1] ?? 'unknown';
}

export function stepKey(root: string, step: StepId, cmd: string): string {
  const h = createHash('sha256');
  h.update(
    `${step}\0${cmd}\0${compilerVersion(root)}\0${process.version}\0${process.platform}-${process.arch}\0`,
  );
  for (const f of stepFiles(root, step)) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(join(root, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

const file = (repo: string): string => join(repo, '.a0-cache', 'step-cache.json');

export function loadStepCache(repo: string): Record<string, { key: string; at: string }> {
  try {
    return existsSync(file(repo))
      ? (JSON.parse(readFileSync(file(repo), 'utf8')) as Record<
          string,
          { key: string; at: string }
        >)
      : {};
  } catch {
    return {};
  }
}

export function recordPass(repo: string, step: string, key: string): void {
  mkdirSync(join(repo, '.a0-cache'), { recursive: true });
  const all = loadStepCache(repo);
  all[step] = { key, at: new Date().toISOString() };
  const tmp = `${file(repo)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 1)}\n`);
  renameSync(tmp, file(repo));
}

/** Key of the last passing run of `step` if it equals `key`, else null. */
export function cachedKey(repo: string, step: string, key: string): string | null {
  const hit = loadStepCache(repo)[step];
  return hit && hit.key === key ? key : null;
}
