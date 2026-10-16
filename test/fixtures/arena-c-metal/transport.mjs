import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tables } from '../../../dist/test/fixtures/sv-emitter/tables.js';

const root = process.argv[2];
let serial = 0;
export function encode(t) {
  const arrays = [t.types, t.tlist, t.fns, t.nodes, t.args, t.pool],
    b = Buffer.alloc((9 + arrays.reduce((n, a) => n + a.length, 0)) * 4);
  let at = 0;
  for (const n of [...arrays.map((a) => a.length), ...t.counts]) {
    b.writeUInt32LE(n >>> 0, at);
    at += 4;
  }
  for (const a of arrays)
    for (const n of a) {
      b.writeUInt32LE(n >>> 0, at);
      at += 4;
    }
  return b;
}
export function runTables(
  t,
  level = 0,
  metal = false,
  incap = 256,
  outcap = 1024,
  flags = 0,
  budget = 50000000,
  maxout = 50000000,
  target,
) {
  const id = serial++,
    ip = `${root}/build/native-${process.pid}-${id}.bin`,
    op = `${root}/build/native-${process.pid}-${id}.out`;
  writeFileSync(ip, encode(t));
  const args = [
    ip,
    op,
    String(budget),
    String(maxout),
    metal ? '1' : '0',
    String(incap),
    String(outcap),
    String(flags),
  ];
  if (target) {
    const tp = `${root}/build/native-${process.pid}-${id}-target.bin`;
    writeFileSync(tp, encode(target));
    args.push(tp);
  }
  const r = spawnSync(`${root}/build/driver-O${level}`, args, {
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.ok(r.status === 0 || r.status === 20, r.stderr);
  const status = JSON.parse(r.stderr);
  assert.ok(
    status.complete && status.inputUnchanged && status.ioUnchanged && status.allocatedWords === 0,
    r.stderr,
  );
  assert.equal(r.status === 0, status.status === 0, r.stderr);
  let text = '';
  if (!status.status) {
    assert.ok(status.published);
    text = readFileSync(op, 'utf8');
    assert.equal(Buffer.byteLength(text), status.resultLength);
    assert.equal(status.outputCount, status.resultLength);
  } else {
    assert.equal(status.published, false);
    assert.equal(existsSync(op), false);
  }
  return { code: status.status, text, status };
}
export function nativeEmit(
  p,
  level = 0,
  incap = 256,
  outcap = 1024,
  flags = 0,
  budget = 50000000,
  maxout = 50000000,
  metal = false,
) {
  return runTables(tables(p), level, metal, incap, outcap, flags, budget, maxout);
}
