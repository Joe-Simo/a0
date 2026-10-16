import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { normalizeLine, parse, stripComment, validate, validateFunction } from '../src/core.js';
import { A0Error } from '../src/diagnostics.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { buildStage, closure, emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { readBootstrapSeed } from '../tools/seed.js';

// This bounded subset compares complete public core JSON, including fixes and edits.
// Unsupported IDs remain explicit refusals; no host repair follows an A0 refusal.
const f = (body: string, result = 'u32', params = 'u32') =>
  `fn f ${params} -> ${result}\n${body}\nend\n`;
const nested = `${'('.repeat(200)}u32${')'.repeat(200)}`;
const cases = [
  f('a add true p0\nret a'),
  f('a and p0 true\nret a'),
  f('a eq true p0\nret a', 'bool'),
  f('a ne true p0\nret a', 'bool'),
  f('a select p0 1 2\nret a'),
  f('a select true 1 false\nret a'),
  f('a arr 1 false\nret 0'),
  f('a arr p0\nret 0', 'u32', 'io'),
  f('a arr p0 p0\nret 0', 'u32', 'u32x65536'),
  f('a puts p0 1\nret a', 'io', 'io'),
  f('a get p0 1\nret a'),
  f('a get p0 1\nret a', 'u32', '(u32,bool)'),
  f('a cget p0 1\nret a', 'u32', 'u32'),
  f('a cget p0 1\nret a', 'u32', 'u32x4x2'),
  f('a set p0 1 2\nret a'),
  f('a set p0 1 2\nret a', 'u32', '(u32,bool)'),
  f('a at p0 1\nret a'),
  f('a at p0 1\nret a', 'u32', 'u32x4'),
  f('a put p0 1 2\nret 0', 'u32', 'u32x4'),
  f('a rec p0 true\nb at a p0\nret p0'),
  f('a mov p0\na mov 0\nret a'),
  f('ret 0', 'u32', 'io io'),
  f('ret p0', 'bool', nested),
  f('a read p0\nb at a 0\nc at a 1\nd write c true\nret d', 'io', 'io'),
  'fn f -> u32\na text ""\nret 0\nend\n',
  'fn f -> u32\nret 0\n',
  'fn f -> u32\n  ret   0 # comment\nfn later -> u32\nret 1\nend\n',
  'fn f -> u32\nret 0\nwhoops\n',
  `fn f ${Array(65).fill('u32').join(' ')} -> u32\nret 0\nend\n`,
  'fn f u32 -> u32\n' +
    Array.from({ length: 4096 }, (_, i) => `n${i} add p0 ${i}\n`).join('') +
    'ret add n4095 1\nend\n',
];
cases.push(
  f('ret at p0 0', 'u32', 'u32x4'),
  f('ret false'),
  'fn bare -> u32\nret true\nend\n',
  'fn f u32 -> u32\n  ret\u2003p0 #🙂\n',
);
cases.push(`# emoji🙂 and whitespace\n${f('a add true p0\nret a')}`);
// A0101 suggestions/later definitions and A0222 record-field diagnostics.
cases.push(
  f('ret unknown'),
  f('a mov p0\nb mov aa\nret b'),
  f('value mov p0\nb add valu 1\nret b'),
  f('value mov p0\nret valu'),
  f('value mov p0\nret add valu 1'),
  f('retval mov p0\nvalue mov p0\nret add valu 1'),
  f('value add value 1\nret value'),
  f('x mov value\nvalue mov p0\nret x'),
  f('valux mov p0\nx mov value\nvalue mov p0\nret x'),
  f('value mov p0\nvaluf mov p0\nx mov valug\nret x'),
  f('valuf mov p0\nvalue mov p0\nx mov valug\nret x'),
  f('abcde mov p0\nabcdf mov p0\nx mov abcd\nret x'),
  f('abcde mov p0\nx mov axcdx\nret x'),
  f('ab mov p0\nx mov ac\nret x'),
  f('a_b_c mov p0\nx mov a_bc\nret x'),
  f('val123 mov p0\nx mov val124\nret x'),
  f(`${'a'.repeat(64)} mov p0\nx mov ${'a'.repeat(63)}\nret x`),
  f(`${'a'.repeat(64)} mov p0\nx mov ${`${'a'.repeat(63)}b`}\nret x`),
  `fn before u32 -> u32\nvalue mov p0\nret value\nend\n${f('ret valu')}`,
  `# supplementary🙂\n${f('value mov p0\nb mov valu\nret b').replaceAll('\n', '\r\n')}`,
  f('x at p0 2\nret x', 'u32', '(u32,bool)'),
  f('x put p0 4294967295 1\nret 0', 'u32', '(u32,bool)'),
  f('ret at p0 8', 'u32', '(u32,(bool,u32x4))'),
  f('a mov missing\nret a'),
);
// Ordinary parse errors preserve their original line/byte facts and exact fix text.
cases.push(
  f('ret 4294967296'),
  f('a mov 99999999999999999999999999999999999999999999999\nret a'),
  f(`ret ${'9'.repeat(1000)}`),
  `fn f -> u32\na text "${'x'.repeat(65537)}"\nret 0\nend\n`,
  f('lonely\nret p0'),
  f('a loop\nret 0'),
  f('a loop pred\nret 0'),
  f('a loop BAD body 3 p0\nret a'),
  f('a arr\nret 0'),
  f('a rec\nret 0'),
  `use nope\n${f('ret p0')}`,
  `${f('ret p0')}use "late.a0"\n`,
  `use "a\\b.a0"\n${f('ret p0')}`,
  'wat\n',
  '# astral🙂\n🍃 argument\n',
  f('ret p0') + f('ret p0'),
  'fn f u32 ->\nret 0\nend\n',
  'fn f u32 u32\nret 0\nend\n',
  'fn f -> u32\nend\n',
  'fn f -> u32\na mov 0\nend\n',
  'fn f -> u32\na mov 0\nfn g -> u32\nret 0\nend\n',
  'fn f -> u32\na add true 1\nend\n',
  `fn f -> u32\n${Array.from({ length: 4097 }, (_, i) => `a${i} mov 0\n`).join('')}ret 0\nend\n`,
  'fn f -> u32\n',
  'fn f -> u32\na mov 0\n',
  f('ret'),
  f('ret 1 2'),
  `profile lax\n${f('ret p0')}`,
  `profile strict\nprofile strict\n${f('ret p0')}`,
  `${f('ret p0')}profile strict\n`,
  '#🙂\n  wat\u2003thing #comment\n',
);
// IO ownership diagnostics preserve operand identities and taken-field facts.
cases.push(
  f('a write p0 1\nb write p0 2\nret b', 'io', 'io'),
  f('a write p0 1\nb write a 2\nc write a 3\nret c', 'io', 'io'),
  f('x select true p0 p0\nret x', 'io', 'io'),
  f('a at p0 1\nb at p0 1\nret b', 'io', '(u32,io)'),
  f('a read p0\nb at a 1\nc at a 1\nret c', 'io', 'io'),
  f('a at p0 1\nb mov p0\nret b', '(u32,io)', '(u32,io)'),
  f('a at p0 1\nb put p0 0 2\nret b', '(u32,io)', '(u32,io)'),
  f('a at p0 1\nret p0', '(u32,io)', '(u32,io)'),
  f('a read p0\nb at a 1\nret a', '(u32,io)', 'io'),
  f('a write p0 1\nret p0', 'io', 'io'),
  f('a write p0 1\nb write a 2\nret a', 'io', 'io'),
  f('a mov p0\nb at p0 1\nret b', 'io', '(u32,io)'),
  f('a at p0 1\nb at p0 1\nret b', '(bool,io)', '(u32,(bool,io))'),
  f('a at p0 1\nb at p0 0\nc at p0 1\nret c', 'io', '(u32,io)'),
  f('a at p0 1\nb put p0 1 a\nc at p0 1\nret c', 'io', '(u32,io)'),
  `#🙂 ownership\n${f('a at p0 1\nret p0', '(u32,io)', '(u32,io)').replaceAll('\n', '\r\n')}`,
  f('a at p0 0\nb at p0 0\nret b', 'io', '(io,u32)'),
  f('a at p0 0\nret p0', '(io,u32)', '(io,u32)'),
  f('a read p0\nb at a 1\nret mov a', '(u32,io)', 'io'),
);
// Call/fold/loop signatures include their full contextual header fixes.
const step = (params: string, result = 'u32', ret = 'p0') =>
  `fn step ${params} -> ${result}\nret ${ret}\nend\n`;
