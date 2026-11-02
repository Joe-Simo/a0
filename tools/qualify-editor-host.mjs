/** Isolated real-editor refusal check. No downloads, account access or trust changes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const editor = process.argv[2];
if (!editor) throw new Error('Supply an approved cloud VS Code executable as the only argument');
if (process.argv.length !== 3) throw new Error('Unexpected arguments');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await access(editor);
await access(join(repository, 'editors/vscode/dist/extension.js'));
const root = await mkdtemp(join(tmpdir(), 'a0-editor-host-'));
try {
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, '.vscode'), { recursive: true });
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
  const result = spawnSync(
    resolve(editor),
    [
      '--new-window',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir',
      join(root, 'profile'),
      '--extensions-dir',
      join(root, 'extensions'),
      '--extensionDevelopmentPath',
      join(repository, 'editors/vscode'),
      '--extensionTestsPath',
      join(repository, 'editors/vscode/test/host/index.cjs'),
      workspace,
    ],
    {
      env: { ...process.env, A0_EDITOR_TEST_ROOT: root },
      stdio: 'inherit',
      timeout: 120_000,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'the real editor host must finish its test successfully');
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
  assert.equal(report.workspaceTrusted, false);
  assert.equal(report.configuredServerStarted, false);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
