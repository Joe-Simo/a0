import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeReport } from '../../../dist/tools/scrub-results.js';
const hash = (x) => createHash('sha256').update(x).digest('hex');
const option = (name) =>
  process.argv
    .slice(2)
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const baseline = option('baseline'),
  baselineDist = option('baseline-dist'),
  output = option('out'),
  current = process.cwd();
assert.ok(
  baseline && baselineDist && output,
  '--baseline=DIR --baseline-dist=DIR --out=FILE required',
);
assert.equal(
  execFileSync('git', ['-C', baseline, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  'ca3cc4e07791edc4a33a601d760eb949df474911',
);
async function files(dir, out = [], depth = 0) {
  for (const n of (await readdir(dir)).sort()) {
    const p = join(dir, n),
      s = await stat(p);
    if (s.isDirectory()) {
      if (n !== 'gen' && depth < 4) await files(p, out, depth + 1);
    } else if (n.endsWith('.a0')) out.push(p);
  }
  return out;
}
async function probe(root, dist = join(root, 'dist')) {
  const core = await import(pathToFileURL(join(dist, 'src/core.js'))),
    dense = await import(pathToFileURL(join(dist, 'src/dense.js'))),
    edit = await import(pathToFileURL(join(dist, 'src/edit.js')));
  let out = {};
  const paths = (
    await Promise.all(
      ['compiler', 'corpus', 'examples', 'editors', 'site'].map((d) => files(join(root, d))),
    )
  )
    .flat()
    .sort();
  for (const p of paths) {
    const src = await readFile(p, 'utf8'),
      row = {};
    try {
      const ir = core.parse(src);
      row.canonical = hash(core.formatProgram(ir));
      row.source = hash(core.formatSource(ir));
      row.revision = edit.programRevision(ir);
      try {
        row.dense = hash(dense.formatDense(ir));
      } catch (e) {
        row.dense = `error: ${e.message}`.slice(0, 120);
      }
      try {
        const t = core.validate(ir);
        row.semantic = hash(t.functions.map((f) => edit.semanticRevision(f)).join(','));
      } catch (e) {
        row.semantic = `error: ${e.id ?? ''} ${e.message}`.slice(0, 120);
      }
    } catch (e) {
      row.error = `${e.id ?? ''} ${e.message}`.slice(0, 160);
    }
    out[relative(root, p).replaceAll('\\', '/')] = row;
  }
  return {
    rows: out,
    outputs: await Promise.all(
      ['core', 'dense', 'edit'].map(async (n) => ({
        path: `dist/src/${n}.js`,
        sha256: hash(await readFile(join(dist, `src/${n}.js`))),
      })),
    ),
  };
}
for (const path of execFileSync('git', ['-C', baseline, 'ls-files', 'src/*.ts'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')) {
  assert.equal(
    hash(await readFile(join(baseline, path))),
    hash(execFileSync('git', ['-C', baseline, 'show', `ca3cc4e:${path}`])),
    `frozen source differs: ${path}`,
  );
}
const old = await probe(baseline, baselineDist),
  now = await probe(current),
  oldGolden = JSON.parse(await readFile(join(baseline, 'test/golden/spec-free-digests.json'))),
  newGolden = JSON.parse(await readFile(join(current, 'test/golden/spec-free-digests.json')));
assert.deepEqual(old.rows, oldGolden);
assert.deepEqual(now.rows, newGolden);
const added = Object.keys(now.rows).filter((p) => !Object.hasOwn(old.rows, p)),
  removed = Object.keys(old.rows).filter((p) => !Object.hasOwn(now.rows, p)),
  changed = Object.keys(old.rows).filter(
    (p) =>
      Object.hasOwn(now.rows, p) && JSON.stringify(old.rows[p]) !== JSON.stringify(now.rows[p]),
  );
assert.deepEqual(added, ['compiler/diagnostic_specs_arena.a0']);
assert.deepEqual(removed, []);
assert.deepEqual(changed, [
  'compiler/diagnostics_arena.a0',
  'compiler/source_grammar.a0',
  'compiler/spec_types_arena_shared.a0',
]);
await writeReport(output, {
  schema: 1,
  scope:
    'Independent frozen-source/frozen-output replay of exhaustive spec-free digests; no normalization and no performance claim.',
  baselineCommit: 'ca3cc4e07791edc4a33a601d760eb949df474911',
  baselineRows: Object.keys(old.rows).length,
  currentRows: Object.keys(now.rows).length,
  oldGoldenExact: true,
  newGoldenExact: true,
  unchangedExistingRows: Object.keys(old.rows).length - changed.length,
  added,
  removed,
  changed: changed.map((path) => ({ path, before: old.rows[path], after: now.rows[path] })),
  baselinePreparation:
    'Fresh TypeScript project build of immutable ca3cc4e into a separate output directory; every tracked src/*.ts input equals git ca3cc4e, then old source/old golden and current source/current golden are replayed without normalization.',
  baselineCompilerOutputs: old.outputs,
  currentCompilerOutputs: now.outputs,
});
console.log(
  JSON.stringify({
    old: Object.keys(old.rows).length,
    now: Object.keys(now.rows).length,
    changed,
    added,
  }),
);
