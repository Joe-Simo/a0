/**
 * The source set the self-hosted front end is verified on (lexio, parseio and checkio in
 * tools/app.ts, the native checker in tools/native-check.ts): small programs, error cases, the
 * most functions one source holds, and whole A0 files within the front end's source limit.
 */

import { readdir, readFile } from 'node:fs/promises';
import { FRONT_END_CAPACITY, FRONT_END_SOURCE_LIMIT } from './ref-parse.js';

/**
 * Whole A0 files within the front end's source limit: the examples, the lexer's own
 * source, and the site's UI program (text literals, non-ASCII bytes in strings).
 */
export async function wholeFiles(): Promise<[string, string][]> {
  const files: [string, string][] = [];
  for (const f of (await readdir('examples')).filter((f) => f.endsWith('.a0')).sort())
    files.push([f, await readFile(`examples/${f}`, 'utf8')]);
  files.push(['lex.a0', await readFile('compiler/lex.a0', 'utf8')]);
  files.push(['ui.a0', await readFile('site/ui.a0', 'utf8')]);
  for (const [label, src] of files)
    if (Buffer.byteLength(src) > FRONT_END_SOURCE_LIMIT)
      throw new Error(`${label}: over the front end's ${FRONT_END_SOURCE_LIMIT}-byte source limit`);
  return files;
}

/** Sources the parser and the checker share: small programs, error cases, and whole A0 files. */
export async function frontEndSources(): Promise<[string, string][]> {
  const sources: [string, string][] = [
    ['sq', 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n'],
    ['retop', 'fn f u32 u32 -> u32\nret add p0 p1\nend\n'],
    ['text', 'fn f -> u32x3\nt text "a\\"b\\\\c"\nret t\nend\n'],
    [
      'types',
      'use "lex.a0"\n# comment\nfn f u32x4 (u32,bool) io -> (u32,io)  # trailing\n\tx  mov 4294967295\r\nr read p2\nret r\nend\nfn g ((u32,bool),u32x4) -> (u32,bool)\nv at p0 0\nret v\nend\n',
    ],
    [
      'calls',
      'fn step u32 u32 -> u32\nret add p0 p1\nend\nfn go u32 -> bool\nc lt p0 10\nret c\nend\nfn body u32 u32 u32 -> u32\nret call step p0 p2\nend\nfn pred u32 u32 u32 -> bool\nret call go p0\nend\nfn top u32 -> u32\na fold step 4 0\nb loop pred body 100 a p0\nz select true a b\nret z\nend\n',
    ],
    ['unknown-callee', 'fn f u32 -> u32\na call g p0\nret a\nend\n'],
    ['later-node', 'fn f u32 -> u32\na add b 1\nb mov p0\nret a\nend\n'],
    ['bad-op', 'fn f u32 -> u32\na plus p0 1\nret a\nend\n'],
    ['unterminated', 'fn f u32 -> u32\na add p0 1\n'],
  ];
  return [...sources, manyFunctions(), ...(await wholeFiles())];
}

/**
 * The most one-line functions the front end's function table holds (820; src/core.ts allows
 * 65536): names a..z, then two characters, skipping `fn`.
 */
function manyFunctions(): [string, string] {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const names = [...letters];
  for (const x of letters) for (const y of `${letters}0123456789`) names.push(x + y);
  const n = FRONT_END_CAPACITY.functions;
  const src = names
    .filter((m) => m !== 'fn')
    .slice(0, n)
    .map((name) => `fn ${name} -> u32\nret 0\nend\n`)
    .join('');
  return [`fns${n}`, src];
}

const SQUARE = 'fn square u32 -> u32\na mul p0 p0\nret a\nend\n';

/**
 * Programs the TypeScript checker rejects because a name is unknown, with the row of the
 * diagnostics table (src/diagnostics.ts) it names. The self-hosted spelling suggestions
 * (compiler/suggest.a0) are verified on the token the parser rejects in each, and on every token.
 */
export const UNKNOWN_NAMES: readonly (readonly [string, string])[] = [
  ['A0102', 'fn f u32 -> u32\na mull p0 2\nret a\nend\n'],
  ['A0102', `${SQUARE}fn f u32 -> u32\nb call squar p0\nret b\nend\n`],
  ['A0102', `${SQUARE}fn f u32 -> u32\nb squar p0\nret b\nend\n`],
  ['A0102', `${SQUARE}fn f u32 -> u32\nret squar p0\nend\n`],
  ['A0102', 'fn f u32 -> u32\na call g p0\nret a\nend\nfn g u32 -> u32\nb add p0 1\nret b\nend\n'],
  ['A0102', 'fn f u32 -> u32\na frobnicate p0\nret a\nend\n'],
  ['A0101', 'fn f u32 -> u32\naccum add p0 1\nb add acum 1\nret b\nend\n'],
  ['A0101', 'fn f u32 -> u32\na add b 1\nb add p0 1\nret a\nend\n'],
  ['A0101', 'fn f u32 -> u32\na add p0 1\nret aa\nend\n'],
  [
    'A0103',
    'fn step u32 u32 -> u32\nr add p0 p1\nret r\nend\nfn f -> u32\na fold stepp 4 0\nret a\nend\n',
  ],
  [
    'A0104',
    'fn below u32 u32 -> bool\nb lt p0 5\nret b\nend\nfn step u32 u32 -> u32\nr add p0 1\nret r\nend\nfn f -> u32\na loop belw step 10 0\nret a\nend\n',
  ],
  [
    'A0103',
    'fn below u32 u32 -> bool\nb lt p0 5\nret b\nend\nfn step u32 u32 -> u32\nr add p0 1\nret r\nend\nfn f -> u32\na loop below stepp 10 0\nret a\nend\n',
  ],
  ['A0001', 'fn f bol -> bool\na mov p0\nret a\nend\n'],
];