const pred = (params: string, result = 'bool', ret = 'true') =>
  `fn pred ${params} -> ${result}\nret ${ret}\nend\n`;
const signatureCases = [
  step('u32 bool') + f('x fold step 3 p0\nret x'),
  step('bool u32', 'bool') + f('x fold step 3 p0\nret x'),
  step('u32 u32', 'bool', 'true') + f('x fold step 3 p0\nret 0'),
  step('(u32,bool) u32', '(u32,bool)') + f('x fold step 3 p0\nret 0'),
  step('u32 u32 bool') + f('x fold step 3 p0 1\nret x'),
  step('u32 u32 u32 bool') + f('x fold step 3 p0 1 2\nret x'),
  step('u32 io') + f('x fold step 3 p0\nret x'),
  step('u32 u32 (bool,u32x4)') + f('x fold step 3 p0 true\nret x'),
  step('u32') + f('x fold step 3 p0\nret x'),
  step('', 'u32', '0') + f('x fold step 3 p0\nret x'),
  step('u32 u32 bool') + f('x fold step 3 p0\nret x'),
  step('u32 u32 bool') + f('x fold step 3 p0 true false\nret x'),
  step('u32 u32') + f('x fold step\nret x'),
  step('u32 u32') + f('x fold step 3\nret x'),
  pred('') + step('u32 u32') + f('x loop pred step 3 p0\nret x'),
  pred('bool u32') + step('u32 u32') + f('x loop pred step 3 p0\nret x'),
  step('u32') + f('x call step\nret x'),
  step('u32') + f('x call step p0 1\nret x'),
  step('u32') + f('x step\nret x'),
  `fn mov u32 -> u32\nret p0\nend\n${f('x call mov p0 1\nret x')}`,
  pred('u32 u32', 'u32', 'p0') + step('u32 u32') + f('x loop pred step 3 p0\nret x'),
  step('u32 u32') + f('x fold step true p0\nret x'),
  step('u32 bool') + f('ret fold step 3 p0'),
  step('u32 u32 bool u32 u32x4') + f('x fold step 3 p0\nret x'),
];
const loopCases = [
  pred('u32 u32') + step('u32 bool') + f('x loop pred step 3 p0\nret x'),
  pred('u32 u32') + step('bool u32', 'bool') + f('x loop pred step 3 p0\nret x'),
  pred('u32 u32') + step('u32 u32 bool') + f('x loop pred step 3 p0\nret x'),
];
cases.push(...signatureCases, ...loopCases);
// Unknown fold/loop functions use earlier scope and exact original callee-word spans.
const named = (name: string) => `fn ${name} -> u32\nret 0\nend\n`;
const functionCases = [
  f('x fold missing 3 p0\nret x'),
  step('u32 u32') + f('x loop missing step 3 p0\nret x'),
  step('u32 u32') + f('x fold stp 3 p0\nret x'),
  pred('u32 u32') + step('u32 u32') + f('x loop prd step 3 p0\nret x'),
  named('ab') + f('x fold ac 3 p0\nret x'),
  named('value') + named('valuf') + f('x fold valug 3 p0\nret x'),
  named('valuf') + named('value') + f('x fold valug 3 p0\nret x'),
  named('value') + named('valuf') + step('u32 u32') + f('x loop valug step 3 p0\nret x'),
  named('valux') + f('x fold value 3 p0\nret x') + named('value'),
  f('x fold f 3 p0\nret x'),
  step('u32 u32') + f('x loop f step 3 p0\nret x'),
  f('x fold step 3 p0\nret x') + step('u32 u32'),
  step('u32 u32') + f('x loop pred step 3 p0\nret x') + pred('u32 u32'),
  step('u32 u32') + f('ret fold stp 3 p0'),
  step('u32 u32') + f('retval mov p0\nret fold stp 3 p0'),
  pred('u32 u32') + step('u32 u32') + f('ret loop prd step 3 p0'),
  `#🙂 functiontarget\n${step('u32 u32')}${f('  x   fold   stp  3 p0\nret x').replaceAll('\n', '\r\n')}`,
  f('x fold addx 3 p0\nret x'),
  Array.from({ length: 1001 }, (_, i) => named(`helper${i}`)).join('') +
    f('x fold helperx999 3 p0\nret x'),
  Array.from({ length: 9001 }, (_, i) => named(`helper${i}`)).join('') +
    f('x fold helperx8999 3 p0\nret x'),
];
cases.push(...functionCases);
const unsupported = [
  f(`${String.raw`a text "\q"`}\nret 0`),
  f('ret 0', 'u32', 'bol'),
  'fn f -> u32\nex -> 1\nret 1\nend\n',
];

