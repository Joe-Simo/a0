// The free distribution paths work without the network: the MCP server answers a real stdio
// handshake, install.sh picks the right asset and refuses a bad checksum (against a local HTTP
// server and a fake `uname`), server.json validates against the registry schema, and the skill
// layout is the one the `skills` CLI discovers.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

test('distribution: `a0 mcp` answers initialize and tools/list over real stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0-dist-mcp-'));
  const child = spawn(process.execPath, [join(root, 'dist/src/cli.js'), 'mcp', dir], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const replies = new Map<number, { result?: Record<string, unknown> }>();
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          const m = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
          if (m.id !== undefined) replies.set(m.id, m);
        }
      }
    });
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const waitFor = async (id: number) => {
      for (let i = 0; i < 300 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 50));
      const r = replies.get(id);
      assert.ok(r, `no reply to request ${id}`);
      return r.result as Record<string, unknown>;
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'handshake-test', version: '0.0.0' },
      },
    });
    const init = await waitFor(1);
    assert.ok((init.capabilities as Record<string, unknown>).tools);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await waitFor(2);
    const names = (list.tools as { name: string }[]).map((t) => t.name);
    for (const n of [
      'a0_open',
      'a0_program',
      'a0_apply',
      'a0_check',
      'a0_run',
      'a0_emit',
      'a0_save',
    ]) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

const sh = spawnSync('sh', ['-c', 'command -v awk && command -v curl && command -v sha256sum'], {
  encoding: 'utf8',
});
const haveSh = sh.status === 0;

async function install(uname: { s: string; m: string }, tamper: boolean) {
  const work = mkdtempSync(join(tmpdir(), 'a0-dist-inst-'));
  const assets = [
    'a0-darwin-arm64',
    'a0-darwin-x64',
    'a0-linux-arm64',
    'a0-linux-x64',
    'a0-windows-x64.exe',
  ];
  const body = (a: string) => Buffer.from(`#!/bin/sh\necho fixture ${a}\n`);
  const sums = assets
    .map((a) => `${createHash('sha256').update(body(a)).digest('hex')}  ${a}\n`)
    .join('');
  const server = createServer((req, res) => {
    const name = (req.url ?? '').slice(1);
    if (name === 'checksums.txt') return void res.end(sums);
    const a = assets.find((x) => x === name);
    if (!a) {
      res.statusCode = 404;
      return void res.end();
    }
    res.end(tamper ? Buffer.from('tampered') : body(a));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const bin = join(work, 'fakebin');
  mkdirSync(bin);
  const fake = join(bin, 'uname');
  writeFileSync(
    fake,
    `#!/bin/sh\nif [ "$1" = -s ]; then echo ${uname.s}; else echo ${uname.m}; fi\n`,
  );
  chmodSync(fake, 0o755);
  const dest = join(work, 'dest');
  const portable = (p: string) => p.replace(/\\/g, '/');
  try {
    const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const c = spawn('sh', [portable(join(root, 'install.sh'))], {
        env: {
          ...process.env,
          PATH: `${portable(bin)}:${process.env.PATH}`,
          A0_RELEASE_URL: `http://127.0.0.1:${port}`,
          A0_INSTALL_DIR: portable(dest),
          HOME: portable(work),
        },
      });
      let out = '';
      c.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      c.stderr.on('data', (d: Buffer) => {
        out += d.toString();
      });
      c.on('close', (status) => resolve({ status, out }));
    });
    return { ...r, installed: existsSync(join(dest, 'a0')), dest };
  } finally {
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
}

test('install.sh: platform to asset name, SHA-256 verified', { skip: !haveSh }, async () => {
  const cases: [string, string, string][] = [
    ['Darwin', 'arm64', 'a0-darwin-arm64'],
    ['Linux', 'x86_64', 'a0-linux-x64'],
    ['Linux', 'aarch64', 'a0-linux-arm64'],
  ];
  for (const [s, m, asset] of cases) {
    const r = await install({ s, m }, false);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, new RegExp(`downloading ${asset} from`));
    assert.match(r.out, /sha256 verified/);
    assert.ok(r.installed);
  }
});

test('install.sh: a checksum mismatch installs nothing; unsupported OS is refused', {
  skip: !haveSh,
}, async () => {
  const bad = await install({ s: 'Linux', m: 'x86_64' }, true);
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /checksum mismatch/);
  assert.equal(bad.installed, false);
  const os = await install({ s: 'FreeBSD', m: 'x86_64' }, false);
  assert.notEqual(os.status, 0);
  assert.match(os.out, /unsupported OS/);
});

test('install.ps1: fixed Windows asset, verifies against checksums.txt', () => {
  const ps = read('install.ps1');
  assert.match(ps, /\$asset = 'a0-windows-x64\.exe'/);
  assert.match(ps, /Get-FileHash -Algorithm SHA256/);
  assert.match(ps, /checksum mismatch/);
});

test('server.json validates against the official MCP registry schema', () => {
  const schema = JSON.parse(read('docs/distribution/server.schema.json'));
  const req = createRequire(import.meta.url);
  type V = ((d: unknown) => boolean) & { errors?: unknown };
  const Ajv = req('ajv') as new (o: object) => { compile: (s: object) => V };
  const addFormats = req('ajv-formats') as (a: unknown) => void;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const ok = validate(JSON.parse(read('server.json')));
  assert.ok(ok, JSON.stringify(validate.errors));
});

test('skills layout: skills/a0/SKILL.md has name and description frontmatter', () => {
  const m = /^---\nname: a0\ndescription: (.+)\n/.exec(read('skills/a0/SKILL.md'));
  assert.ok(m && (m[1] ?? '').length > 40);
  assert.ok(existsSync(join(root, 'skills/a0/references/primer.txt')));
});
