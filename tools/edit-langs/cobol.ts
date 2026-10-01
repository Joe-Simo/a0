/**
 * COBOL (GnuCOBOL 3.2, free format): every function is a separately CALLed program; u32
 * values are PIC 9(10) COMP-5 fields (sums and products are reduced with FUNCTION MOD ... 2^32
 * and shifts and bit operations use B-SHIFT-L, B-SHIFT-R, B-AND, B-OR, B-XOR); booleans are
 * PIC 9 flags (1 or 0); u32x4 arrays are OCCURS 4 tables and the record result of bounds is
 * a group. The result is the last CALL parameter. Compiled with cobc -c, linked into the driver.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
import {
  arrayElem,
  BUILD_MS,
  failure,
  type LangCase,
  type LangSpec,
  RUN_MS,
  recordFields,
  signature,
  tool,
} from './spec.js';

const U32 = 'PIC 9(10) COMP-5';
const M32 = '4294967296';

type Param = 'u' | 'b' | 'arr' | 'rec';

/** One program: its name, parameters (name, kind), result kind, locals and procedure lines. */
function prog(
  name: string,
  params: readonly (readonly [string, Param])[],
  result: Param,
  locals: readonly string[],
  body: readonly string[],
): string {
  const decl = (n: string, k: Param): string[] => {
    if (k === 'arr') return [`01 ${n}.`, `   05 ${n}-E ${U32} OCCURS 4 TIMES.`];
    if (k === 'rec') return [`01 ${n}.`, `   05 ${n}-LO ${U32}.`, `   05 ${n}-HI ${U32}.`];
    return [`01 ${n} ${k === 'b' ? 'PIC 9' : U32}.`];
  };
  const linkage = [...params.flatMap(([n, k]) => decl(n, k)), ...decl('R', result)];
  const ws =
    locals.length > 0 ? ['WORKING-STORAGE SECTION.', ...locals.map((l) => `01 ${l}.`)] : [];
  return [
    `PROGRAM-ID. ${name}.`,
    'DATA DIVISION.',
    ...ws,
    'LINKAGE SECTION.',
    ...linkage,
    `PROCEDURE DIVISION USING ${[...params.map(([n]) => n), 'R'].join(' ')}.`,
    ...body.map((l) => `    ${l}`),
    '    GOBACK.',
    `END PROGRAM ${name}.`,
    '',
  ].join('\n');
}

const u = (n: string): string => `${n} ${U32}`;
const A: readonly [string, Param] = ['A', 'u'];
const B: readonly [string, Param] = ['B', 'u'];
const AR: readonly [string, Param] = ['A', 'arr'];

const loop = (to: number, step: string[]): string[] => [
  `PERFORM VARYING I FROM 0 BY 1 UNTIL I > ${to}`,
  ...step.map((l) => `    ${l}`),
  'END-PERFORM.',
];

const fits = (op: string): string =>
  prog('fits', [A, B], 'b', [], [`IF A ${op} B MOVE 1 TO R ELSE MOVE 0 TO R END-IF.`]);

const sumfrom = (to: number): string =>
  prog(
    'sumfrom',
    [['X', 'u']],
    'u',
    [u('S'), u('I')],
    ['MOVE X TO S.', ...loop(to, [`COMPUTE S = FUNCTION MOD(S + I, ${M32})`]), 'MOVE S TO R.'],
  );

const rot8 = (n: number): string =>
  prog(
    'rot8',
    [['X', 'u']],
    'u',
    [],
    [`COMPUTE R = ((X B-SHIFT-L 8) B-AND 4294967295) B-OR (X B-SHIFT-R ${n}).`],
  );

const onlyone = (cond: string): string =>
  prog(
    'onlyone',
    [
      ['A', 'b'],
      ['B', 'b'],
    ],
    'b',
    [],
    [`IF ${cond} MOVE 1 TO R ELSE MOVE 0 TO R END-IF.`],
  );

const avgfloor = (body: readonly string[], locals: readonly string[]): string =>
  prog('avgfloor', [A, B], 'u', locals, body);

const sumsq = (step: readonly string[], locals: readonly string[]): string =>
  prog(
    'sumsq',
    [AR],
    'u',
    [u('S'), u('I'), ...locals],
    ['MOVE 0 TO S.', ...loop(3, [...step]), 'MOVE S TO R.'],
  );

const inrange = (a: string, b: string): string =>
  prog(
    'inrange',
    [
      ['X', 'u'],
      ['LO', 'u'],
      ['HI', 'u'],
    ],
    'b',
    [],
    [`IF X ${a} LO AND X ${b} HI MOVE 1 TO R ELSE MOVE 0 TO R END-IF.`],
  );

