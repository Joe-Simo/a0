/** Verify native source-unit parsing independently of whole-program checking. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { formatSource as legacySource, parse } from '../src/core.js';
import { formatSource, parseSource } from '../src/source.js';
import { nativeSource } from '../src/source-native.js';
import { isReject, listSources } from './dense-loader.js';
import { committedTree } from './measurement-checkout.js';
import { writeReport } from './scrub-results.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const artifact = option('artifact');
assert.ok(artifact, '--artifact=DIR is required');
const root = process.cwd(),
  identity = committedTree(root);
const bytes = await readFile(join(resolve(artifact), 'frontend.wasm'));
const build = JSON.parse(await readFile(join(resolve(artifact), 'build.json'), 'utf8')) as {
  wasmSHA256: string;
};
const artifactSha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(artifactSha256, build.wasmSHA256, 'artifact/build mismatch');
const frontend = nativeSource(new WebAssembly.Module(bytes));
const rows: { entry: string; status: 'pass' | 'fail'; reason?: string }[] = [];
try {
  for (const path of listSources(root).filter((path) => !isReject(path, root))) {
    const entry = relative(root, path);
    try {
      const source = await readFile(path, 'utf8'),
        expected = parse(source);
      for (const text of [source, formatSource(expected)]) {
        const actual = frontend.parseUnit(text);
        assert.ok(actual.ok, `native parse status ${actual.status}`);
        assert.equal(
          legacySource(actual.program),
          legacySource(expected),
          'unit IR/metadata mismatch',
        );
        assert.equal('typed' in actual, false, 'a parsed unit must not claim validation');
      }
      rows.push({ entry, status: 'pass' });
    } catch (error) {
      rows.push({
        entry,
        status: 'fail',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const independent = [
    ['external callee', 'use "dependency.a0"\nfn f\na external A\nret a\nend\n'],
    ['return type', 'fn f -> bool\nret 1\nend\n'],
    ['false example', 'fn f\nex -> 2\nret 1\nend\n'],
    ['contract callee', 'fn f\npre unknown A\nret A\nend\n'],
  ] as const;
  for (const [name, source] of independent) {
    const expected = parseSource(source),
      actual = frontend.parseUnit(source);
    assert.ok(actual.ok, name);
    assert.equal(legacySource(actual.program), legacySource(expected), name);
    assert.equal(frontend.parse(source).ok, false, `${name}: whole-program checking must reject`);
  }
  assert.deepEqual(committedTree(root), identity, 'tree changed during audit');
  await writeReport(option('out') ?? '.a0-tmp/source-unit-audit.json', {
    schema: 1,
    candidate: identity,
    artifactSha256,
    scope:
      'Source-unit IR, comments, imports and signatures only. Same A0 parser as whole-program checking. This does not establish native graph validation, diagnostic integration, official syntax cutover or performance eligibility.',
    method:
      'All accepted source files in existing and flat formatted spellings; independent import, type and specification cases must parse and then fail whole-program validation.',
    entries: rows.length,
    failed: rows.filter((row) => row.status === 'fail').length,
    independentDelayedValidation: independent.map(([name]) => ({ name, status: 'pass' })),
    rows,
  });
  assert.ok(
    rows.every((row) => row.status === 'pass'),
    'native unit failures; inspect report',
  );
  console.log(
    `PASS ${rows.length} source units in both spellings; delayed-validation controls pass`,
  );
} finally {
  frontend.close();
}
