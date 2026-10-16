// File-backed test transport and independent Node Buffer oracle; no decoder fallback.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const sha = (x) => createHash('sha256').update(x).digest('hex');

export function prepareCase(item, index) {
  let expectedBytes;
  const options = item.options,
    raw = item.raw,
    length = options.length ?? raw.length,
    mode = options.mode ?? 0,
    base = (raw.length || 1) + 4 + (options.padding ?? 0),
    budget = options.noGrowth
      ? base
      : options.extraBudget !== undefined
        ? base + options.extraBudget
        : 32000000;
  const head = [
    0x55384e50,
    mode,
    budget,
    raw.length,
    length,
    options.padding ?? 0,
    options.badHandle ?? 0,
    options.fault?.op ?? 0,
    options.fault?.nth ?? 0,
    options.fault?.status ?? 0,
    options.fault?.kind ?? 0,
    options.lifecycle ?? 0,
    options.slot ?? 0,
    options.forgedLength ?? 0,
    options.appendCount ?? 0,
  ];
  const packet = Buffer.alloc((head.length + raw.length) * 4);
  head.forEach((x, i) => {
    packet.writeUInt32LE(x >>> 0, i * 4);
  });
  for (let i = 0; i < raw.length; i++) packet.writeUInt32LE(raw[i], (head.length + i) * 4);
  const id = String(index).padStart(4, '0'),
    input = `inputs/${id}.bin`;
  const row = {
    index,
    label: item.label,
    mode,
    input,
    inputSHA256: sha(packet),
    rawWords: raw.length,
    length,
    options,
    code: options.code ?? 0,
  };
  if (mode === 0 && row.code === 0) {
    const bytes = Buffer.from(raw.subarray(0, length)),
      text = bytes.toString('utf8'),
      expected = Buffer.from(text),
      file = `inputs/${id}.expected.bin`;
    Object.assign(row, {
      expected: file,
      expectedSHA256: sha(expected),
      decodedBytes: expected.length,
      utf16Units: text.length,
    });
    expectedBytes = expected;
  }
  return { row, input: packet, expected: expectedBytes };
}

