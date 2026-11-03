const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async () => {
  const root = process.env.A0_EDITOR_TEST_ROOT;
  assert.ok(root, 'the isolated host runner must supply its fixture root');
  assert.equal(vscode.workspace.isTrusted, false, 'this test requires Restricted Mode');
  assert.equal(vscode.workspace.workspaceFolders?.length, 1);
  assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, path.join(root, 'workspace'));
  const extension = vscode.extensions.getExtension('a0lang.a0');
  assert.ok(extension, 'the real A0 extension must be loaded as a development extension');
  assert.equal(extension.packageJSON.capabilities.untrustedWorkspaces.supported, false);
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(root, 'workspace', 'main.a0')),
  );
  await vscode.window.showTextDocument(document);
  assert.equal(document.languageId, 'a0');
  // VS Code exempts development extensions from normal enablement filtering.
  // Exercise A0's execution guard directly, without granting workspace trust.
  await extension.activate();
  // Allow ordinary on-language activation to settle; never grant workspace trust.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(extension.isActive, true, 'the execution guard must actually be exercised');
  await assert.rejects(fs.readFile(path.join(root, 'server-started')), { code: 'ENOENT' });
  assert.equal(vscode.workspace.isTrusted, false);
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({
    vscodeVersion: vscode.version,
    workspaceTrusted: false,
    languageId: document.languageId,
    extensionPresent: true,
    extensionActive: extension.isActive,
    configuredServerStarted: false,
    observationMs: 1500,
    scope: 'Development-host Restricted Mode registration and A0 execution guard; not installed-extension enablement or trusted-workspace LSP',
  }, null, 2));
};
