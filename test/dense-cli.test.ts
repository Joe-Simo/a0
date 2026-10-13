/**
 * `--dense=a0`: dense files read by the reader written in A0 (src/dense-a0.ts over compiler/dense.a0)
 * against the reference. For every accepted program of corpus/, examples/, compiler/ and site/, its
 * dense tree (tools/dense-loader.ts denseForms) is linked with the A0 reader. A program the A0 reader
 * accepts must give the verdict of the canonical file and the same canonical revisions (the program's
 * and every function's, what `a0 check` prints); a program it refuses must be refused with A0625 and
 * the byte offset of the function, never another error and never a different program.
 * The command line is checked on files: `a0 check --dense=a0` prints what `a0 check` prints.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { A0Error, parse } from '../src/core.js';
import { formatDense } from '../src/dense.js';
import { readDenseA0 } from '../src/dense-a0.js';
import { programRevision, revision } from '../src/edit.js';
import { link } from '../src/link.js';
import {
  denseForms,
  denseReader,
  isReject,
  keyOf,
  listSources,
  loadCanonical,
  ROOT,
} from '../tools/dense-loader.js';

const CLI = join(ROOT, 'dist', 'src', 'cli.js');

test('--dense=a0: every program the A0 reader accepts has the verdict and revisions of the canonical file; a refusal is A0625', async (t) => {
  let accepted = 0;
  let refused = 0;
  const reasons = new Map<string, number>();
  // The whole set (A0_DENSE_FULL=1) takes about 12 minutes on the interpreter: 59 programs accepted,
  // 27 refused with A0625, none read to a different program. By default: corpus/ and examples/.
  const full = process.env.A0_DENSE_FULL === '1';
  for (const abs of listSources(ROOT)) {
    if (!full && !/^(corpus|examples)\//.test(relative(ROOT, abs).split(sep).join('/'))) continue;
    if (isReject(abs, ROOT)) continue;
    const name = relative(ROOT, abs).split(sep).join('/');
    const failures = new Map<string, string>();
    const forms = await denseForms(
      [abs],
      (p) => import('node:fs/promises').then((f) => f.readFile(p, 'utf8')),
      failures,
    );
    if (failures.size > 0) continue; // no dense form: outside the comparison
    const canonical = await loadCanonical(abs, ROOT);
    let got: Awaited<ReturnType<typeof link>>;
    try {
      got = await link(await keyOf(abs), denseReader(forms), {
        root: ROOT,
        dense: true,
        denseReader: (text, used, p) => readDenseA0(text, used, p).text,
      });
    } catch (e) {
      assert.ok(e instanceof A0Error, `${name}: a refusal is a diagnostic, not a crash (${e})`);
      assert.equal(e.id, 'A0625', `${name}: refused with A0625, not ${e.message}`);
      assert.match(e.message, /at byte \d+/, `${name}: the refusal names the byte offset`);
      refused += 1;
      const key = e.message.includes('(header)') ? 'header' : 'function';
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
      continue;
    }
    accepted += 1;
    assert.equal(
      programRevision(got.program),
      programRevision(canonical.program),
      `${name}: program revision`,
    );
    assert.deepEqual(
      got.program.functions.map((f) => `${f.name} ${revision(f)}`),
      canonical.program.functions.map((f) => `${f.name} ${revision(f)}`),
      `${name}: function revisions`,
    );
  }
  t.diagnostic(
    `${accepted} programs read by the A0 reader to the canonical revisions; ${refused} refused with A0625 (${[...reasons].map(([k, v]) => `${k} ${v}`).join(', ')})`,
  );
  assert.ok(accepted >= (full ? 59 : 1), `programs accepted (${accepted})`);
});

test('--dense=a0 on the command line: the same output as a0 check, and a clear diagnostic for a refusal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0-dense-cli-'));
  try {
    const canon =
      'fn sq u32 -> u32\n  m mul p0 p0\n  ret m\nend\n\nfn f u32 u32 -> u32\n  s add p0 p1\n  q call sq s\n  ret q\nend\n';
    const dense = formatDense(parse(canon));
    writeFileSync(join(dir, 'p.a0'), canon);
    writeFileSync(join(dir, 'p.txt'), dense);
    const run = (args: string[]) =>
      spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    const want = run(['check', join(dir, 'p.a0')]);
    assert.equal(want.status, 0, want.stderr);
    const got = run(['check', '--dense=a0', join(dir, 'p.txt')]);
    assert.equal(got.status, 0, got.stderr);
    assert.equal(got.stdout, want.stdout);
    // a spec line is outside the A0 reader: refused at the second function, byte offset of its header
    writeFileSync(join(dir, 'q.txt'), `${dense}\nfn g u32 -> u32\n+ex g(1) == 1\nmov A\n`);
    const bad = run(['check', '--dense=a0', join(dir, 'q.txt')]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /the dense reader in A0 \(compiler\/dense\.a0\) refuses/);
    assert.match(bad.stderr, new RegExp(`function g at byte ${Buffer.byteLength(dense) + 1}\\b`));
    assert.doesNotMatch(bad.stderr, /at Object|Error:\s/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
