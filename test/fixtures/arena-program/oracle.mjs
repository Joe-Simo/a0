import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { formatProgram, formatType, parse, validate } from '../../../dist/src/core.js';
import { runTool } from '../../../dist/src/toolchain.js';
import { CORPUS_SEED, generateCorpus } from '../../../dist/tools/corpus.js';
import { ILL_TYPED } from '../../../dist/tools/ref-check.js';

const root = process.argv[2];
assert.ok(root);
const offsets = [
  32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 68, 71, 74, 97, 100, 103, 106, 115, 118, 121, 124,
];
const ops = [
  '',
  'mov',
  'add',
  'sub',
  'mul',
  'and',
  'or',
  'xor',
  'shl',
  'shr',
  'div',
  'rem',
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'select',
  'call',
  'fold',
  'loop',
  'arr',
  'rec',
  'text',
  'get',
  'set',
  'at',
  'put',
  'read',
  'write',
  'puts',
  'cadd',
  'csub',
  'cmul',
  'cdiv',
  'crem',
  'cget',
];
function decode(b, source) {
  let i = 0;
  const word = () => {
    assert.ok(i + 4 <= b.length);
    const v = b.readUInt32LE(i);
    i += 4;
    return v;
  };
  const status = word(),
    state = Array.from({ length: 128 }, word),
    tables = new Map();
  for (const off of offsets) {
    const n = word();
    tables.set(off, Array.from({ length: n }, word));
  }
  const ns = word();
  const symbols = Array.from({ length: ns }, () =>
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      Uint8Array.from(Array.from({ length: word() }, word)),
    ),
  );
  assert.equal(i, b.length);
  const raw = new TextEncoder().encode(source),
    span = (a, n) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw.subarray(a, a + n));
  const table = (o) => tables.get(o);
  const row = (o, width, index) => table(o).slice(width * index, width * (index + 1));
  const typeCache = new Map();
  const type = (id) => {
    const cached = typeCache.get(id);
    if (cached) return cached;
    const r = row(68, 5, id);
    let t;
    if (r[0] === 0) t = 'u32';
    else if (r[0] === 1) t = 'bool';
    else if (r[0] === 2) t = 'io';
    else if (r[0] === 3) t = { kind: 'arr', elem: type(r[1]), length: r[2] };
    else {
      assert.equal(r[0], 4);
      t = {
        kind: 'rec',
        fields: table(71)
          .slice(r[1], r[1] + r[2])
          .map(type),
      };
    }
    typeCache.set(id, t);
    return t;
  };
  const operand = (id) => {
    const r = row(47, 5, id);
    if (r[0] === 0) return { kind: 'node', id: symbols[r[1]] };
    if (r[0] === 1)
      return { kind: 'param', index: r[4] & 4 ? Number(span(r[2], r[3]).slice(1)) : r[1] };
    if (r[0] === 2) return { kind: 'u32', value: r[1] };
    assert.equal(r[0], 3);
    return { kind: 'bool', value: r[1] !== 0 };
  };
  const comment = (id) => {
    const r = row(38, 3, id);
    return span(r[0], r[1]);
  };
  const comments = (lineID) => {
    const l = row(32, 10, lineID);
    const leading = Array.from({ length: l[9] }, (_, j) => comment(l[8] + j));
    const trailing = l[7] === 4294967295 ? undefined : comment(l[7]);
    return leading.length || trailing !== undefined
      ? { ...(leading.length ? { leading } : {}), ...(trailing === undefined ? {} : { trailing }) }
      : undefined;
  };
  const node = (id) => {
    const r = row(44, 14, id);
    const c = r[11] & 1 ? undefined : comments(r[6]);
    return {
      id: symbols[r[0]],
      op: ops[r[1]],
      args: Array.from({ length: r[3] }, (_, j) => operand(r[2] + j)),
      ...(r[4] === 4294967295 ? {} : { callee: symbols[r[4]] }),
      ...(r[5] === 4294967295 ? {} : { pred: symbols[r[5]] }),
      ...(r[11] & 2
        ? {
            text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(
              Uint8Array.from(Array.from({ length: r[3] }, (_, j) => operand(r[2] + j).value)),
            ),
          }
        : {}),
      ...(c === undefined ? {} : { comments: c }),
    };
  };
  const functions = Array.from({ length: table(41).length / 14 }, (_, id) => {
    const r = row(41, 14, id),
      c = comments(r[7]),
      rc = comments(r[8]),
      ec = comments(r[9]);
    return {
      name: symbols[r[0]],
      params: table(50)
        .slice(r[1], r[1] + r[2])
        .map(type),
      result: type(r[3]),
      nodes: Array.from({ length: r[5] }, (_, j) => node(r[4] + j)),
      ret: operand(r[6]),
      ...(c === undefined ? {} : { comments: c }),
      ...(rc === undefined ? {} : { retComments: rc }),
      ...(ec === undefined ? {} : { endComments: ec }),
    };
  });
  const tail = Array.from({ length: state[26] }, (_, j) => comment(state[25] + j));
  if (functions.length && tail.length) Object.assign(functions.at(-1), { afterComments: tail });
  const uses = Array.from({ length: table(53).length / 3 }, (_, id) => {
    const r = row(53, 3, id);
    return span(r[0], r[1]);
  });
  const uc = Array.from({ length: uses.length }, (_, id) => comments(row(53, 3, id)[2]));
  const pc = state[24] === 4294967295 ? undefined : comments(state[24]);
  const program = {
    functions,
    uses,
    ...(state[8] ? { profile: 'strict' } : {}),
    ...(pc === undefined ? {} : { profileComments: pc }),
    ...(uc.some((c) => c !== undefined) ? { useComments: uc } : {}),
    ...(!functions.length && tail.length ? { tailComments: tail } : {}),
  };
  return { status, state, tables, symbols, program, type };
}
const simple = (
  body,
  result = 'u32',
  params = 'u32',
) => `fn f${params ? ` ${params}` : ''} -> ${result}
${body}
end
`;
const prelude = `fn body u32 u32 u32 -> u32
x add p0 p1
y add x p2
ret y
end
fn pred u32 u32 u32 -> bool
x lt p0 p2
ret x
end
`;
const cases = [
  '',
  `# comment only
`,
  simple(`x add p0 1
ret x`),
  simple('ret 4294967295', 'u32', ''),
  simple(
    `a mov true
b and a false
c eq b a
ret c`,
    'bool',
    '',
  ),
  simple(`a rec p0 false
b at a 0
c put a 1 true
d at c 0
ret d`),
  simple(`a arr p0 2 3
b get a 99
c set a 0 b
ret get c 1`),
  simple(`a cadd p0 1
b csub p0 2
c cmul p0 3
d cdiv p0 4
e crem p0 5
f arr 1 2
g cget f p0
h at g 0
ret h`),
  simple(
    `a read p0
b at a 0
c at a 1
d write c b
ret d`,
    'io',
    'io',
  ),
  simple(
    `a read p0
b at a 1
c put a 1 b
ret c`,
    '(u32,io)',
    'io',
  ),
  simple(
    `a arr 65 66
b puts p0 a
ret b`,
    'io',
    'io',
  ),
  prelude +
    simple(`a call body p0 0 2
b fold body 3 a 4
c loop pred body 5 b 6
ret c`),
  `profile strict
` +
    simple(`a div p0 0
b cdiv a 0
ret at b 0`),
  simple(`a mov p4294967296
ret a`),
  simple(`a mov z
ret a`),
  simple(`a mov b
b mov p0
ret b`),
  simple(`a add true p0
ret a`),
  simple(`a and p0 true
ret a`),
  simple(`a eq true 1
ret a`),
  simple(`a select p0 1 2
ret a`),
  simple(`a select true 1 false
ret a`),
  simple(`a arr 1 false
ret a`),
  simple(
    `a arr p0
ret a`,
    'io',
    'io',
  ),
  simple(
    `a rec p0 p0
ret a`,
    '(io,io)',
    'io',
  ),
  simple(
    `a mov 0
ret a`,
    'u32',
    'io io',
  ),
  simple(
    `a mov p0
b write p0 0
ret b`,
    'io',
    'io',
  ),
  simple(
    `a read p0
b at a 1
c at a 1
ret c`,
    'io',
    'io',
  ),
  simple(
    `a read p0
b at a 1
c mov a
ret c`,
    '(u32,io)',
    'io',
  ),
  simple(
    `a read p0
b at a 1
ret a`,
    '(u32,io)',
    'io',
  ),
  simple(
    `a write p0 0
ret p0`,
    'io',
    'io',
  ),
  simple(
    `a read p0
b at a 1
c at a 0
d write b c
ret d`,
    'io',
    'io',
  ),
  simple(`a at p0 0
ret a`),
  simple(`a rec p0 true
b at a p0
ret b`),
  simple(`a rec p0 true
b at a 2
ret b`),
  simple(`a rec p0 true
b put a 1 2
ret p0`),
  simple(`a get p0 0
ret a`),
  simple(`a set p0 0 1
ret a`),
  simple(`a cget p0 0
ret a`),
  simple(`a call missing p0
ret a`),
  prelude +
    simple(`a call body p0 0
ret a`),
  prelude +
    simple(`a call body p0 false 1
ret a`),
  prelude +
    simple(`a fold missing 2 p0
ret a`),
  prelude +
    simple(`a fold body true p0 2
ret a`),
  `fn b u32 -> u32
ret p0
end
` +
    simple(`a fold b 2 p0
ret a`),
  `fn b u32 bool -> u32
ret p0
end
` +
    simple(`a fold b 2 p0
ret a`),
  prelude +
    simple(`a fold body 2 false 1
ret a`),
  prelude +
    simple(`a fold body 2 p0
ret a`),
  prelude +
    simple(`a fold body 2 p0 false
ret a`),
  prelude +
    simple(`a loop missing body 2 p0 1
ret a`),
  prelude +
    simple(`a loop body body 2 p0 1
ret a`),
  `fn p u32 u32 -> bool
ret true
end
` +
    prelude +
    simple(`a loop p body 2 p0 1
ret a`),
  prelude +
    simple(`a fold body 16777217 p0 1
ret a`),
  prelude +
    `fn nested u32 u32 u32 -> u32
x fold body 4096 p0 p2
ret x
end
` +
    simple(`a fold nested 4097 p0 1
ret a`),
  simple(`a mov p0
a mov 0
ret a`),
  simple('ret false'),
  `fn f -> u32
ex -> 1
ret 1
end
`,
];
for (const op of [
  'add',
  'sub',
  'mul',
  'shl',
  'shr',
  'div',
  'rem',
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'and',
  'or',
  'xor',
])
  for (const ty of ['u32', 'bool'])
    cases.push(
      simple(
        `a ${op} p0 p0
ret a`,
        ['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(op) ? 'bool' : ty,
        ty,
      ),
    );
const nestedVariable =
  `fn iter0 u32 u32 -> u32
ret p0
end
` +
  Array.from(
    { length: 32 },
    (_, i) => `fn iter${i + 1} u32 u32 -> u32
x fold iter${i} p1 p0
ret x
end
`,
  ).join('') +
  `fn zero u32 u32 -> u32
x fold iter32 0 p0
ret x
end
`;
cases.push(
  nestedVariable,
  simple(
    `a text "hi\\n#"
ret get a 0`,
    'u32',
    '',
  ),
  simple(
    `a text ""
ret get a 0`,
    'u32',
    '',
  ),
  simple(`a add true p0
ret a`) +
    `fn later -> u32
ret 4294967296
end
`,
  `fn f -> u32
ex -> 1
ret 1
end
fn later -> u32
ret 4294967296
end
`,
  simple(
    `a read p0
b at a 1
c put a 1 b
d mov c
e at d 0
f at d 1
g write f e
ret g`,
    'io',
    'io',
  ),
);
cases.push(
  ...ILL_TYPED.map((x) => x[1]),
  formatProgram(generateCorpus(CORPUS_SEED)),
  await readFile('examples/kernels.a0', 'utf8'),
  await readFile('examples/life.a0', 'utf8'),
);
const capacity = process.argv[3] === 'capacity';
const sources = capacity
  ? [
      `fn f u32 -> u32
` +
        Array.from(
          { length: 4096 },
          (_, i) => `n${i} add p0 ${i}
`,
        ).join('') +
        `ret add n4095 1
end
`,
      simple('ret p0', 'u32x65536', 'u32x65536'),
      `fn f u32 -> u32
` +
        Array.from(
          { length: 4096 },
          (_, i) => `n${i} add p0 ${i}
`,
        ).join('') +
        `ret n4095
end
`,
      ...[8193, 65536, 70017].map((n) =>
        simple(
          `a arr ${Array(n).fill('false').join(' ')}
ret true`,
          'bool',
          '',
        ),
      ),
      simple(
        `a rec ${Array(70017).fill('false').join(' ')}
ret true`,
        'bool',
        '',
      ),
      Array.from(
        { length: 10001 },
        (_, i) => `fn f${i} -> u32
ret ${i}
end
`,
      ).join(''),
    ]
  : cases;
const modes = capacity ? ['-O2'] : ['-O0', '-O2'];
const report = [];
for (const mode of modes) {
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    await writeFile(`${root}/source.bin`, source);
    const r = runTool(
      `${root}/driver${mode}`,
      [`${root}/source.bin`, `${root}/output.bin`, '50000000'],
      { cwd: root, timeoutMs: 30000 },
    );
    assert.ok(r.ok, `${mode} case${index}: ${r.stderr}`);
    let expected, error;
    let phase = 'parse';
    try {
      const parsed = parse(source);
      phase = 'check';
      expected = validate(parsed);
    } catch (e) {
      error = e;
    }
    const got = decode(await readFile(`${root}/output.bin`), source);
    if (
      source.includes(`
ex `) &&
      phase === 'check'
    ) {
      assert.equal(got.status, 7);
    } else if (error) {
      assert.ok(
        got.status === 6 || got.status === 8,
        `${mode} case${index}: status${got.status} expected${error.id}
${source}`,
      );
      assert.equal(
        got.state[1],
        Number(error.id.slice(1)),
        `${mode} case${index}: status${got.status}
${source}`,
      );
      let expectedLine = error.line;
      if (expectedLine === undefined) {
        const m = /^([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?(?=[:. ]|$)/.exec(error.message);
        if (m) {
          const lines = source.split(/\r?\n/);
          let li = lines.findIndex((l) => new RegExp(`^\\s*fn\\s+${m[1]}\\b`).test(l));
          if (li >= 0 && m[2]) {
            const ni = lines.findIndex((l, i) => i > li && new RegExp(`^\\s*${m[2]}\\s`).test(l));
            if (ni >= 0) {
              li = ni;
              if (error.id === 'A0303') {
                const duplicate = lines.findIndex(
                  (l, i) => i > ni && new RegExp(`^\\s*${m[2]}\\s`).test(l),
                );
                if (duplicate >= 0) li = duplicate;
              }
            }
          }
          if (li >= 0) expectedLine = li + 1;
        }
      }
      if (expectedLine !== undefined)
        assert.equal(
          got.state[2],
          expectedLine,
          `${mode} case${index} diagnostic line ${error.id}`,
        );
      if (error.expected !== undefined && error.actual !== undefined && got.status === 8) {
        assert.equal(
          formatType(got.type(got.state[112])),
          error.expected,
          `${mode} case${index} expected type`,
        );
        assert.equal(
          formatType(got.type(got.state[113])),
          error.actual,
          `${mode} case${index} actual type`,
        );
      }
    } else {
      assert.equal(
        got.status,
        0,
        `${mode} case${index} id${got.state[1]}
${source}`,
      );
      assert.deepEqual(got.program, parse(source));
      let nodeIndex = 0;
      for (const [fi, fn] of expected.functions.entries()) {
        assert.equal(got.tables.get(103)[fi * 3], fn.literalIterations);
        const bits = Buffer.alloc(8);
        bits.writeUInt32LE(got.tables.get(103)[fi * 3 + 1], 0);
        bits.writeUInt32LE(got.tables.get(103)[fi * 3 + 2], 4);
        assert.equal(
          bits.readDoubleLE(),
          fn.staticIterations,
          `${mode} case${index} ${fn.name} staticIterations`,
        );
        for (const node of fn.nodes) {
          const typeID = got.tables.get(97)[nodeIndex++];
          assert.equal(
            formatType(got.type(typeID)),
            formatType(fn.types.get(node.id)),
            `${mode} case${index} ${fn.name}.${node.id}`,
          );
        }
      }
      assert.equal(got.state[8], source.startsWith('profile strict') ? 1 : 0);
    }
    report.push({
      mode,
      index,
      route: 'original-source arena_parse_check',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      bytes: Buffer.byteLength(source),
      arenaStatus: got.status,
      profile: got.state[8],
      functionRecords: got.tables.get(41).length / 14,
      nodeRecords: got.tables.get(44).length / 14,
      operandRecords: got.tables.get(47).length / 5,
      typeRecords: got.tables.get(68).length / 5,
      symbols: got.symbols.length,
      ...(got.status === 6 || got.status === 8
        ? {
            diagnostic: {
              id: `A${String(got.state[1]).padStart(4, '0')}`,
              line: got.state[2],
              byteStart: got.state[3],
              byteLength: got.state[4],
              checkerContext: got.status === 8 ? got.state.slice(109, 115) : null,
            },
          }
        : {}),
      status: 'passed',
      outcome:
        source.includes(`
ex `) && phase === 'check'
          ? 'explicit incomplete specs'
          : error
            ? `diagnostic ${error.id}`
            : 'checked types and literal iteration bounds',
    });
  }
  console.log(`${mode}: ${sources.length} cases passed`);
}
await writeFile(
  `${root}/${capacity ? 'capacity' : 'small'}-results.json`,
  JSON.stringify(
    {
      note: 'Private actual A0 C emission; TS link is development bootstrap and TS parse/validate independent oracle only. No TS semantic fallback. Strict profile preserved. IEEE754 staticIterations metadata matches oracle; full diagnostic payload remains unimplemented.',
      report,
    },
    null,
    2,
  ) +
    `
`,
);
