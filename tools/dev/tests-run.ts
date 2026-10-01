/**
 * tests: predict which unit-test files a diff can affect (a test file is affected when a changed file
 * is in its import closure, or the diff touches shared config) and, with --run, run only those after
 * a build. Unmapped changes select every test file.
 *
 *   node dist/tools/dev/tests-run.js [--base=<ref>] [--files=a,b] [--run] [--json]
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closureOf, computeScope } from './gate-scope.js';
import { changedFiles, defaultBase, defaultRepo } from './repo.js';

export function predictTests(
  root: string,
  files: readonly string[],
): { tests: string[]; why: string } {
  const all = readdirSync(join(root, 'test'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `test/${f}`)
    .sort();
  const code = files.filter((f) => !f.startsWith('results/') && !/\.(md|txt)$/.test(f));
  if (code.length === 0) return { tests: [], why: 'docs and results only' };
  const scope = computeScope(root, files);
  if (scope.class === 'everything') return { tests: all, why: 'shared core or config changed' };
  const hit = all.filter((t) => {
    const c = closureOf(root, t);
    return code.some((f) => c.has(f) || f === t || f.startsWith('site/gen/'));
  });
  return { tests: hit, why: 'import closure of each test file' };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const repo = defaultRepo();
  const filesArg = args.find((a) => a.startsWith('--files='))?.slice(8);
  const files = filesArg
    ? filesArg.split(',')
    : changedFiles(repo, args.find((a) => a.startsWith('--base='))?.slice(7) ?? defaultBase(repo));
  const p = predictTests(repo, files);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(p, null, 2)}\n`);
  else process.stdout.write(`tests (${p.why}): ${p.tests.join(' ') || 'none'}\n`);
  if (args.includes('--run') && p.tests.length > 0) {
    const b = spawnSync('bun', ['run', 'build'], { cwd: repo, stdio: 'inherit' });
    if (b.status !== 0) process.exit(b.status ?? 1);
    const js = p.tests.map((t) => t.replace(/\.ts$/, '.js').replace(/^/, 'dist/'));
    const r = spawnSync('node', ['--test', ...js], { cwd: repo, stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
}