// A0218 formats the exact original trip×accepted callee bound as JS Number text.
const leaf = 'fn leaf u32 u32 -> u32\nret p0\nend\n';
const bounded = (k: number) =>
  `${leaf}fn bounded u32 u32 -> u32\na fold leaf ${k} p0\nret a\nend\n`;
const products: [number, number][] = [
  [1, 16777217],
  [1, 4294967295],
  [2, 4294967295],
  [16777216, 2],
  [16777216, 4294967295],
  [16777215, 4294967295],
  [2097152, 4294967295],
  [2097153, 4294967295],
  [2097153, 4294967293],
  [4194305, 4294967295],
  [4194305, 4294967293],
  [8388609, 4294967295],
  [8388609, 4294967291],
  [10000000, 4294967295],
  [1234567, 4000000001],
  [16777213, 4294967289],
  [65536, 65536],
  [65537, 65537],
  [1048576, 4294967295],
  [16777216, 536870912],
  [16777216, 536870913],
  [16777215, 536870945],
];
const iterationCases = products.map(([k, n]) => bounded(k) + f(`x fold bounded ${n} p0\nret x`));
iterationCases.push(
  leaf +
    'fn bounded u32 u32 -> u32\na fold leaf p1 p0\nret a\nend\n' +
    f('x fold bounded 4294967295 p0\nret x'),
  bounded(16777216) +
    'fn wrapper u32 u32 -> u32\na call bounded p0 p1\nret a\nend\n' +
    f('x fold wrapper 4294967295 p0\nret x'),
  bounded(16777216) + pred('u32 u32') + f('x loop pred bounded 4294967295 p0\nret x'),
  bounded(2097153) + f('ret fold bounded 4294967295 p0'),
  `profile strict\n${bounded(8388609)}${f('x fold bounded 4294967291 p0\nret x')}`,
  bounded(16777216) + f('a fold leaf 16777216 p0\nx fold bounded 2 a\nret x'),
  '#🙂 exact product\n' +
    bounded(16777215) +
    f('  x   fold bounded   4294967295 p0 #🙂\nret x').replaceAll('\n', '\r\n'),
);
cases.push(...iterationCases);

// A0102 repairs, aliases and earlier/later names execute in A0 in both fix-option modes.
const callNamed = (name: string, params = 'u32', ret = 'p0') =>
  `fn ${name} ${params} -> u32\nret ${ret}\nend\n`;
const callCases = [
  f('x missing p0\nret x'),
  f('x call missing p0\nret x'),
  f('x strange_unknown_name\nret x'),
  f('x mova p0\nret x'),
  f('x wriet p0 1\nret x'),
  f('x udi p0 2\nret x'),
  f('x call udiv p0 1\nret x'),
  f('x call cget p0 1\nret x'),
  callNamed('movab') + f('x mova p0\nret x'),
  callNamed('value') + callNamed('valuf') + f('x valug p0\nret x'),
  callNamed('valuf') + callNamed('value') + f('x valug p0\nret x'),
  callNamed('valux') + f('x value p0\nret x') + callNamed('value'),
  callNamed('valux') + f('x call value p0\nret x') + callNamed('value'),
  f('x f p0\nret x'),
  f('ret mova p0'),
  f('retval mov p0\nret mova p0'),
  `#🙂 target\n${f('  x   call   mova   p0 #🙂\nret x').replaceAll('\n', '\r\n')}`,
  callNamed('ab') + f('x ac p0\nret x'),
  callNamed('cget') + f('x cgets p0\nret x'),
  f('x mod p0 2\nret x'),
  f('x umod p0 2\nret x'),
  f('x call mod p0 2\nret x'),
  f('ret mod p0 2'),
  f('x mod p0\nret x'),
  f('x mod p0 1 2\nret x'),
  f('mod mov p0\nx mod mod 2\nret x'),
  f('x mod p0 2\nret x') + callNamed('mod', 'u32 u32'),
  'fn mod u32 -> u32\nx mod p0 2\nret x\nend\n',
  f('x not true\nret x', 'bool'),
  f('x not p0\nret x', 'bool', 'bool'),
  f('x call not p0\nret x', 'bool', 'bool'),
  f('ret not true', 'bool'),
  f('retval mov p0\nret not true', 'bool'),
  f('x not p0\nret x'),
  f('x not\nret x'),
  f('x not true false\nret x'),
  f('x not p0\nret x', 'u32', '(u32,bool)'),
  `${f('x not true\nret x', 'bool')}fn not bool -> bool\nret p0\nend\n`,
  f('x max p0 1\nret x'),
  f('x min p0 1\nret x'),
  f('x call max p0 1\nret x'),
  f('ret max p0 1'),
  f('retval mov p0\nret min p0 1'),
  f('xt0 mov 0\nxt1 mov 0\nx max p0 1\nret x'),
  f('x max p0 1\nxt0 mov 0\nxt1 mov 0\nret x'),
  f('xt0 mov 0\nx min p0 1\nxt1 mov 0\nret x'),
  f('x max true false\nret x', 'bool'),
  f('x min p0\nret x'),
  f('x max\nret x'),
  f('x min p0 true\nret x'),
  f('x max p0 1\nret x') + callNamed('max', 'u32 u32'),
  `#🙂 max\n${f('  x   max p0  4294967295 #🙂\nret x').replaceAll('\n', '\r\n')}`,
  f(`${'a'.repeat(64)} max p0 1\nret ${'a'.repeat(64)}`),
  f(`${Array.from({ length: 501 }, (_, i) => `xt${i} mov 0`).join('\n')}\nx max p0 1\nret x`),
  ...['neg', 'abs', 'cmp'].flatMap((op) => [
    f(`x ${op} p0\nret x`),
    f(`x call ${op}\nret x`),
    f(`x ${op} p0\nret x`) + callNamed(op),
  ]),
];
for (const [name, arity] of [
  ['sel', 3],
  ['lte', 2],
  ['gte', 2],
  ['ule', 2],
  ['uge', 2],
  ['ult', 2],
  ['ugt', 2],
  ['neq', 2],
  ['equ', 2],
] as const) {
  const args = arity === 3 ? 'true p0 1' : 'p0 1';
  callCases.push(
    f(`x ${name} ${args}\nret 0`),
    f(`x call ${name} ${args}\nret 0`),
    f(`x ${name} p0\nret 0`),
    f(`${name} mov p0\nx ${name} ${arity === 3 ? `true ${name} 1` : `${name} 1`}\nret 0`),
    f(`x ${name} ${args}\nret 0`) + callNamed(name, 'u32 '.repeat(arity).trim()),
  );
}
callCases.push(
  Array.from({ length: 1001 }, (_, i) => callNamed(`helper${i}`)).join('') +
    f('x helperx999 p0\nret x'),
);

