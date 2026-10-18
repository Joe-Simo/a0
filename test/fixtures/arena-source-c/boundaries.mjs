import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { scalarMain, target } from './target.mjs';
import { compileSource, ROOT } from './transport.mjs';

const report = {
  status: 'running',
  scope:
    'Raw-source native arena C across legacy table ceilings and explicit terminal failures; actual O0/O2 UBSan C execution.',
  rows: [],
};
const small = 'fn probe u32 -> u32\nx add p0 1\nret x\nend\n';
try {
  // Legal per-function signatures remain below the 64-parameter language limit;
  // their combined type-list exceeds the old 8320-word fixed page.
  const params = Array(12).fill('u32').join(' '),
    functions = Array.from(
      { length: 821 },
      (_, i) => `fn f${i} ${params} -> u32\nret p11\nend\n`,
    ).join(''),
    many = compileSource(functions);
  assert.equal(many.counts[0], 821);
  target(
    many,
    scalarMain([
      { functionName: 'f820', args: [...Array(11).fill(7), 0xffffffff], expected: 0xffffffff },
    ]),
  );
  report.rows.push({
    name: '821 functions and 9852 signature parameters',
    counts: many.counts,
    status: 'passed',
  });

  const chain = Array.from({ length: 3 }, (_, fn) => {
    const call = fn ? `start call f${fn - 1} p0\n` : '',
      body = Array.from(
        { length: 1000 },
        (_, i) => `n${i} add ${i ? `n${i - 1}` : fn ? 'start' : 'p0'} 1\n`,
      ).join('');
    return `fn f${fn} u32 -> u32\n${call}${body}ret n999\nend\n`;
  }).join('');
  const nodes = compileSource(chain);
  assert.equal(nodes.counts[2], 3003, 'dummy plus global nodes retain full IDs');
  target(
    nodes,
    scalarMain(
      [0, 7, 0xffffffff].map((n) => ({
        functionName: 'f2',
        args: [n],
        expected: (n + 3000) >>> 0,
      })),
    ),
  );
  report.rows.push({
    name: 'global nodes beyond 2730 with forward return/call identity',
    counts: nodes.counts,
    cases: 3,
    status: 'passed',
  });

  for (const [name, source, options, code] of [
    ['imports terminal 7', 'use "dependency.a0"\n', {}, 7],
    ['unsupported flags', small, { flags: 1 }, 12],
    [
      'strict unsafe ordinary read',
      'profile strict\nfn probe io -> (u32,io)\nr read p0\nret r\nend\n',
      {},
      9,
    ],
    ['allocation budget', small, { maxWords: Buffer.byteLength(small) }, 4],
    ['zero output budget', small, { maxOutput: 0 }, 4],
    ['partial output budget', small, { maxOutput: 128 }, 4],
    ['malformed load frame', small, { fault: { op: 2, nth: 1, kind: 2 } }, 1],
    ['load status', small, { fault: { op: 2, nth: 1, status: 5, kind: 1 } }, 5],
    ['allocation status', small, { fault: { op: 1, nth: 1, status: 4, kind: 1 } }, 4],
    ['whole parse before flags', 'fn bad ->u32\nx add\nret x\nend\n', { flags: 1 }, 6],
    [
      'body verification before flags',
      'fn bad u32 -> u32\nx add true p0\nret x\nend\n',
      { flags: 1 },
      8,
    ],
    [
      'spec verification before flags',
      'fn probe u32 -> u32\nex 7 ->8\nret p0\nend\n',
      { flags: 1 },
      8,
    ],
  ]) {
    const r = compileSource(source, options);
    assert.equal(r.code, code, name);
    if (name === 'zero output budget') {
      assert.equal(r.e[0], 0, 'publication failure does not invent a compile error');
      assert.equal(r.bytes.length, 0);
    } else if (name === 'partial output budget') {
      assert.equal(r.e[0], 0);
      assert.equal(
        r.bytes.length,
        128,
        'partial transport prefix is uncommitted after publication failure',
      );
      assert.ok(r.bytes.length < r.result[1]);
    } else assert.equal(r.bytes.length, 0, 'failed compilation never publishes bytes');
    report.rows.push({
      name,
      code,
      compileStatus: r.e[0],
      publishedBytes: r.bytes.length,
      status: 'passed',
    });
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
}
await writeFile(`${ROOT}/results.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({ status: report.status, rows: report.rows.length, error: report.error }, null, 2),
);
process.exitCode = report.status === 'passed' ? 0 : 1;
