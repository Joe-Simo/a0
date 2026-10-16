// The release pipeline's static contract: one version everywhere, a pinned and minimal workflow,
// a formula the workflow can update, and notes for the version being released.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    'LICENSE',
    'NOTICE',
  ])
    assert.ok(wf.includes(asset), `workflow does not mention ${asset}`);
});

test('release: exact uploaded assets include the checksummed license pair and MCP bundles carry it', () => {
  const wf = read('.github/workflows/release.yml');
  const upload = /gh release upload[\s\S]*?\n {10}# Fail/.exec(wf)?.[0];
  assert.ok(upload);
  const binaries = [
    'a0-darwin-arm64',
    'a0-darwin-x64',
    'a0-linux-arm64',
    'a0-linux-x64',
    'a0-windows-x64.exe',
  ];
  const bundles = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64'].map(
    (target) => `a0-mcp-${target}.mcpb`,
  );
  const assets = [
    ...binaries,
    ...bundles,
    'LICENSE',
    'NOTICE',
    'checksums.txt',
    'server.json',
  ].sort();
  assert.deepEqual(
    [...upload.matchAll(/release\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]).sort(),
    assets,
  );
  const expected = /printf '%s\\n' ([\s\S]*?)\| LC_ALL=C sort > "\$RUNNER_TEMP\/expected.txt"/.exec(
    wf,
  )?.[1];
  assert.ok(expected);
  assert.deepEqual(expected.replace(/\\/g, '').trim().split(/\s+/).sort(), assets);
  const pack = read('tools/mcpb.ts');
  for (const name of ['LICENSE', 'NOTICE'])
    assert.ok(pack.includes(`copyFileSync(join(root, '${name}'), join(stage, '${name}'))`));
  const dir = mkdtempSync(join(tmpdir(), 'a0-release-sums-'));
  try {
    // Execute the real checksum-producing trailer over small fixtures, without building packages.
    const checked = [...binaries, ...bundles, 'LICENSE', 'NOTICE'].sort();
    const release = join(dir, 'release');
    mkdirSync(release);
    for (const name of checked) writeFileSync(join(release, name), `fixture ${name}\n`);
    const script = read('tools/release.sh');
    const trailer = script.slice(script.indexOf('# Sorted, so the file'));
    assert.ok(trailer.startsWith('# Sorted, so the file'));
    // The trailer works in release/ relative to its current directory.
    execFileSync(
      'sh',
      [
        '-c',
        `binaries='${binaries.join(' ')}'\nbundles='${bundles.join(' ')}'\nnotices='LICENSE NOTICE'\n${trailer}`,
      ],
      { cwd: dir },
    );
    const sums = readFileSync(join(release, 'checksums.txt'), 'utf8').trim().split('\n');
    assert.equal(sums.length, 12);
    assert.deepEqual(
      sums.map((line) => line.split(/\s+/)[1]),
      checked,
    );
    execFileSync(
      'sh',
      [
        '-c',
        'if command -v sha256sum >/dev/null 2>&1; then sha256sum -c checksums.txt; else shasum -a 256 -c checksums.txt; fi',
      ],
      { cwd: release },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release: every workflow pins actions to commits and requests least privilege', () => {
  for (const name of ['ci', 'release']) {
    const wf = read(`.github/workflows/${name}.yml`);
    assert.match(wf, /^permissions:/m, `${name}.yml has no top-level permissions`);
    for (const m of wf.matchAll(/uses:\s*(\S+)/g))
      assert.match(m[1] ?? '', /@[0-9a-f]{40}$/, `${name}.yml: ${m[1]} is not pinned`);
  }
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /brew style/);
  assert.match(ci, /brew audit --strict --new/);
});

test('release: a smoke job installs the release on all five platforms', () => {
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /\n {2}smoke:\n {4}needs: release/);
  for (const os of [
    'macos-14',
    'macos-15-intel',
    'ubuntu-24.04-arm',
    'ubuntu-24.04',
    'windows-latest',
  ])
    assert.ok(wf.includes(`os: ${os}`), `smoke matrix lacks ${os}`);
  assert.ok(
    wf.includes('install.sh') && wf.includes('install.ps1') && wf.includes('tools/smoke.ts'),
  );
});