const bounds = (cmp: string): string =>
  prog(
    'bounds',
    [AR],
    'rec',
    [u('LO'), u('HI'), u('X'), u('I')],
    [
      'MOVE 4294967295 TO LO.',
      'MOVE 0 TO HI.',
      ...loop(3, [
        'MOVE A-E(I + 1) TO X',
        'IF X < LO MOVE X TO LO END-IF',
        `IF X ${cmp} HI MOVE X TO HI END-IF`,
      ]),
      'MOVE LO TO R-LO.',
      'MOVE HI TO R-HI.',
    ],
  );

const checksum = (init: number, step: string): string =>
  prog(
    'checksum',
    [AR],
    'u',
    [u('H'), u('I')],
    [`MOVE ${init} TO H.`, ...loop(3, [step]), 'MOVE H TO R.'],
  );

const dot = prog(
  'dot',
  [AR, ['B', 'arr']],
  'u',
  [u('S'), u('I')],
  [
    'MOVE 0 TO S.',
    ...loop(3, [`COMPUTE S = FUNCTION MOD(S + A-E(I + 1) * B-E(I + 1), ${M32})`]),
    'MOVE S TO R.',
  ],
);

const norm2 = prog('norm2', [AR], 'u', [], ['CALL "dot" USING A A R.']);

const limit = prog(
  'limit',
  [
    ['X', 'u'],
    ['LO', 'u'],
    ['HI', 'u'],
  ],
  'u',
  [u('B')],
  [
    'IF X < LO MOVE LO TO B ELSE MOVE X TO B END-IF.',
    'IF B > HI MOVE HI TO R ELSE MOVE B TO R END-IF.',
  ],
);

const pctof = prog(
  'pctof',
  [
    ['PART', 'u'],
    ['WHOLE', 'u'],
  ],
  'u',
  [u('N'), u('Q'), u('C0'), u('C100')],
  [
    `COMPUTE N = FUNCTION MOD(PART * 100, ${M32}).`,
    'IF WHOLE = 0 MOVE 4294967295 TO Q ELSE DIVIDE N BY WHOLE GIVING Q END-IF.',
    'MOVE 0 TO C0.',
    'MOVE 100 TO C100.',
    'CALL "limit" USING Q C0 C100 R.',
  ],
);

const popcnt = prog(
  'popcnt',
  [['X', 'u']],
  'u',
  [u('S'), u('I'), u('T')],
  [
    'MOVE 0 TO S.',
    ...loop(31, ['COMPUTE T = (X B-SHIFT-R I) B-AND 1', `COMPUTE S = FUNCTION MOD(S + T, ${M32})`]),
    'MOVE S TO R.',
  ],
);

const hamming = prog(
  'hamming',
  [A, B],
  'u',
  [u('T')],
  ['COMPUTE T = A B-XOR B.', 'CALL "popcnt" USING T R.'],
);

const sumsqStep = (sq: boolean): string[] =>
  sq
    ? ['MOVE A-E(I + 1) TO X', `COMPUTE S = FUNCTION MOD(S + X * X, ${M32})`]
    : [`COMPUTE S = FUNCTION MOD(S + A-E(I + 1), ${M32})`];

const BODY: LangSpec['b'] = {
  'b-fits-inclusive': { source: fits('<'), reference: fits('<=') },
  'b-sumfrom-eight': { source: sumfrom(4), reference: sumfrom(7) },
  'b-rot8-constant': { source: rot8(23), reference: rot8(24) },
  'b-onlyone-xor': {
    source: onlyone('A = 1 OR B = 1'),
    reference: onlyone('A NOT = B'),
  },
  'b-avgfloor-nowrap': {
    source: avgfloor(
      [`COMPUTE T = FUNCTION MOD(A + B, ${M32}).`, 'COMPUTE R = T B-SHIFT-R 1.'],
      [u('T')],
    ),
    reference: avgfloor(
      [
        'COMPUTE T = A B-AND B.',
        'COMPUTE V = A B-XOR B.',
        'COMPUTE V = V B-SHIFT-R 1.',
        'COMPUTE R = T + V.',
      ],
      [u('T'), u('V')],
    ),
  },
  'b-sumsq-array': {
    source: sumsq(sumsqStep(false), []),
    reference: sumsq(sumsqStep(true), [u('X')]),
  },
  'b-inrange-inclusive': { source: inrange('>', '<'), reference: inrange('>=', '<=') },
  'b-bounds-largest': { source: bounds('<'), reference: bounds('>') },
  'b-checksum-poly': {
    source: checksum(0, 'COMPUTE H = H B-XOR A-E(I + 1)'),
    reference: checksum(7, `COMPUTE H = FUNCTION MOD(H * 31 + A-E(I + 1), ${M32})`),
  },
  'b-norm2-dot': { source: dot, reference: `${dot}${norm2}` },
  'b-pctof-limit': { source: limit, reference: `${limit}${pctof}` },
  'b-hamming-popcnt': { source: popcnt, reference: `${popcnt}${hamming}` },
};

