const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async () => {
  const root = process.env.A0_INSTALLED_TEST_ROOT;
  assert.ok(root);
  assert.equal(vscode.workspace.isTrusted, false);
  assert.equal(vscode.workspace.workspaceFolders?.length, 1);
  assert.equal(path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, path.join(root, 'workspace')), '');
  const observer = vscode.extensions.getExtension('a0-tests.installed-observer');
  assert.ok(observer, 'Only the separate observer is a development extension');
  assert.equal(vscode.extensions.getExtension('a0lang.a0'), undefined, 'Installed A0 must be disabled in Restricted Mode');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'workspace/main.a0')));
  await vscode.window.showTextDocument(document);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(vscode.extensions.getExtension('a0lang.a0'), undefined);
  assert.equal(vscode.workspace.isTrusted, false);
  await assert.rejects(fs.readFile(path.join(root, 'server-started')), { code: 'ENOENT' });
  const installation = JSON.parse(await fs.readFile(path.join(root, 'installation.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({
    vscodeVersion: vscode.version, installedVersion: installation.version,
    installedBundleSHA256: installation.bundleSHA256, workspaceTrusted: false,
    a0EnabledInExtensionHost: false, configuredServerStarted: false,
    observedLanguageId: document.languageId, observationMs: 1500,
    scope: 'VSIX-installed A0 disabled in Restricted Mode; separate development observer only; not trusted-workspace LSP',
  }, null, 2));
};