callCases.push(
  Array.from({ length: 9001 }, (_, i) => callNamed(`helper${i}`)).join('') +
    f('x helperx8999 p0\nret x'),
);

cases.push(...callCases);

// A0003 preserves original tokens and exact whole-line operand repair edits.
const operandCases = [
  ...[
    '@',
    '0x',
    '0x100000000',
    '0xgg',
    'fn',
    '-0',
    '-4294967297',
    '1.5',
    '+1',
    'true!',
    'a(b,',
  ].map((x) => f(`x mov ${x}\nret x`)),
  ...['p0,', '1,2', '1,,2', ',,,', ',1', '0xff,', '-1,'].map((x) => f(`x mov ${x}\nret x`)),
  f('x add 1, 2\nret x'),
  f('x arr 1, 2, 3,\nret 0'),
  f('ret 1,'),
  f('ret add 1, 2'),
  f('x arr , , 1,,2,, ,\nret 0'),
  `#🙂 comma\n${f('  x   add   1,\u2028 2 #🙂\nret x').replaceAll('\n', '\r\n')}`,
  ...[
    '0x0',
    '0XfF',
    '0xffffffff',
    '0XFFFFFFFF',
    '0x00000000000000000000001',
    '0x00000000100000000',
  ].map((x) => f(`x mov ${x}\nret x`)),
  f('x arr 0xff 0xff\nret 0'),
  f('ret 0Xff'),
  f('ret add 0xff 1'),
  ...[
    'TRUE',
    'False',
    'Value',
    'P0',
    'P4294967296',
    'FN',
    'RET',
    '_Nope',
    'NEWName',
    'A'.repeat(64),
    'A'.repeat(65),
  ].map((x) => f(`x mov ${x}\nret x`)),
  f('ret FALSE', 'bool'),
  f('ret add P0 1'),
  f('x arr TRUE TRUE\nret 0'),
  ...[
    'K',
    'ValK',
    'K0',
    'Ä',
    'Σ',
    'İ',
    '𐐀',
    `${'K'.repeat(41)}XK`,
    `${'K'.repeat(41)}XXK`,
    `${'K'.repeat(42)}K`,
    'K'.repeat(64),
    'K'.repeat(65),
  ].map((x) => f(`x mov ${x}\nret x`)),
  ...[
    '-1',
    '-4294967295',
    '-4294967296',
    '-00000000000000000000001',
    '-00000000004294967296',
    '-9999999999999999999999999999999',
  ].map((x) => f(`x mov ${x}\nret x`)),
  f('ret -1'),
  f('ret add -4294967296 1'),
  f('x arr -1 -1\nret 0'),
  `#🙂 uppercase\n${f('  x   mov   Value #🙂\nret x').replaceAll('\n', '\r\n')}`,
  f(`x mov 0x${'0'.repeat(8193)}ffffffff\nret x`),
  f(`x mov -${'0'.repeat(8193)}1\nret x`),
  f(`x mov P${'0'.repeat(8193)}1\nret x`),
  f(`x mov ${'1,'.repeat(4097)}2\nret x`),
];

operandCases.push(
  f('retval mov p0\nret add 1, 2'),
  f('retval mov p0\nretval2 mov p0\nret add 1, 2'),
);

cases.push(...operandCases);

// A0019 applies JS camel-boundary/lowercase/underscore spelling rules in A0.
const nameCases = [
  ...[
    'Bad',
    'newName',
    'HTTPServer',
    'newHTTPServer',
    'my1Value',
    'FOO-Bar',
    'new-name',
    'name:',
    'new.Name',
    'pValue',
    'P0',
    'TRUE',
    'FN',
    'RET',
    '_Bad',
    '0Bad',
    '-Bad',
    '@bad',
    'a!b',
    'fn',
    'true',
    'PRE',
    'PROFILE',
    'İ',
    'K',
    'aİB',
    'aKB',
    'aÄB',
    'aΣB',
    'a𐐀B',
    'a🙂B',
    '𐐀',
    'Ä',
    'Σ',
    'ß',
    `${'K'.repeat(41)}XK`,
    `${'K'.repeat(41)}XXK`,
    'K'.repeat(64),
    'K'.repeat(65),
    'A'.repeat(64),
    'A'.repeat(65),
    `${'a'.repeat(63)}B`,
    `${'a'.repeat(62)}B`,
    'A'.repeat(8193),
  ].map(named),
  'fn\n',
  'fn #🙂\n',
  `#🙂 name\n${named('newName').replaceAll('\n', '\r\n')}`,
  `profile strict\n${named('NewName')}`,
  f('ret p0') + named('NewName'),
];