export function assertReply(row, input, expected, packet) {
  let copied = 0,
    replacements = 0;
  assert.equal(packet.length % 4, 0);
  assert.ok(packet.length >= 137 * 4);
  const words = Array.from({ length: packet.length / 4 }, (_, i) => packet.readUInt32LE(i * 4));
  assert.equal(words[0], 0x55384e50);
  assert.equal(words[1], row.mode);
  assert.equal(words[2], row.code, row.label);
  const cleanup = words[3],
    flags = words[4],
    decodedLength = words[7],
    originLength = words[8],
    d = words.slice(9, 137);
  assert.equal(words.length, 137 + decodedLength + originLength);
  const data = words.slice(137, 137 + decodedLength);
  assert.ok(data.every((x) => x <= 255));
  const decoded = Buffer.from(data),
    relations = words.slice(137 + decodedLength);
  assert.equal(flags & 12, 12, 'hello/IO checks');
  if (row.options.fault) assert.equal(flags & 16, 16, 'selected injected fault was reached');
  if (row.options.lifecycle === 1) {
    assert.equal(cleanup, 1);
    assert.equal(flags & 64, 64);
    assert.equal(flags & 32, 0);
    assert.equal(flags & 3, 3);
    assert.equal(
      words[6],
      0xffffffff,
      'allocation-after-FINISH not applicable after sticky failure',
    );
  } else if (row.options.lifecycle === 2) {
    assert.equal(cleanup, 2);
    assert.equal(flags & (128 | 256 | 32), 128 | 256 | 32);
    assert.equal(flags & 3, 0, 'freed inputs cannot claim post-decode immutability');
    assert.equal(words[5], 0);
    assert.equal(words[6], 0);
  } else {
    assert.equal(cleanup, 0);
    assert.equal(flags & (3 | 32), 3 | 32);
    assert.equal(flags & 64, 0);
    assert.equal(words[6], 0);
  }
  let relationCount = 0;
  if (row.mode === 0) {
    assert.equal(d[0], row.code);
    assert.equal(d[93], 0x55384431);
    assert.equal(d[94], 1);
    assert.equal(d[7], row.length);
    assert.ok(d[33] <= d[34]);
    assert.ok(d[36] <= d[37]);
    if (row.code) {
      assert.equal(decodedLength, 0);
      assert.equal(originLength, 0);
      for (const key of [2, 3, 32, 33, 34, 35, 36, 37, 95])
        assert.equal(d[key], 0, `failed public field${key}`);
    } else {
      assert.equal(sha(expected), row.expectedSHA256);
      assert.deepEqual(decoded, expected, row.label);
      assert.equal(d[2], decoded.length);
      assert.equal(d[3], row.utf16Units);
      assert.equal(d[95], 1);
      assert.equal(d[33], decodedLength);
      assert.equal(d[36], originLength);
      assert.equal(originLength % 7, 0);
      if (row.options.padding) assert.equal(d[6], row.options.padding + 1);
      const raw = Uint32Array.from({ length: row.rawWords }, (_, i) =>
        input.readUInt32LE((15 + i) * 4),
      );
      let rawAt = 0,
        decodedAt = 0,
        utf16At = 0,
        previousKind = 1;
      for (let at = 0; at < relations.length; at += 7) {
        const [ds, dl, rs, rl, us, ul, kind] = relations.slice(at, at + 7);
        assert.deepEqual([ds, rs, us], [decodedAt, rawAt, utf16At]);
        assert.ok(dl > 0 && rl > 0);
        assert.ok(dl <= decoded.length - ds);
        assert.ok(rl <= row.length - rs);
        const rawWords = raw.subarray(rs, rs + rl);
        assert.ok(rawWords.every((x) => x <= 255));
        const rawBytes = Buffer.from(rawWords),
          out = decoded.subarray(ds, ds + dl);
        assert.equal(out.toString('utf8').length, ul);
        if (kind === 0) {
          assert.notEqual(previousKind, 0, 'copy runs are maximal between replacements');
          assert.equal(dl, rl);
          assert.deepEqual(out, rawBytes);
          assert.deepEqual(
            Buffer.from(rawBytes.toString('utf8')),
            rawBytes,
            'copied run is valid UTF8',
          );
          copied++;
        } else {
          assert.equal(kind, 1);
          assert.deepEqual([dl, ul], [3, 1]);
          assert.ok(rl <= 3);
          assert.deepEqual(out, Buffer.from([239, 191, 189]));
          assert.equal(rawBytes.toString('utf8'), '�', 'one maximal-subpart replacement');
          assert.notDeepEqual(
            rawBytes,
            Buffer.from('�'),
            'valid literal replacement scalar must be copied',
          );
          replacements++;
        }
        rawAt += rl;
        decodedAt += dl;
        utf16At += ul;
        previousKind = kind;
        relationCount++;
      }
      assert.deepEqual([decodedAt, rawAt, utf16At], [decoded.length, row.length, row.utf16Units]);
      if (row.label === '131073 relation rows') assert.equal(relationCount, 131073);
    }
  } else if (row.mode === 1) {
    assert.equal(d[0], 3);
    assert.equal(decodedLength, 0);
    assert.equal(originLength, 0);
    assert.equal(d[row.options.slot + 1], row.options.forgedLength);
  } else {
    const unit = row.options.unit;
    assert.equal(d[0], row.code);
    assert.deepEqual(decoded, Buffer.from(unit.bytes));
    assert.equal(d[1], unit.consumed);
    assert.equal(d[2], unit.bytes.length);
    assert.equal(d[3], unit.units);
    assert.equal(d[15], unit.kind);
    assert.deepEqual(d.slice(48, 52), [...unit.bytes, ...Array(4 - unit.bytes.length).fill(0)]);
    assert.equal(originLength, 0);
  }
  return {
    outputSHA256: sha(packet),
    copiedRelations: copied,
    replacementRelations: replacements,
    relationRows: relationCount,
  };
}

export async function runCase(exe, dir, item, index) {
  const { row, input, expected } = prepareCase(item, index),
    id = String(index).padStart(4, '0');
  const requests = join(dir, basename(exe) + '-requests');
  await mkdir(requests, { recursive: true });
  const inputPath = join(requests, id + '.bin'),
    outputPath = join(requests, id + '.output.bin');
  await writeFile(inputPath, input);
  // External process timeout is a harness abort, never a decoder status/fallback.
  const run = spawnSync(exe, [inputPath, outputPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
  await writeFile(join(requests, id + '.stdout.log'), run.stdout ?? '');
  await writeFile(join(requests, id + '.stderr.log'), run.stderr ?? '');
  assert.equal(run.status, 0, `${row.label}: ${run.error ?? run.stderr?.toString()}`);
  assert.equal(run.signal, null);
  assert.equal(run.error, undefined);
  return assertReply(row, input, expected, await readFile(outputPath));
}
