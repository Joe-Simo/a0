// The release pipeline's static contract: one version everywhere, a pinned and minimal workflow,
// a formula the workflow can update, and notes for the version being released.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMPILER_VERSION } from '../src/backends.js';
import { A0_VERSION } from '../src/version.js';
import { versionProblems } from '../tools/set-version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

test('release: every version file carries the version of src/version.ts', () => {
  assert.deepEqual(versionProblems(A0_VERSION, root), []);
});

test('release: a0 --version reports the release and compiler versions', () => {
  const out = execFileSync(process.execPath, [join(root, 'dist/src/cli.js'), '--version'], {
    encoding: 'utf8',
  });
  assert.equal(out, `a0 ${A0_VERSION} (compiler ${COMPILER_VERSION})\n`);
});

test('release: the workflow is tag-only, pinned, minimal and uses no extra secret', () => {
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /tags: \['v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\]/);
  assert.doesNotMatch(wf, /branches:/);
  assert.match(wf, /^permissions: \{\}$/m);
  assert.match(wf, /permissions:\n {6}contents: write/);
  assert.doesNotMatch(wf, /HOMEBREW_TAP_TOKEN|homebrew-a0|TAP_TOKEN/);
  assert.deepEqual(
    [...wf.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]),
    [],
  );
  const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] ?? '');
  assert.ok(uses.length >= 3);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} is not pinned to a commit`);
  assert.doesNotMatch(wf, /bun-version:\s*latest/);
  for (const asset of [
    'a0-darwin-arm64',
    'a0-darwin-x64',
    'a0-linux-arm64',
    'a0-linux-x64',
    'a0-windows-x64.exe',
    'a0-mcp-windows-x64.mcpb',
    'checksums.txt',
    'server.json',
  ])
    assert.ok(wf.includes(asset), `workflow does not mention ${asset}`);
});

test('release: Formula/a0.rb is the tap formula and tools/homebrew-formula.sh updates it', () => {
  const formula = read('Formula/a0.rb');
  assert.match(formula, /^class A0 < Formula$/m);
  assert.equal([...formula.matchAll(/^ {6}sha256 "[0-9a-f]{64}"$/gm)].length, 4);
  assert.equal([...formula.matchAll(/^ {6}url ".*\/v#\{version\}\/a0-/gm)].length, 4);
  const dir = mkdtempSync(join(tmpdir(), 'a0-release-'));
  try {
    const copy = join(dir, 'a0.rb');
    copyFileSync(join(root, 'Formula/a0.rb'), copy);
    const assets = [
      'a0-darwin-arm64',
      'a0-darwin-x64',
      'a0-linux-arm64',
      'a0-linux-x64',
      'a0-windows-x64.exe',
    ];
    const sums = join(dir, 'checksums.txt');
    writeFileSync(sums, assets.map((a, i) => `${String(i + 1).repeat(64)}  ${a}\n`).join(''));
    execFileSync('sh', [join(root, 'tools/homebrew-formula.sh'), '9.9.9', sums, copy]);
    const out = readFileSync(copy, 'utf8');
    assert.match(out, /^ {2}version "9\.9\.9"$/m);
    for (const [i, a] of assets.slice(0, 4).entries()) {
      const at = out.indexOf(`/${a}"`);
      assert.ok(at > 0);
      assert.match(out.slice(at, at + 120), new RegExp(`sha256 "${String(i + 1).repeat(64)}"`));
    }
    // A missing checksum is an error and leaves the formula as it was.
    writeFileSync(sums, `${'1'.repeat(64)}  a0-darwin-arm64\n`);
    assert.throws(() =>
      execFileSync('sh', [join(root, 'tools/homebrew-formula.sh'), '9.9.9', sums, copy], {
        stdio: 'ignore',
      }),
    );
    assert.equal(readFileSync(copy, 'utf8'), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release: RELEASE_NOTES.md is for this version', () => {
  assert.equal(read('RELEASE_NOTES.md').split('\n')[0], `# A0 v${A0_VERSION}`);
});