cases.push(...nameCases);

// A0005 keeps ordinary/colon and TEXT_LINE invalid-ID diagnostic priority.
const nodeNameCases = [
  ...[
    'Bad',
    'newName',
    'HTTPServer',
    'newHTTPServer',
    'my1Value',
    'FOO-Bar',
    'new-name',
    'name:',
    'new.Name',
    'pValue',
    'P0',
    'TRUE',
    'FN',
    'RET',
    '_Bad',
    '0Bad',
    '-Bad',
    '@bad',
    'a!b',
    'p0',
    'p999999999999999999999',
    'true',
    'false',
    'PRE',
    'PROFILE',
    'İ',
    'K',
    'aİB',
    'aKB',
    'aÄB',
    'aΣB',
    'a𐐀B',
    'a🙂B',
    '𐐀',
    'Ä',
    'Σ',
    'ß',
    'K'.repeat(64),
    'K'.repeat(65),
    'A'.repeat(64),
    'A'.repeat(65),
    `${'a'.repeat(63)}B`,
    `${'a'.repeat(62)}B`,
    'A'.repeat(8193),
  ].map((n) => f(`${n} mov 0\nret 0`)),
  ...['value:', 'a_b:', `${'a'.repeat(64)}:`, 'p0:', 'true:', 'ret:', '_value:', ':', 'NAME:'].map(
    (n) => f(`${n} add p0 1\nret 0`),
  ),
  f('Bad text "hi"\nret 0'),
  f('value: text "hi"\nret 0'),
  f('Bad text ""\nret 0'),
  f(`${String.raw`Bad text "\q"`}\nret 0`),
  f(`${String.raw`Bad text "\uD800"`}\nret 0`),
  f(`${String.raw`Bad text "a\"b"`}\nret 0`),
  f('Bad text "hi" extra\nret 0'),
  f('value: text "hi" extra\nret 0'),
  f('Bad text "unfinished\nret 0'),
  f('Bad TEXT "hi"\nret 0'),
  f('Bad text"hi"\nret 0'),
  f('Bad text "a\\\u2028b"\nret 0'),
  f('Bad text "a\\\u2029b"\nret 0'),
  f('Bad text "a\u2028b"\nret 0'),
  f('Bad text "hi" #🙂\nret 0'),
  f('Bad text "hi#inside"\nret 0'),
  f('value: text "hi" #comment\nret 0'),
  f(`${String.raw`Bad text "a\\"`}\nret 0`),
  f(`${String.raw`Bad text "a\"`}\nret 0`),
  `#🙂 node\n${f('  value:   add   p0   1 #🙂\nret 0').replaceAll('\n', '\r\n')}`,
  `#🙂 text\n${f('  Bad   text   "hello🙂" #comment\nret 0').replaceAll('\n', '\r\n')}`,
  `profile strict\n${f('newName mov 0\nret 0')}`,
];

cases.push(...nodeNameCases);

// A0105 converts the original decimal span to exact binary64 and JS Number text.
const exactMax = 2n ** 1024n - 2n ** 971n;
const overflowTie = exactMax + 2n ** 970n;
const decimalIndices = [
  '0',
  '0000',
  '1',
  '0001',
  '2',
  '64',
  ...[
    4294967294n,
    4294967295n,
    4294967296n,
    4294967297n,
    2n ** 53n - 1n,
    2n ** 53n,
    2n ** 53n + 1n,
    2n ** 53n + 2n,
    2n ** 53n + 3n,
    2n ** 56n - 5n,
    2n ** 56n - 4n,
    2n ** 56n - 1n,
    2n ** 56n,
    2n ** 56n + 1n,
    10n ** 20n - 1n,
    10n ** 20n,
    10n ** 21n - 1n,
    10n ** 21n,
    10n ** 21n + 1n,
    10n ** 22n - 1000000n,
    10n ** 22n,
    10n ** 100n,
    10n ** 308n,
    exactMax - 2n ** 970n,
    exactMax - 1n,
    exactMax,
    exactMax + 1n,
    overflowTie - 1n,
    overflowTie,
    overflowTie + 1n,
  ].map(String),
  '9'.repeat(308),
  '9'.repeat(309),
  '9'.repeat(1000),
  `${'0'.repeat(8193)}1`,
  `${'0'.repeat(8193)}4294967296`,
];
const parameterCases = [
  f('ret p1'), // Capability gain: this source was an explicit unsupported control.
  ...decimalIndices.map((index) => f(`ret p${index}`, 'u32', '')),
  f('a add p0 p1\nret a'),
  f('a add p0 p2\nret a', 'u32', 'u32 u32'),
  f('a mov p0001\nret a'),
  f('a select true 0 p2\nret a', 'u32', 'u32 bool'),
  f('ret add p0 p1'),
  f('retval mov p0\nretval1 mov p0\nret add p0 p2'),
  f('a mov p64\nret a', 'u32', Array(64).fill('u32').join(' ')),
  f('ret p2', 'u32', '(u32,bool) u32x65536'),
  f('ret p1', 'io', 'io'),
  f('a mov p1\nret a', '(u32,io)', '(u32,io)'),
  f('a add true p1\nret a'), // All operand bindings precede op type checking.
  f('a add p1 true\nret a'),
  `profile strict\n${f('ret p4294967296')}`,
  `#🙂 decimal\n${f('  a   mov   p9007199254740993 #🙂\nret a').replaceAll('\n', '\r\n')}`,
  `fn before u32 -> u32\nret p0\nend\n${f('ret p1')}`,
  Array.from({ length: 1001 }, (_, i) => `fn helper${i} -> u32\nret 0\nend\n`).join('') +
    f('ret p1'),
  f('a add true 0\nb mov p1\nret b'), // Earlier op type error wins over later bad index.
  f('a mov missing\nb mov p1\nret b'), // Earlier binding error wins.
  f('ret p-1'),
  f('ret P1'),
  f('ret p1e3'), // Grammar/name priority never enters number_integer.
];
const empty = f('ret p1', 'u32', '');
parameterCases.push(empty.replace('p1', `p1${'0'.repeat(2097152 - Buffer.byteLength(empty))}`));

cases.push(...parameterCases);

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const fixtures = resolve('test/fixtures/arena-diagnostics');
const runtime = resolve('tools/native');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    assert.ok(clang.path);
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-diagnostics-'));
    scratch = dir;
    const seed = await readBootstrapSeed();
    const [compiler] = await buildStage(clang, 'compiler', seed.c, 'emitchunkio', dir);
    const linked = await link('compiler/diagnostics_arena.a0', (path) => readFile(path, 'utf8'));
    const source = closure(linked.program.functions, 'arena_parse_diagnostic_options');
    // TS links and plans chunks; the verified native A0 seed parses, checks and emits C.
    const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(compiler, chunk, bounds));
    assert.equal(
      emitted.code,
      0,
      `native A0 diagnostic compilation: ${emitted.failed?.own.join(',')}`,
    );
    const result = /^(a0t\d+) a0_arena_parse_diagnostic_options\(/m.exec(emitted.text)?.[1];
    assert.ok(result);
    await writeFile(join(dir, 'module.c'), emitted.text);
    await writeFile(join(dir, 'api.h'), `#define DIAG_RESULT ${result}\n`);
    for (const level of [0, 2]) {
      const built = runTool(
        clang.path,
        [
          '-std=c11',
          `-O${level}`,
          '-Wall',
          '-Wextra',
          '-Wno-unused-parameter',
          '-Werror',
          '-fsanitize=undefined',
          '-fno-sanitize-recover=all',
          '-I',
          dir,
          '-I',
          runtime,
          join(fixtures, 'driver.c'),
          join(runtime, 'arena_runtime.c'),
          '-o',
          join(dir, `driver-O${level}`),
        ],
        { cwd: dir, timeoutMs: 120_000 },
      );
      assert.ok(built.ok, `native A0 diagnostics O${level}: ${built.stderr}`);
    }
    return dir;
  })();
  return prepared;
}

