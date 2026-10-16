// Test fixtures/oracles only; no native decoder semantics are implemented here.
export function makeCases() {
  const rows = [],
    add = (label, raw, options = {}) => rows.push({ label, raw: Uint32Array.from(raw), options });
  for (const bytes of [
    [],
    [0],
    [255],
    [0xc2],
    [0xe0, 0xa0],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x8f, 0xbf],
    [0xf4, 0x90, 0x80],
  ])
    add('base ' + rows.length, bytes);
  for (const text of ['ASCII\0\r\n', '\ufeffA', 'é中😀', 'a\u007fb\u0080c\uffffd𐀀'])
    add('text ' + rows.length, Buffer.from(text));
  for (let at = 124; at <= 130; at++)
    for (const tail of [
      [0xc2, 0xa0],
      [0xe0, 0xa0, 0x80],
      [0xf0, 0x90, 0x80, 0x80],
      [0xe1, 0x80, 65],
      [0xf1, 0x80, 0x80],
      [255],
    ]) {
      add('crossing ' + rows.length, [...Array(at).fill(65), ...tail, 66]);
      add('EOF crossing ' + rows.length, [...Array(at).fill(65), ...tail]);
    }
  let state = 0x73a905b1;
  function word() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  }
  for (let i = 0; i < 500; i++)
    add(
      'random ' + i,
      Uint32Array.from({ length: word() % 257 }, () => word() & 255),
    );
  add('high handle65537', [65], { padding: 65536 });
  add('bad handle', [65], { badHandle: 1, code: 2 });
  add('source range', [65], { length: 2, code: 3 });
  add('no growth', [65], { noGrowth: true, code: 4 });
  for (const raw of [[256], [0xc2, 256], [65, 0xffffffff], [...Array(127).fill(65), 256]])
    add('nonbyte ' + rows.length, raw, { code: 6 });
  for (const size of [16384, 65537, 131073]) add('ASCII ' + size, new Uint32Array(size).fill(65));
  add('ASCII 2MiB+1', new Uint32Array(2097153).fill(65));
  add('70017 invalid bytes', new Uint32Array(70017).fill(128));
  const chunks = [];
  let batch = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    batch.push(cp);
    if (batch.length === 1024) {
      chunks.push(Buffer.from(String.fromCodePoint(...batch)));
      batch = [];
    }
  }
  if (batch.length) chunks.push(Buffer.from(String.fromCodePoint(...batch)));
  add('all1112064 valid scalars', Buffer.concat(chunks));
  if (rows.length !== 610) throw Error('development corpus drift');
  add('literal replacement is copied', Buffer.from('�A😀Zé'));
  add(
    '131073 relation rows',
    Uint32Array.from({ length: 131073 }, (_, i) => (i % 2 ? 128 : 65)),
  );
  const pairs = new Uint32Array(65536 * 3);
  for (let a = 0; a < 256; a++)
    for (let b = 0; b < 256; b++) {
      const at = (a * 256 + b) * 3;
      pairs[at] = a;
      pairs[at + 1] = b;
      pairs[at + 2] = 0;
    }
  add('all65536 two-byte inputs with ASCII separators', pairs);
  add('ignored nonbyte tail', [65, 256], { length: 1 });
  add('empty no handle validation', [256], { length: 0, badHandle: 1 });
  add('nonbyte after replacement', [128, 65, 0xffffffff], { code: 6 });
  for (const code of [1, 2, 3, 4, 5])
    add('synthetic LOAD status ' + code, [65], {
      code,
      fault: { op: 2, nth: 1, status: code, kind: 1 },
    });
  add('malformed LOAD count', [65], { code: 1, fault: { op: 2, nth: 1, kind: 2 } });
  add('crossing LOAD failure', new Uint32Array(140).fill(65), {
    code: 3,
    fault: { op: 2, nth: 2, status: 3, kind: 1 },
  });
  add('copy reload failure', [65], { code: 2, fault: { op: 2, nth: 2, status: 2, kind: 1 } });
  add('decoded append ALLOC failure', [128], {
    code: 4,
    fault: { op: 1, nth: 1, status: 4, kind: 1 },
  });
  add('origin append ALLOC failure', [128], {
    code: 4,
    fault: { op: 1, nth: 2, status: 4, kind: 1 },
  });
  add('real origin allocation budget', [65], { extraBudget: 1, code: 4 });
  add('real sticky runtime protocol', [65], { lifecycle: 1, code: 1 });
  add('real already finished runtime', [65], { lifecycle: 2, code: 5 });
  for (const [slot, len, n] of [
    [32, 0xffffffff, 1],
    [32, 0xfffffffd, 3],
    [35, 0xfffffff9, 7],
    [35, 0xffffffff, 7],
  ])
    add('append growth overflow ' + slot + '/' + len, [], {
      mode: 1,
      slot,
      forgedLength: len,
      appendCount: n,
      code: 3,
    });
  for (const [raw, available, expected] of [
    [[65, 0, 0, 0], 1, { bytes: [65], consumed: 1, units: 1, kind: 0 }],
    [[0xc2, 0xa0, 0, 0], 2, { bytes: [0xc2, 0xa0], consumed: 2, units: 1, kind: 0 }],
    [
      [0xf4, 0x8f, 0xbf, 0xbf],
      4,
      { bytes: [0xf4, 0x8f, 0xbf, 0xbf], consumed: 4, units: 2, kind: 0 },
    ],
    [[0xe1, 0x80, 65, 0], 3, { bytes: [239, 191, 189], consumed: 2, units: 1, kind: 1 }],
    [[0xf1, 0x80, 0x80, 0], 3, { bytes: [239, 191, 189], consumed: 3, units: 1, kind: 1 }],
    [[65, 256, 0, 0], 2, { bytes: [65], consumed: 1, units: 1, kind: 0 }],
    [[0xffffffff, 0, 0, 0], 0, { bytes: [], consumed: 0, units: 0, kind: 0 }],
  ])
    add('pure unit ' + rows.length, raw, { mode: 2, length: available, unit: expected });
  for (const [raw, n] of [
    [[256, 0, 0, 0], 1],
    [[0xc2, 256, 0, 0], 2],
    [[0xe0, 0xa0, 0xffffffff, 0], 3],
    [[0xf0, 0x90, 0x80, 256], 4],
    [[0, 0, 0, 0], 5],
  ])
    add('pure unit invalid ' + rows.length, raw, {
      mode: 2,
      length: n,
      code: 6,
      unit: { bytes: [], consumed: 0, units: 0, kind: 0 },
    });
  return rows;
}