test('release: Formula/a0.rb is the tap formula and tools/homebrew-formula.sh updates it', () => {
  const formula = read('Formula/a0.rb');
  assert.match(formula, /^class A0 < Formula$/m);
  const checkBinaries = (text: string, version: string): void => {
    assert.equal([...text.matchAll(/^ {6}sha256 "[0-9a-f]{64}"$/gm)].length, 4);
    assert.equal([...text.matchAll(/^ {6}url ".*\/download\/v[^/]+\/a0-/gm)].length, 4);
    assert.equal(text.split(`/download/v${version}/a0-`).length - 1, 4);
    // The URL carries the version; a separate `version` line fails brew audit.
    assert.doesNotMatch(text, /^ {2}version "/m);
    assert.equal([...text.matchAll(/a0 --version/g)].length, 1);
    assert.ok(text.endsWith('\n'), 'the formula retains its final newline');
  };
  assert.equal([...formula.matchAll(/^ {2}# BEGIN RELEASE NOTICES$/gm)].length, 1);
  assert.equal([...formula.matchAll(/^ {2}# END RELEASE NOTICES$/gm)].length, 1);
  assert.match(
    formula,
    /resources\.each do \|resource\|\n {6}resource\.stage \{ pkgshare\.install resource\.name\.upcase \}\n {4}end/,
  );
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
      'a0-mcp-darwin-arm64.mcpb',
      'a0-mcp-darwin-x64.mcpb',
      'a0-mcp-linux-arm64.mcpb',
      'a0-mcp-linux-x64.mcpb',
      'a0-mcp-windows-x64.mcpb',
      'LICENSE',
      'NOTICE',
    ];
    const digest = (i: number): string => (i + 1).toString(16).repeat(64);
    const entries = assets.map((asset, i) => `${digest(i)}  ${asset}\n`);
    const sums = join(dir, 'checksums.txt');
    const update = (version = '9.9.9'): void => {
      execFileSync('sh', [join(root, 'tools/homebrew-formula.sh'), version, sums, copy]);
    };
    writeFileSync(sums, entries.join(''));
    update();
    const out = readFileSync(copy, 'utf8');
    checkBinaries(out, '9.9.9');
    const resourceBlock = [
      '  # BEGIN RELEASE NOTICES',
      '  resource "license" do',
      '    url "https://github.com/Joe-Simo/a0/releases/download/v9.9.9/LICENSE"',
      `    sha256 "${digest(10)}"`,
      '  end',
      '',
      '  resource "notice" do',
      '    url "https://github.com/Joe-Simo/a0/releases/download/v9.9.9/NOTICE"',
      `    sha256 "${digest(11)}"`,
      '  end',
      '  # END RELEASE NOTICES',
    ].join('\n');
    assert.ok(out.includes(resourceBlock), 'both resources use this release and its checksums');
    assert.equal([...out.matchAll(/^ {2}resource "/gm)].length, 2);
    update();
    assert.equal(readFileSync(copy, 'utf8'), out, 'a second run changes nothing');
    for (const [i, asset] of assets.slice(0, 4).entries()) {
      const at = out.indexOf(`/${asset}"`);
      assert.ok(at > 0);
      assert.ok(out.slice(at, at + 120).includes(`sha256 "${digest(i)}"`));
    }

    // Both historical manifests clear previously generated resources without adding notice URLs.
    for (const [count, version] of [
      [5, '9.9.8'],
      [10, '9.9.7'],
    ] as const) {
      writeFileSync(copy, out);
      writeFileSync(sums, entries.slice(0, count).join(''));
      update(version);
      const legacy = readFileSync(copy, 'utf8');
      checkBinaries(legacy, version);
      assert.ok(legacy.includes('  # BEGIN RELEASE NOTICES\n  # END RELEASE NOTICES\n'));
      assert.doesNotMatch(legacy, /^ {2}resource "/m);
      assert.doesNotMatch(legacy, /\/download\/[^"\n]+\/(LICENSE|NOTICE)"/);
      update(version);
      assert.equal(readFileSync(copy, 'utf8'), legacy, 'a legacy rerun changes nothing');
    }

    // sha256sum binary-marker entries are supported for the binary and both resources.
    writeFileSync(sums, entries.join('').replaceAll('  ', ' *'));
    update('v9.9.9');
    assert.equal(readFileSync(copy, 'utf8'), out);

    // Every validation failure leaves even an existing generated resource block untouched.
    const invalidManifests = [
      entries[0] ?? '', // Missing required binary checksums.
      entries.slice(0, 11).join(''), // LICENSE without NOTICE.
      entries.slice(0, 10).join('') + (entries[11] ?? ''), // NOTICE without LICENSE.
      entries.join('').replace(digest(10), `${'b'.repeat(63)}g`),
      entries.join('').replace(digest(11), 'c'.repeat(63)),
      entries.join('').replace(digest(11), 'c'.repeat(65)),
      entries.join('').replace(digest(0), `${'1'.repeat(63)}g`),
      entries.join('') + entries[10], // Duplicate LICENSE.
      entries.join('') + entries[0], // Duplicate binary.
    ];
    for (const manifest of invalidManifests) {
      writeFileSync(sums, manifest);
      assert.throws(() =>
        execFileSync('sh', [join(root, 'tools/homebrew-formula.sh'), '9.9.9', sums, copy], {
          stdio: 'ignore',
        }),
      );
      assert.equal(readFileSync(copy, 'utf8'), out);
    }
    writeFileSync(sums, entries.join(''));
    for (const broken of [
      out.replace('  # BEGIN RELEASE NOTICES\n', ''),
      out.replace('  # END RELEASE NOTICES\n', ''),
      `${out}  # BEGIN RELEASE NOTICES\n  # END RELEASE NOTICES\n`,
      out
        .replace(/ {4}url "[^"\n]+LICENSE"/, '    url "https://invalid.example/LICENSE"')
        .replace('  # BEGIN RELEASE NOTICES\n', ''),
    ]) {
      writeFileSync(copy, broken);
      assert.throws(() =>
        execFileSync('sh', [join(root, 'tools/homebrew-formula.sh'), '9.9.9', sums, copy], {
          stdio: 'ignore',
        }),
      );
      assert.equal(readFileSync(copy, 'utf8'), broken);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release: RELEASE_NOTES.md is for this version', () => {
  assert.equal(read('RELEASE_NOTES.md').split('\n')[0], `# A0 v${A0_VERSION}`);
});