async function request(
  dir: string,
  level: number,
  source: string,
  budget = 50_000_000,
  options = 1,
) {
  const input = join(dir, 'source.bin');
  const output = join(dir, 'output.bin');
  await writeFile(input, source);
  const ran = runTool(
    join(dir, `driver-O${level}`),
    [input, output, String(budget), String(options)],
    {
      cwd: dir,
      timeoutMs: 120_000,
    },
  );
  assert.ok(ran.ok, `native request O${level}: ${ran.stderr}`);
  const bytes = await readFile(output);
  assert.ok(bytes.length >= 130 * 4);
  const status = bytes.readUInt32LE(0);
  const facts = Array.from({ length: 128 }, (_, i) => bytes.readUInt32LE((i + 1) * 4));
  const length = bytes.readUInt32LE(129 * 4);
  assert.equal(bytes.length, (130 + length) * 4, 'complete word transport');
  const json = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    const byte = bytes.readUInt32LE((130 + i) * 4);
    assert.ok(byte <= 255, 'A0 JSON output is bytes');
    json[i] = byte;
  }
  return { status, facts, json };
}

function reference(source: string, options = 1) {
  const before = process.env.A0_NEW_FIXES;
  process.env.A0_NEW_FIXES = options === 0 ? 'off' : 'on';
  try {
    validate(parse(source));
  } catch (error) {
    assert.ok(error instanceof A0Error);
    return error.toJSON();
  } finally {
    if (before === undefined) delete process.env.A0_NEW_FIXES;
    else process.env.A0_NEW_FIXES = before;
  }
  assert.fail('fixture must produce a reference diagnostic');
}

