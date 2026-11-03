import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Lifecycle did not reach the expected state');
}

function fixture(
  options: {
    start?: Promise<void>;
    stop?: Promise<void>;
    failFirstStop?: boolean;
    failFirstStart?: boolean;
  } = {},
) {
  const clients: { running: boolean; starts: number; stops: number }[] = [];
  const errors: string[] = [];
  let restart: (() => Promise<void>) | undefined;
  let change: ((event: { affectsConfiguration: () => boolean }) => Promise<void>) | undefined;
  const exports: {
    activate?: (context: { subscriptions: unknown[] }) => Promise<void>;
    deactivate?: () => Promise<void>;
  } = {};
  const workspace = {
    isTrusted: true,
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/synthetic project' } }],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    createFileSystemWatcher: () => ({}),
    onDidGrantWorkspaceTrust: () => ({}),
    onDidChangeConfiguration: (callback: typeof change) => {
      change = callback;
      return {};
    },
  };
  class Client {
    index = clients.length;
    entry = { running: false, starts: 0, stops: 0 };
    constructor() {
      clients.push(this.entry);
    }
    async start() {
      this.entry.starts++;
      if (this.index === 0) await options.start;
      if (this.index === 0 && options.failFirstStart) throw new Error('synthetic start failure');
      this.entry.running = true;
    }
    isRunning() {
      return this.entry.running;
    }
    async stop() {
      this.entry.stops++;
      if (!this.entry.running) throw new Error('cannot stop a client that did not start');
      if (this.index === 0 && this.entry.stops === 1 && options.failFirstStop) {
        throw new Error('synthetic stop failure');
      }
      if (this.index === 0) await options.stop;
      this.entry.running = false;
    }
  }
  const vscode = {
    workspace,
    commands: {
      registerCommand: (_name: string, callback: () => Promise<void>) => {
        restart = callback;
        return {};
      },
    },
    window: {
      createOutputChannel: () => ({}),
      showErrorMessage: (message: string) => {
        errors.push(message);
      },
    },
  };
  const js = ts.transpileModule(readFileSync('editors/vscode/src/extension.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(js, {
    exports,
    require: (name: string) =>
      name === 'vscode' ? vscode : { LanguageClient: Client, TransportKind: { stdio: 0 } },
  });
  return {
    clients,
    errors,
    workspace,
    activate: () => {
      assert.ok(exports.activate);
      return exports.activate({ subscriptions: [] });
    },
    deactivate: () => {
      assert.ok(exports.deactivate);
      return exports.deactivate();
    },
    restart: () => {
      assert.ok(restart);
      return restart();
    },
    change: () => {
      assert.ok(change);
      return change({ affectsConfiguration: () => true });
    },
  };
}

test('editor deactivation waits for an in-flight start and stops its client', async () => {
  const start = barrier();
  const h = fixture({ start: start.promise });
  const activating = h.activate();
  await until(() => h.clients[0]?.starts === 1);
  const deactivating = h.deactivate();
  start.release();
  await Promise.all([activating, deactivating]);
  assert.equal(h.clients.filter((client) => client.running).length, 0);
  assert.equal(h.clients[0]?.stops, 1);
});

test('overlapping editor restart and configuration change leave one owned client', async () => {
  const stop = barrier();
  const h = fixture({ stop: stop.promise });
  await h.activate();
  const restarting = h.restart();
  await until(() => h.clients[0]?.stops === 1);
  const changing = h.change();
  stop.release();
  await Promise.all([restarting, changing]);
  assert.equal(h.clients.filter((client) => client.running).length, 1);
  await h.deactivate();
  assert.equal(h.clients.filter((client) => client.running).length, 0);
});

test('editor deactivation prevents queued restarts from launching a replacement', async () => {
  const stop = barrier();
  const h = fixture({ stop: stop.promise });
  await h.activate();
  const restarting = h.restart();
  await until(() => h.clients[0]?.stops === 1);
  const changing = h.change();
  const deactivating = h.deactivate();
  stop.release();
  await Promise.all([restarting, changing, deactivating]);
  assert.equal(h.clients.filter((client) => client.running).length, 0);
  assert.equal(h.clients.length, 1);
});

test('failed editor stop keeps ownership and retries before starting a replacement', async () => {
  const h = fixture({ failFirstStop: true });
  await h.activate();
  await h.restart().catch(() => {});
  assert.equal(h.clients.length, 1);
  assert.match(h.errors[0] ?? '', /synthetic stop failure/);
  await h.restart();
  assert.equal(h.clients[0]?.stops, 2);
  assert.equal(h.clients.filter((client) => client.running).length, 1);
  await h.deactivate();
});

test('editor can restart after a failed startup without stopping an unstarted client', async () => {
  const h = fixture({ failFirstStart: true });
  await h.activate();
  assert.match(h.errors[0] ?? '', /synthetic start failure/);
  await h.restart();
  assert.equal(h.clients[0]?.stops, 0);
  assert.equal(h.clients.filter((client) => client.running).length, 1);
  await h.deactivate();
});

test('editor shutdown exposes a stop failure and retains ownership for retry', async () => {
  const h = fixture({ failFirstStop: true });
  await h.activate();
  await assert.rejects(h.deactivate(), /synthetic stop failure/);
  assert.equal(h.clients[0]?.running, true);
  await h.deactivate();
  assert.equal(h.clients[0]?.stops, 2);
  assert.equal(h.clients.filter((client) => client.running).length, 0);
  assert.equal(h.clients.length, 1);
});

test('queued editor restart rechecks workspace trust before launching', async () => {
  const stop = barrier();
  const h = fixture({ stop: stop.promise });
  await h.activate();
  const restarting = h.restart();
  await until(() => h.clients[0]?.stops === 1);
  h.workspace.isTrusted = false;
  stop.release();
  await restarting;
  assert.equal(h.clients.length, 1);
  assert.equal(h.clients.filter((client) => client.running).length, 0);
  await h.deactivate();
});
