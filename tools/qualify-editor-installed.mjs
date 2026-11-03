/** Real VSIX installation check in an isolated runner profile. Never grants workspace trust. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  await readFile(join(repository, 'editors/vscode/package.json'), 'utf8'),
);
const [phase, rootArg, editor, ...extra] = process.argv.slice(2);
assert.ok(rootArg && extra.length === 0, 'Supply prepare <new fixture> or run <fixture> <editor>');
const root = resolve(rootArg);
const workspace = join(root, 'workspace');
const profile = join(root, 'profile');
const extensions = join(root, 'extensions');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (phase === 'prepare') {
  assert.equal(editor, undefined);
  await mkdir(root); // Existing paths are refused; this tool never deletes an installation.
  await mkdir(join(workspace, '.vscode'), { recursive: true });
  await mkdir(join(profile, 'User'), { recursive: true });
  await mkdir(extensions);
  await mkdir(join(root, 'observer'));
  await writeFile(
    join(root, 'fixture.json'),
    JSON.stringify({ kind: 'a0-installed-editor-test-v1', root }),
  );
  await writeFile(
    join(profile, 'User/settings.json'),
    JSON.stringify({
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
    }),
  );
  const probe = join(root, 'server-probe.cjs');
  await writeFile(
    probe,
    `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'server-started'))}, 'started');`,
  );
  await writeFile(join(workspace, 'main.a0'), 'fn main -> u32\nret 1\nend\n');
  await writeFile(
    join(workspace, '.vscode/settings.json'),
    JSON.stringify({
      'a0.server.path': process.execPath,
      'a0.server.args': [probe],
    }),
  );
  await writeFile(
    join(root, 'observer/package.json'),
    JSON.stringify({
      name: 'installed-observer',
      publisher: 'a0-tests',
      version: '0.0.1',
      engines: { vscode: '^1.100.0' },
      main: './observer.cjs',
      activationEvents: ['*'],
      capabilities: { untrustedWorkspaces: { supported: true } },
    }),
  );
  await writeFile(join(root, 'observer/observer.cjs'), 'exports.activate = () => {};\n');
  console.log('Prepared isolated installed-extension fixture');
} else if (phase === 'run') {
  assert.ok(editor, 'Supply the approved editor executable');
  const fixture = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8'));
  assert.equal(fixture.kind, 'a0-installed-editor-test-v1');
  assert.equal(fixture.root, root);
  const listing = (await readFile(join(root, 'installed.txt'), 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim());
  assert.ok(
    listing.includes(`a0lang.a0@${manifest.version}`),
    'The vendor CLI must list the installed A0 VSIX',
  );
  const matches = [];
  for (const entry of await readdir(extensions, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(extensions, entry.name);
    let candidate;
    try {
      candidate = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (candidate.publisher === 'a0lang' && candidate.name === 'a0')
      matches.push({ directory, candidate });
  }
  assert.equal(matches.length, 1, 'Exactly one A0 installation must exist');
  const { directory, candidate } = matches[0];
  assert.equal(candidate.version, manifest.version);
  assert.equal(candidate.main, manifest.main);
  assert.equal(candidate.capabilities.untrustedWorkspaces.supported, false);
  const installedMain = await realpath(join(directory, candidate.main));
  const inside = relative(await realpath(extensions), installedMain);
  assert.ok(!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`));
  const bundleSHA256 = sha256(await readFile(installedMain));
  assert.equal(
    bundleSHA256,
    sha256(await readFile(join(repository, 'editors/vscode', manifest.main))),
  );
  await writeFile(
    join(root, 'installation.json'),
    JSON.stringify({ version: candidate.version, bundleSHA256 }),
  );
  const result = spawnSync(
    resolve(editor),
    [
      '--new-window',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir',
      profile,
      '--extensions-dir',
      extensions,
      '--extensionDevelopmentPath',
      join(root, 'observer'),
      '--extensionTestsPath',
      join(repository, 'editors/vscode/test/host/installed.cjs'),
      workspace,
    ],
    { env: { ...process.env, A0_INSTALLED_TEST_ROOT: root }, stdio: 'inherit', timeout: 120_000 },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'The installed-extension host check must pass');
  assert.equal(
    sha256(await readFile(installedMain)),
    bundleSHA256,
    'Installed bundle must remain unchanged',
  );
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
  assert.equal(report.workspaceTrusted, false);
  assert.equal(report.a0EnabledInExtensionHost, false);
  assert.equal(report.configuredServerStarted, false);
  console.log(JSON.stringify(report, null, 2));
} else {
  throw new Error('Expected prepare or run');
}