test('seed-built A0 diagnostics preserve supported full JSON, fixes and UTF16 span facts', {
  skip,
}, async () => {
  const dir = await prepare();
  assert.equal(cases.length, 558);
  assert.equal(parameterCases.length, 64);
  assert.equal(nodeNameCases.length, 75);
  assert.equal(nameCases.length, 49);
  assert.equal(operandCases.length, 75);
  assert.equal(callCases.length, 110);
  for (const level of [0, 2]) {
    for (const { index, source, options } of [
      ...cases.map((source, index) => ({ index, source, options: 1 })),
      ...[...callCases, ...operandCases, ...nameCases, ...nodeNameCases, ...parameterCases].map(
        (source, index) => ({
          index: cases.length + index,
          source,
          options: 0,
        }),
      ),
    ]) {
      const expected = reference(source, options);
      assert.ok(expected.id);
      const { status, facts, json } = await request(dir, level, source, 50_000_000, options);
      const label = `O${level} case ${index} ${expected.id} fixes${options}`;
      assert.equal(status, 0, label);
      assert.deepEqual(JSON.parse(json.toString('utf8')), expected, label);
      assert.equal(facts[1], Number(expected.id.slice(1)), `${label}: numeric ID`);
      assert.equal(facts[20], 15, `${label}: supported facts`);
      const raw = Buffer.from(source);
      const start = facts[3];
      const length = facts[4];
      assert.ok(start !== undefined && length !== undefined);
      assert.ok(start <= raw.length && length <= raw.length - start, `${label}: UTF8 span`);
      assert.equal(
        facts[12],
        raw.subarray(0, start).toString('utf8').length,
        `${label}: UTF16 start`,
      );
      assert.equal(
        facts[13],
        raw.subarray(start, start + length).toString('utf8').length,
        `${label}: UTF16 length`,
      );
      if (facts[0] === 6) {
        assert.equal(facts[2], expected.line ?? 0, `${label}: original parser line`);
        const target = raw.subarray(start, start + length).toString('utf8');
        if (expected.id === 'A0004')
          assert.ok(
            expected.message.includes(`literal ${target} exceeds u32`),
            `${label}: original decimal`,
          );
        if (['A0015', 'A0018', 'A0020', 'A0026'].includes(expected.id))
          assert.ok(
            target.length > 0 && expected.message.includes(target),
            `${label}: original word span`,
          );
      }
      if (/^A031[0-4]$/.test(expected.id)) {
        const target = raw.subarray(start, start + length).toString('utf8');
        assert.ok(expected.message.includes(`'${target}'`), `${label}: original IO operand span`);
        if (/^p[0-9]+$/.test(target)) {
          assert.equal(facts[25], 1, `${label}: parameter operand`);
          assert.equal(facts[26], Number(target.slice(1)), `${label}: parameter index`);
        } else assert.equal(facts[25], 0, `${label}: node operand`);
        if (['A0311', 'A0312', 'A0313'].includes(expected.id)) {
          const field = /io field ([0-9]+)/.exec(expected.message)?.[1];
          assert.ok(field);
          assert.equal(facts[24], Number(field), `${label}: original taken field`);
        }
      }
      if (expected.id === 'A0103' || expected.id === 'A0104') {
        const targetStart = facts[27];
        const targetLength = facts[28];
        assert.ok(targetStart !== undefined && targetLength !== undefined);
        assert.ok(targetStart <= raw.length && targetLength <= raw.length - targetStart);
        const target = raw.subarray(targetStart, targetStart + targetLength).toString('utf8');
        assert.ok(expected.message.includes(`'${target}'`), `${label}: exact callee word`);
        assert.equal(facts[29], raw.subarray(0, targetStart).toString('utf8').length);
        assert.equal(facts[30], target.length);
        assert.equal(facts[31], raw.subarray(0, targetStart).toString('utf8').split('\n').length);
        const mode = expected.fix?.includes('is defined below')
          ? 2
          : expected.edits.length > 0
            ? 1
            : 0;
        assert.equal(facts[22], mode, `${label}: callee suggestion/later mode`);
        if (mode === 1) assert.notEqual(facts[21], 0xffffffff);
        else assert.equal(facts[21], 0xffffffff);
      }
      if (expected.id === 'A0102') {
        const start = facts[27];
        const length = facts[28];
        assert.ok(start !== undefined && length !== undefined);
        assert.ok(start <= raw.length && length <= raw.length - start);
        const target = raw.subarray(start, start + length).toString('utf8');
        assert.ok(expected.message.includes(`'${target}'`), `${label}: exact callee word`);
        assert.equal(facts[29], raw.subarray(0, start).toString('utf8').length);
        assert.equal(facts[30], target.length);
        assert.equal(facts[31], raw.subarray(0, start).toString('utf8').split('\n').length);
        const mode = expected.fix?.includes('is defined below')
          ? 2
          : expected.applicability === 'exact'
            ? 3
            : expected.fix?.startsWith('there is no')
              ? 4
              : expected.edits.length > 0
                ? 1
                : 0;
        assert.equal(facts[22], mode, `${label}: selected call repair`);
        if (mode === 1) {
          assert.ok(facts[32] === 1 || facts[32] === 2, `${label}: candidate namespace`);
          assert.notEqual(facts[33], 0xffffffff, `${label}: candidate value`);
          assert.equal(facts[21], facts[32] === 1 ? facts[33] : 0xffffffff);
        } else {
          assert.equal(facts[21], 0xffffffff, `${label}: no selected function suggestion`);
          assert.equal(facts[32], 0);
          assert.equal(facts[33], 0xffffffff);
        }
      }
      if (expected.id === 'A0003') {
        assert.equal(facts[2], expected.line, `${label}: original parser line`);
        const target = raw.subarray(start, start + length).toString('utf8');
        assert.ok(expected.message.includes(`'${target}'`), `${label}: original operand`);
        const rule = expected.edits[0]?.rule;
        const fix = expected.fix ?? '';
        const mode =
          rule === 'comma' || fix.endsWith('not commas')
            ? 1
            : rule === 'hex' || fix.endsWith('literals are decimal')
              ? 2
              : rule === 'case' || fix.endsWith('operands are lowercase')
                ? 3
                : rule === 'negative' || fix.startsWith('literals are unsigned')
                  ? 4
                  : 0;
        assert.equal(facts[43], mode, `${label}: operand repair mode`);
        const words = normalizeLine(source.split('\n')[(expected.line ?? 1) - 1] ?? '').split(' ');
        const inline = words[0] === 'ret' && words.length > 2;
        assert.equal(facts[45], inline ? 1 : 0, `${label}: inline return source form`);
        if (inline) assert.notEqual(facts[46], 0xffffffff);
        else assert.equal(facts[46], 0xffffffff);
        if (mode === 2 || mode === 4) {
          const value = (mode === 2 ? /^write ([0-9]+):/ : / wraps to ([0-9]+)/).exec(
            expected.fix ?? '',
          )?.[1];
          assert.ok(value, `${label}: numeric fix`);
          assert.equal(facts[44], Number(value), `${label}: original derived numeric value`);
        }
      }
      if (expected.id === 'A0019') {
        const word = raw.subarray(start, start + length).toString('utf8');
        assert.ok(expected.message.includes(`'${word}'`), `${label}: original name`);
        assert.equal(facts[2], expected.line, `${label}: original parser line`);
        assert.equal(facts[47], expected.fix ? 1 : 0, `${label}: snake spelling present`);
        if (expected.fix) {
          const snake = /^write '([^']+)'/.exec(expected.fix)?.[1];
          assert.ok(snake);
          assert.equal(facts[48], snake.length, `${label}: ASCII snake spelling length`);
        }
      }
      if (expected.id === 'A0005') {
        const word = raw.subarray(start, start + length).toString('utf8');
        assert.ok(expected.message.includes(`'${word}'`), `${label}: original node identifier`);
        assert.equal(facts[0], 6, `${label}: original parse status retained`);
        assert.equal(facts[2], expected.line, `${label}: original parser line`);
        const line = stripComment(source.split('\n')[(expected.line ?? 1) - 1] ?? '').trim();
        const textForm = /^(\S+)\s+text\s+"((?:[^"\\]|\\.)*)"\s*$/.test(line);
        const mode = textForm ? 3 : expected.edits.length > 0 ? 2 : expected.fix ? 1 : 0;
        assert.equal(facts[49], mode, `${label}: ordinary/colon/text priority`);
        if (expected.fix) {
          const replacement = /^write '([^']+)'/.exec(expected.fix)?.[1];
          assert.ok(replacement);
          assert.equal(facts[50], replacement.length, `${label}: suggested ASCII length`);
        } else assert.equal(facts[50], 0);
      }
      if (expected.id === 'A0105') {
        const word = raw.subarray(start, start + length).toString('utf8');
        assert.match(word, /^p[0-9]+$/, `${label}: original parameter span`);
        const decimal = word.slice(1);
        const value = Number(decimal);
        const bits = Buffer.alloc(8);
        bits.writeDoubleLE(value);
        assert.equal(facts[51], bits.readUInt32LE(0), `${label}: Number binary64 low`);
        assert.equal(facts[52], bits.readUInt32LE(4), `${label}: Number binary64 high`);
        const fnIndex = facts[7];
        assert.ok(fnIndex !== undefined);
        const fn = parse(source).functions[fnIndex];
        assert.ok(fn);
        assert.equal(facts[53], fn.params.length, `${label}: original function parameter count`);
        assert.ok(expected.message.includes(`parameter p${String(value)} out of range`), label);
        assert.equal(facts[55], start, `${label}: whole parameter byte start`);
        assert.equal(facts[56], length, `${label}: whole parameter byte length`);
        assert.equal(facts[59], start + 1, `${label}: decimal byte start`);
        assert.equal(facts[60], length - 1, `${label}: decimal byte length`);
        assert.equal(facts[61], raw.subarray(0, start + 1).toString('utf8').length);
        assert.equal(facts[62], decimal.length, `${label}: decimal UTF16 length`);
        let cache = 0;
        for (const digit of decimal) cache = (cache * 10 + Number(digit)) >>> 0;
        assert.equal(facts[57], cache, `${label}: original wrapped u32 cache`);
        assert.equal(
          (facts[58] ?? 0) & 4,
          value > 0xffffffff ? 4 : 0,
          `${label}: cache overflow flag`,
        );
        assert.equal(expected.applicability, 'maybe');
        assert.equal(expected.edits.length, 0);
      }
      if (expected.id === 'A0218') {
        const program = parse(source);
        const where = expected.message.split(': literal iteration count ')[0];
        const scope = new Map<string, ReturnType<typeof validateFunction>>();
        const fn = program.functions.find((current) => {
          if (where?.startsWith(`${current.name}.`)) return true;
          scope.set(current.name, validateFunction(current, scope, undefined, program.profile));
          return false;
        });
        assert.ok(fn);
        const node = fn.nodes.find((current) => `${fn.name}.${current.id}` === where);
        assert.ok(node && (node.op === 'fold' || node.op === 'loop') && node.callee);
        const callee = scope.get(node.callee);
        assert.ok(callee);
        const trip = node.args[0];
        assert.ok(trip && trip.kind === 'u32');
        const exact = BigInt(trip.value) * BigInt(callee.literalIterations);
        assert.equal(facts[36], trip.value, `${label}: original trip`);
        assert.equal(facts[37], callee.literalIterations, `${label}: accepted callee bound`);
        assert.equal(
          BigInt(facts[34] ?? 0) + (BigInt(facts[35] ?? 0) << 32n),
          exact,
          `${label}: unsaturated product pair`,
        );
        assert.ok(expected.message.includes(`count ${String(Number(exact))} exceeds`), label);
        const calleeIndex = facts[38];
        assert.ok(calleeIndex !== undefined);
        assert.equal(program.functions[calleeIndex]?.name, callee.name, label);
        const tripStart = facts[39];
        const tripLength = facts[40];
        assert.ok(tripStart !== undefined && tripLength !== undefined);
        assert.ok(tripStart <= raw.length && tripLength <= raw.length - tripStart);
        assert.equal(
          raw.subarray(tripStart, tripStart + tripLength).toString('utf8'),
          String(trip.value),
        );
        assert.equal(facts[41], raw.subarray(0, tripStart).toString('utf8').length);
        assert.equal(
          facts[42],
          raw.subarray(tripStart, tripStart + tripLength).toString('utf8').length,
        );
      }
      if (expected.id === 'A0101') {
        const fn = parse(source).functions.find((fn) => expected.message.startsWith(`${fn.name}.`));
        assert.ok(fn);
        const target = raw.subarray(start, start + length).toString('utf8');
        assert.ok(expected.message.includes(`'${target}'`), `${label}: original target span`);
        const later = fn.nodes.some((node) => node.id === target);
        const mode = later ? 2 : expected.edits.length > 0 ? 1 : 0;
        assert.equal(facts[22], mode, `${label}: suggestion/later-definition mode`);
        if (mode === 1) assert.notEqual(facts[21], 0xffffffff, `${label}: suggestion symbol`);
        else assert.equal(facts[21], 0xffffffff, `${label}: no suggestion symbol`);
      }
    }
  }
});

test('seed-built A0 diagnostics preserve unsupported and allocation refusal status', {
  skip,
}, async () => {
  const dir = await prepare();
  const source = f('a add true p0\nret a');
  for (const level of [0, 2]) {
    for (const input of unsupported) {
      const result = await request(dir, level, input);
      assert.equal(result.status, 7, 'unsupported diagnostic/spec is explicit');
      assert.equal(result.json.length, 0, 'no partial JSON after refusal');
    }
    for (const options of [2, 0xffffffff]) {
      const result = await request(dir, level, callCases[0] ?? '', 50_000_000, options);
      assert.equal(result.status, 7, 'unknown fix option is explicit');
      assert.equal(result.json.length, 0, 'no partial JSON after option refusal');
    }
    for (const budget of [Buffer.byteLength(source), 256, 1024, 4096]) {
      const result = await request(dir, level, source, budget);
      assert.equal(result.status, budget === 4096 ? 0 : 4, `budget ${budget}`);
      if (result.status === 4) assert.equal(result.json.length, 0, 'no partial JSON on exhaustion');
      else assert.deepEqual(JSON.parse(result.json.toString('utf8')), reference(source));
    }
  }
});
