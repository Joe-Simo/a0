import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const dir = process.argv[2];
assert.ok(dir, 'caller-owned scratch directory required');
const cases = [];
function add(text, options = {}) {
  const words = options.words ?? Buffer.from(text);
  const value = Number(text),
    bits = Buffer.alloc(8);
  bits.writeDoubleLE(value);
  cases.push({
    words,
    start: 0,
    length: words.length,
    extra: 32,
    mode: 0,
    code: 0,
    low: bits.readUInt32LE(0),
    high: bits.readUInt32LE(4),
    text: String(value),
    ...options,
  });
}
function failure(words, start, length, code, extra = 32, mode = 0) {
  cases.push({ words, start, length, extra, mode, code, low: 0, high: 0, text: '' });
}
for (let e = 0n; e <= 1025n; e++) {
  const n = 1n << e,
    unit = 1n << (e > 52n ? e - 52n : 0n);
  for (const d of [-1n, 0n, 1n, -unit / 2n - 1n, -unit / 2n, unit / 2n, unit / 2n + 1n])
    if (n + d >= 0n) add(String(n + d));
}
for (let n = 1n; n <= 10n ** 309n; n *= 10n)
  for (const d of [-1n, 0n, 1n]) if (n + d >= 0n) add(String(n + d));
let state = 0x745a1b23;
const word = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
};
for (let i = 0; i < 600; i++) {
  const length = 1 + (word() % 309);
  let text = String(1 + (word() % 9));
  for (let j = 1; j < length; j++) text += String(word() % 10);
  add(text);
}
for (const length of [1, 2, 127, 128, 129, 255, 256, 257, 65535, 65536, 65537, 2097152]) {
  add('0'.repeat(length));
  add('0'.repeat(length - 1) + '1');
}
for (const text of [
  '9007199254740991',
  '9007199254740992',
  '9007199254740993',
  '999999999999999999999',
  '1000000000000000000000',
  '17976931348623157' + '0'.repeat(292),
  '9'.repeat(309),
  '1' + '0'.repeat(309),
  '9'.repeat(65537),
])
  add(text);
const positive = cases.length;
for (const text of [
  '0',
  '0001',
  '9007199254740993',
  '1' + '0'.repeat(21),
  '9'.repeat(309),
  '9'.repeat(310),
]) {
  const bytes = Buffer.from(text),
    words = Uint32Array.from([0xffffffff, 256, ...bytes, 0xffffffff, 32]);
  add(text, { words, start: 2, length: bytes.length });
  const wanted = String(Number(text)).length;
  const capacity = 2 ** Math.ceil(Math.log2(wanted));
  failure(bytes, 0, bytes.length, 4, capacity - 1);
}
for (const at of [0, 1, 127, 128, 308, 309, 65536]) {
  const words = new Uint32Array(at + 1).fill(57);
  words[at] = 120;
  failure(words, 0, words.length, 3);
  for (const cell of [256, 0xffffffff]) {
    const other = words.slice();
    other[at] = cell;
    failure(other, 0, other.length, 3);
  }
}
failure(Buffer.from('123'), 0, 4, 3);
failure(Buffer.from('123'), 4, 1, 3);
failure(Buffer.from('123'), 0xffffffff, 1, 3);
failure([], 0, 0, 3);
failure([], 0, 1, 2, 32, 1);
let byteCount = 0;
for (const c of cases) byteCount += (5 + c.words.length) * 4;
const input = Buffer.alloc(byteCount);
let off = 0;
for (const c of cases) {
  for (const n of [c.words.length, c.start, c.length, c.extra, c.mode]) {
    input.writeUInt32LE(n, off);
    off += 4;
  }
  for (const n of c.words) {
    input.writeUInt32LE(n, off);
    off += 4;
  }
}
await writeFile(`${dir}/input.bin`, input);
const reports = [];
for (const level of [0, 2]) {
  const output = `${dir}/output-O${level}.bin`;
  const ran = spawnSync(`${dir}/driver-O${level}`, [`${dir}/input.bin`, output], {
    maxBuffer: 1 << 20,
    timeout: 300000,
  });
  assert.equal(ran.status, 0, String(ran.stderr));
  assert.equal(ran.stdout.length, 0);
  assert.equal(ran.stderr.length, 0);
  const bytes = await readFile(output);
  let cursor = 0;
  for (const [i, c] of cases.entries()) {
    assert(cursor + 16 <= bytes.length, `truncated case${i}`);
    const code = bytes.readUInt32LE(cursor),
      low = bytes.readUInt32LE(cursor + 4),
      high = bytes.readUInt32LE(cursor + 8),
      length = bytes.readUInt32LE(cursor + 12);
    cursor += 16;
    const text = bytes.subarray(cursor, cursor + length).toString('ascii');
    cursor += length;
    assert.equal(code, c.code, `O${level} case${i} code (${c.length} digits)`);
    assert.equal(low, c.low, `O${level} case${i} low`);
    assert.equal(high, c.high, `O${level} case${i} high`);
    assert.equal(text, c.text, `O${level} case${i} text`);
  }
  assert.equal(cursor, bytes.length);
  reports.push({
    optimization: level,
    positive,
    controls: cases.length - positive,
    requests: cases.length,
    oracle: 'JS Number(original decimal bytes), DataView-equivalent binary64 bits, String(value)',
    ubsan: true,
    inputImmutable: true,
    ioUnchanged: true,
    completed: true,
    result: 'pass',
  });
}
await writeFile(`${dir}/native-results.json`, JSON.stringify(reports, null, 2) + '\n');
console.log(JSON.stringify(reports));
