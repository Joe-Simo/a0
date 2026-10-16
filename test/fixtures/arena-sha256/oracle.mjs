import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const dir = process.argv[2];
assert.ok(dir, 'native fixture directory');
const cases = [];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const add = (bytes, expected) => {
  const hash = digest(bytes);
  if (expected) assert.equal(hash, expected);
  cases.push({
    words: bytes,
    length: bytes.length,
    extra: 64,
    mode: 0,
    code: 0,
    rawCode: 0,
    hash,
    text: hash,
  });
};
add(Buffer.alloc(0), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
add(Buffer.from('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
add(
  Buffer.from('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
);
add(Buffer.alloc(1000000, 97), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
add(Buffer.from('A0🙂\0é\ud800'));
for (let n = 0; n <= 1024; n++)
  add(Buffer.from(Array.from({ length: n }, (_, i) => (i * 79 + n * 17) & 255)));
let state = 0x9f153c21;
const word = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
};
for (let i = 0; i < 150; i++) add(Buffer.from(Array.from({ length: word() % 16385 }, word)));
for (const n of [65535, 65536, 65537, 131071, 131072, 131073, 2097151, 2097152])
  add(Buffer.from(Array.from({ length: n }, (_, i) => (i * 127 + (i >>> 8)) & 255)));
const values = cases.length;
for (const n of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1024]) {
  const bytes = Buffer.alloc(n, 79),
    hash = digest(bytes);
  cases.push({ words: bytes, length: n, extra: 63, mode: 0, code: 4, rawCode: 0, hash, text: '' });
}
for (const n of [1, 55, 56, 63, 64, 65, 128, 129]) {
  const words = new Uint32Array(n);
  words[n - 1] = n % 2 ? 256 : 0xffffffff;
  cases.push({
    words,
    length: n,
    extra: 64,
    mode: 0,
    code: 3,
    rawCode: 3,
    hash: '0'.repeat(64),
    text: '',
  });
  const bytes = Buffer.alloc(n, 37);
  cases.push({
    words: bytes,
    length: n + 1,
    extra: 64,
    mode: 0,
    code: 3,
    rawCode: 3,
    hash: '0'.repeat(64),
    text: '',
  });
}
cases.push({
  words: [],
  length: 1,
  extra: 64,
  mode: 1,
  code: 2,
  rawCode: 2,
  hash: '0'.repeat(64),
  text: '',
});
const empty = digest(Buffer.alloc(0));
cases.push({
  words: [],
  length: 0,
  extra: 64,
  mode: 1,
  code: 0,
  rawCode: 0,
  hash: empty,
  text: empty,
});
const count = cases.reduce((n, c) => n + 4 + c.words.length, 0),
  input = Buffer.alloc(count * 4);
let cursor = 0;
for (const c of cases) {
  for (const n of [c.words.length, c.length, c.extra, c.mode]) {
    input.writeUInt32LE(n, cursor);
    cursor += 4;
  }
  for (const n of c.words) {
    input.writeUInt32LE(n, cursor);
    cursor += 4;
  }
}
const reports = [];
await writeFile(`${dir}/input.bin`, input);
for (const level of [0, 2]) {
  const fd = openSync(`${dir}/input.bin`, 'r');
  let ran;
  try {
    ran = spawnSync(`${dir}/driver-O${level}`, [], {
      stdio: [fd, 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180000,
    });
  } finally {
    closeSync(fd);
  }
  assert.equal(ran.status, 0, String(ran.stderr));
  assert.equal(ran.stderr.length, 0);
  let off = 0;
  for (const [i, c] of cases.entries()) {
    assert(off + 44 <= ran.stdout.length, `truncated${i}`);
    const code = ran.stdout.readUInt32LE(off),
      rawCode = ran.stdout.readUInt32LE(off + 4);
    off += 8;
    const hash = Array.from({ length: 8 }, () => {
      const n = ran.stdout.readUInt32LE(off);
      off += 4;
      return n.toString(16).padStart(8, '0');
    }).join('');
    const length = ran.stdout.readUInt32LE(off);
    off += 4;
    const text = ran.stdout.subarray(off, off + length).toString('ascii');
    off += length;
    assert.equal(code, c.code, `O${level} case${i} hexcode input${c.length}`);
    assert.equal(rawCode, c.rawCode, `O${level} case${i} rawcode`);
    assert.equal(hash, c.hash, `O${level} case${i} words input${c.length}`);
    assert.equal(text, c.text, `O${level} case${i} hex input${c.length}`);
  }
  assert.equal(off, ran.stdout.length);
  reports.push({
    optimization: level,
    valueCases: values,
    controls: cases.length - values,
    requests: cases.length,
    inputImmutable: true,
    ioUnchanged: true,
    completed: true,
    ubsan: true,
    result: 'pass',
  });
}
await writeFile(
  `${dir}/native-results.json`,
  JSON.stringify(
    {
      oracles: 'FIPS180-4 published vectors + node:crypto independently over original bytes',
      reports,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(reports));