function scalar(v: Value): string {
  return typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const ws: string[] = [];
  const proc: string[] = [];
  tests.forEach((t, i) => {
    const { params, result } = signature(typed, t.fn);
    const names = t.args.map((a, k) => {
      const n = `T${i}-A${k}`;
      const ty: Type | undefined = params[k];
      if (typeof a === 'object') {
        const items = a as readonly Value[];
        ws.push(`01 ${n}.`, `   05 ${n}-E ${U32} OCCURS ${items.length} TIMES.`);
        items.forEach((x, j) => {
          proc.push(`    MOVE ${scalar(x)} TO ${n}-E(${j + 1})`);
        });
      } else {
        ws.push(`01 ${n} ${ty === 'bool' ? 'PIC 9' : U32}.`);
        proc.push(`    MOVE ${scalar(a)} TO ${n}`);
      }
      return n;
    });
    const rn = `T${i}-R`;
    const fields = recordFields(result);
    if (arrayElem(result) !== undefined) throw new Error('array results are not supported');
    if (fields.length > 0)
      ws.push(`01 ${rn}.`, ...fields.map((_, j) => `   05 ${rn}-${j} ${U32}.`));
    else ws.push(`01 ${rn} ${result === 'bool' ? 'PIC 9' : U32}.`);
    proc.push(`    CALL "${t.fn}" USING ${[...names, rn].join(' ')}`);
    if (fields.length > 0) {
      proc.push(`    DISPLAY "R${i} [" NO ADVANCING`);
      fields.forEach((_, j) => {
        proc.push(`    MOVE ${rn}-${j} TO OUT`, '    DISPLAY FUNCTION TRIM(OUT) NO ADVANCING');
        if (j < fields.length - 1) proc.push('    DISPLAY "," NO ADVANCING');
      });
      proc.push('    DISPLAY "]"');
    } else if (result === 'bool') {
      proc.push(`    IF ${rn} = 1 DISPLAY "R${i} true" ELSE DISPLAY "R${i} false" END-IF`);
    } else {
      proc.push(`    MOVE ${rn} TO OUT`, `    DISPLAY "R${i} " FUNCTION TRIM(OUT)`);
    }
  });
  return [
    'IDENTIFICATION DIVISION.',
    'PROGRAM-ID. DRIVER.',
    'DATA DIVISION.',
    'WORKING-STORAGE SECTION.',
    '01 OUT PIC Z(9)9.',
    ...ws,
    'PROCEDURE DIVISION.',
    ...proc,
    '    DISPLAY "DONE".',
    '    STOP RUN.',
    '',
  ].join('\n');
}

export const COBOL: LangSpec = {
  semantics: `Integers are unsigned 32-bit values held in PIC 9(10) COMP-5 fields: reduce every sum or product with FUNCTION MOD(expr, 4294967296) in its own COMPUTE (keep B-AND, B-OR, B-XOR, B-SHIFT-L, B-SHIFT-R out of a MOD argument, and mask left shifts with B-AND 4294967295); comparisons are unsigned; booleans are PIC 9 flags (1 or 0); u32x4 is a 4-element OCCURS table (index from 1) and the record of bounds is a group with fields R-LO and R-HI. Division by zero gives 4294967295. Each function is a separate free-format PROGRAM-ID program (ending with END PROGRAM, no IDENTIFICATION DIVISION header) called as CALL "name" USING arguments... result; the result is the last parameter, named R. The file is lib.cob and must build with cobc -c -free -fstatic-call lib.cob.`,
  head: /^PROGRAM-ID\. ([a-z][a-z0-9]*)\.$/,
  file: (body) => body,
  b: BODY,
  driver,
  compileLabel: 'cobc',
  async buildAndRun(dir, source, drv) {
    const cobc = tool('cobc', 'A0_COBC', ['/opt/homebrew/bin/cobc']);
    await writeFile(join(dir, 'lib.cob'), source, 'utf8');
    await writeFile(join(dir, 'driver.cob'), drv, 'utf8');
    const lib = runTool(cobc, ['-c', '-free', '-w', '-O0', '-fstatic-call', 'lib.cob'], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!lib.ok) return failure('cobc', lib);
    const link = runTool(
      cobc,
      ['-x', '-free', '-w', '-O0', '-fstatic-call', '-o', 'prog', 'driver.cob', 'lib.o'],
      { cwd: dir, timeoutMs: BUILD_MS },
    );
    if (!link.ok) return failure('cobc', link);
    const run = runTool(join(dir, 'prog'), [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
