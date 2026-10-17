import assert from 'node:assert/strict';
import { spawnWithInput } from '../../../dist/src/toolchain.js';
import { tables } from './tables.mjs';
export const [EXE, ROOT] = process.argv.slice(2);
assert.ok(EXE && ROOT, 'native executable and caller-owned scratch arguments required');
export function frame(mode, payload, flags = {}) {
  const {
    budget = 100000000,
    maxOutput = 100000000,
    quantum = 10000,
    maxPumps = 1000000,
    platform = 0,
    input = 256,
    output = 1024,
    strict = 0,
    options = 0,
  } = flags;
  const head = [
      0x41584e31,
      1,
      mode,
      budget,
      maxOutput,
      quantum,
      maxPumps,
      platform,
      input,
      output,
      strict,
      options,
      payload.length,
    ],
    buf = Buffer.alloc((head.length + payload.length) * 4);
  head.forEach((v, i) => {
    buf.writeUInt32LE(v, i * 4);
  });
  payload.forEach((v, i) => {
    buf.writeUInt32LE(v, (head.length + i) * 4);
  });
  return buf;
}
export function invokePacket(packet) {
  const r = spawnWithInput(EXE, packet, { maxBuffer: 1 << 28, timeout: 120000 });
  assert.equal(r.signal, null, r.stderr?.toString());
  assert.equal(r.error, undefined, r.error?.message);
  let meta;
  try {
    meta = JSON.parse(r.stderr.toString());
  } catch {}
  return { status: r.status, text: r.stdout.toString(), stderr: r.stderr.toString(), meta };
}
export function sourcePacket(source, flags = {}) {
  const bytes = Array.from(Buffer.from(source));
  return frame(0, [bytes.length, ...bytes, 0x41584531], flags);
}
export function emitSource(source, flags = {}) {
  return invokePacket(sourcePacket(source, flags));
}
export function emitProgram(program, flags = {}) {
  const t = tables(program),
    payload = [];
  for (const v of [t.types, t.tlist, t.fns, t.nodes, t.args, t.pool]) {
    payload.push(v.length);
    for (const w of v) payload.push(w);
  }
  payload.push(...t.counts, 0x41584531);
  return invokePacket(frame(1, payload, flags));
}
export function emitLink(entry, root, flags = {}) {
  const e = Array.from(Buffer.from(entry)),
    r = Array.from(Buffer.from(root));
  return invokePacket(
    frame(
      2,
      [
        e.length,
        ...e,
        r.length,
        ...r,
        flags.explicitRoot ?? 1,
        flags.override ?? 0,
        flags.dense ?? 0,
        flags.work ?? 1000000,
        0x41584531,
      ],
      flags,
    ),
  );
}
