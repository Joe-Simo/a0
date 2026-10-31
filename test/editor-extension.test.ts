import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function activate(
  config: Record<string, unknown>,
  trusted = true,
  folders = [{ uri: { scheme: 'file', fsPath: '/synthetic project' } }],
) {
  const clients: { server: unknown; started: boolean }[] = [];
  const errors: string[] = [];
  const exports: { activate?: (context: unknown) => Promise<void> } = {};
  const vscode = {
    commands: { registerCommand: () => ({}) },
    workspace: {
      isTrusted: trusted,
      workspaceFolders: folders,
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => config[key] ?? fallback,
      }),
      createFileSystemWatcher: () => ({}),
      onDidChangeConfiguration: () => ({}),
      onDidGrantWorkspaceTrust: () => ({}),
    },
    window: {
      createOutputChannel: () => ({}),
      showErrorMessage: (text: string) => errors.push(text),
    },
  };
  class Client {
    entry: { server: unknown; started: boolean };
    constructor(_id: unknown, _name: unknown, server: unknown) {
      this.entry = { server, started: false };
      clients.push(this.entry);
    }
    async start() {
      this.entry.started = true;
    }
    isRunning() {
      return this.entry.started;
    }
    async stop() {
      this.entry.started = false;
    }
  }
  const source = readFileSync('editors/vscode/src/extension.ts', 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(js, {
    exports,
    require: (name: string) =>
      name === 'vscode' ? vscode : { LanguageClient: Client, TransportKind: { stdio: 0 } },
  });
  await exports.activate?.({ subscriptions: [] });
  return { clients, errors };
}

test('VS Code keeps default launch and uses explicit candidate argv with a local workspace', async () => {
  const pattern = new RegExp(
    JSON.parse(readFileSync('editors/vscode/language-configuration.json', 'utf8')).wordPattern,
  );
  for (const word of ['_', '_x3', 'A', 'p26', 'p0k']) assert.equal(pattern.exec(word)?.[0], word);
  const legacy = await activate({});
  assert.equal(legacy.clients.length, 1);
  assert.equal(
    JSON.stringify(legacy.clients[0]?.server),
    JSON.stringify({
      run: { command: 'a0', args: ['lsp'], transport: 0 },
      debug: { command: 'a0', args: ['lsp'], transport: 0 },
    }),
  );
  const candidate = await activate({ 'server.path': 'node', 'server.args': ['.a0/cli.mjs'] });
  assert.equal(candidate.clients[0]?.started, true);
  const server = candidate.clients[0]?.server as {
    run: { command: string; args: string[]; options: { cwd: string } };
  };
  assert.equal(server.run.command, 'node');
  assert.equal(JSON.stringify(server.run.args), JSON.stringify(['.a0/cli.mjs', 'lsp']));
  assert.equal(server.run.options.cwd, '/synthetic project');
});

test('VS Code does not launch workspace code without trust or with invalid/ambiguous settings', async () => {
  assert.equal(
    (await activate({ 'server.path': 'node', 'server.args': ['.a0/cli.mjs'] }, false)).clients
      .length,
    0,
  );
  for (const args of [[1], ['bad\0arg']]) {
    const r = await activate({ 'server.args': args });
    assert.equal(r.clients.length, 0);
    assert.ok(r.errors.length > 0);
  }
  const multi = await activate({ 'server.args': ['.a0/cli.mjs'] }, true, [
    { uri: { scheme: 'file', fsPath: '/one' } },
    { uri: { scheme: 'file', fsPath: '/two' } },
  ]);
  assert.equal(multi.clients.length, 0);
  assert.match(multi.errors[0] ?? '', /one local/);
  const manifest = JSON.parse(readFileSync('editors/vscode/package.json', 'utf8'));
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
});
