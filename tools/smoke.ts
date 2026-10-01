// Post-release smoke test of an installed `a0` binary: version, check, run, and an MCP
// initialize + tools/list handshake. Exits non-zero on the first failure.
//   node tools/smoke.ts <path to a0> <expected version, e.g. 0.8.16>
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Result {
  serverInfo?: { version?: string };
  tools?: { name: string }[];
}

const [bin, version] = process.argv.slice(2);
if (bin === undefined || version === undefined) {
  console.error('usage: node tools/smoke.ts <a0 binary> <version>');
  process.exit(2);
}

function fail(message: string): never {
  console.error(`smoke: FAIL ${message}`);
  process.exit(1);
}

function a0(...args: string[]): string {
  const r = spawnSync(bin as string, args, { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) fail(`a0 ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.error ?? ''}`);
  return r.stdout;
}

const dir = mkdtempSync(join(tmpdir(), 'a0-smoke-'));
const program = join(dir, 'sq.a0');
writeFileSync(program, 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n');

try {
  const reported = a0('--version').trim();
  if (!reported.startsWith(`a0 ${version} (compiler `)) fail(`--version printed '${reported}'`);
  console.log(`smoke: ${reported}`);
  a0('check', program);
  console.log('smoke: check ok');
  const ran = a0('run', program, 'sq', '12').trim();
  if (ran !== '144') fail(`run sq 12 printed '${ran}', expected 144`);
  console.log('smoke: run ok (144)');

  const child = spawn(bin, ['mcp', dir], { stdio: ['pipe', 'pipe', 'inherit'] });
  const timer = setTimeout(() => fail('mcp handshake timed out'), 60_000);
  let buffer = '';
  const results = new Map<number, Result>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      const msg = JSON.parse(line) as { id?: number; result?: Result };
      if (msg.id !== undefined && msg.result !== undefined) results.set(msg.id, msg.result);
      const list = results.get(2);
      if (list === undefined) continue;
      clearTimeout(timer);
      child.kill();
      const init = results.get(1);
      if (init?.serverInfo?.version !== version)
        fail(`mcp serverInfo.version ${init?.serverInfo?.version}`);
      const names = (list.tools ?? []).map((t) => t.name).sort();
      const want = [
        'a0_apply',
        'a0_check',
        'a0_emit',
        'a0_open',
        'a0_program',
        'a0_run',
        'a0_save',
      ];
      if (names.join() !== want.join()) fail(`mcp tools/list returned ${names.join()}`);
      console.log(`smoke: mcp ok (${names.length} tools)`);
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    }
  });
  child.on('exit', () => {
    if (results.get(2) === undefined) fail('mcp server exited before tools/list');
  });
  const send = (m: object): void => {
    child.stdin.write(`${JSON.stringify(m)}\n`);
  };
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '1' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
} catch (e) {
  fail(String(e));
}
