import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import {
  applyScoped,
  indexFunctions,
  SCOPED_LANGS,
  type ScopedLang,
  scopedView,
} from '../tools/scoped-view.js';

// base <- mid <- top, plus unrelated; `top` calls mid and base; a method call and a string
// that look like calls must not count.
const SOURCES: Record<ScopedLang, string> = {
  ts: [
    'export function base(x: number): number {',
    '  return (x + 1) >>> 0;',
    '}',
    'export function other(x: number): number {',
    '  return x;',
    '}',
    'export function mid(x: number): number {',
    '  return base(x);',
    '}',
    'export function top(x: number): number {',
    '  const s = "other(x)";',
    '  return (mid(x) + base(x) + s.length + Math.abs(x)) >>> 0;',
    '}',
    '',
  ].join('\n'),
  rust: [
    'pub fn base(x: u32) -> u32 {',
    '    x.wrapping_add(1)',
    '}',
    'pub fn other(x: u32) -> u32 {',
    '    x',
    '}',
    'pub fn mid(x: u32) -> u32 {',
    '    base(x)',
    '}',
    'pub fn top(x: u32) -> u32 {',
    '    mid(x).wrapping_add(base(x)).wrapping_add(x.count_ones())',
    '}',
    '',
  ].join('\n'),
  python: [
    'def base(x: int) -> int:',
    '    return (x + 1) & 0xFFFFFFFF',
    'def other(x: int) -> int:',
    '    return x',
    'def mid(x: int) -> int:',
    '    return base(x)',
    'def top(x: int) -> int:',
    '    s = "other(x)"',
    '    return (mid(x) + base(x) + len(s) + abs(x)) & 0xFFFFFFFF',
    '',
  ].join('\n'),
  go: [
    'package main',
    '',
    'func base(x uint32) uint32 {',
    '\treturn x + 1',
    '}',
    'func other(x uint32) uint32 {',
    '\treturn x',
    '}',
    'func mid(x uint32) uint32 {',
    '\treturn base(x)',
    '}',
    'func top(x uint32) uint32 {',
    '\treturn mid(x) + base(x) + uint32(len("other(x)"))',
    '}',
    '',
  ].join('\n'),
  java: [
    'public final class Lib {',
    '    public static int base(int x) {',
    '        return x + 1;',
    '    }',
    '    public static int other(int x) {',
    '        return x;',
    '    }',
    '    public static int mid(int x) {',
    '        return base(x);',
    '    }',
    '    public static int top(int x) {',
    '        return mid(x) + base(x) + Math.abs(x) + "other(x)".length();',
    '    }',
    '}',
    '',
  ].join('\n'),
  c: [
    '#include <stdint.h>',
    '',
    'uint32_t base(uint32_t x) {',
    '  return x + 1;',
    '}',
    'uint32_t other(uint32_t x) {',
    '  return x;',
    '}',
    'uint32_t mid(uint32_t x) {',
    '  return base(x);',
    '}',
    'const uint32_t *top(uint32_t x) {',
    '  return (const uint32_t[]){mid(x) + base(x) + sizeof("other(x)")};',
    '}',
    '',
  ].join('\n'),
  ruby: [
    'def base(x)',
    '  (x + 1) & 0xFFFFFFFF',
    'end',
    'def other(x)',
    '  x',
    'end',
    'def mid(x)',
    '  base(x)',
    'end',
    'def top(x)',
    '  (mid(x) + base(x) + x.abs + "other(x)".length) & 0xFFFFFFFF',
    'end',
    '',
  ].join('\n'),
};

test('scoped view: the direct callees are found by parsing, in order of first call, in every language', async () => {
  for (const lang of SCOPED_LANGS) {
    const fns = await indexFunctions(lang, SOURCES[lang]);
    assert.deepEqual(
      fns.map((f) => f.name),
      ['base', 'other', 'mid', 'top'],
      lang,
    );
    const top = fns.find((f) => f.name === 'top');
    assert.deepEqual(top?.callees, ['mid', 'base'], lang);
    // Not transitive: mid calls base, top lists it because it calls it itself.
    assert.deepEqual(fns.find((f) => f.name === 'mid')?.callees, ['base'], lang);
    assert.deepEqual(fns.find((f) => f.name === 'base')?.callees, [], lang);
  }
});

test('scoped view: signatures arm shows the target body and one bodyless signature per callee', async () => {
  const expected: Record<ScopedLang, string[]> = {
    ts: ['export function mid(x: number): number;', 'export function base(x: number): number;'],
    rust: ['pub fn mid(x: u32) -> u32;', 'pub fn base(x: u32) -> u32;'],
    python: ['def mid(x: int) -> int: ...', 'def base(x: int) -> int: ...'],
    go: ['func mid(x uint32) uint32', 'func base(x uint32) uint32'],
    java: ['    public static int mid(int x);', '    public static int base(int x);'],
    c: ['uint32_t mid(uint32_t x);', 'uint32_t base(uint32_t x);'],
    ruby: ['def mid(x); end', 'def base(x); end'],
  };
  for (const lang of SCOPED_LANGS) {
    const v = await scopedView(lang, SOURCES[lang], 'top', 'signatures');
    const bodyLines = v.lines.filter((l) => l.editable);
    const sigLines = v.lines.filter((l) => !l.editable);
    assert.deepEqual(
      sigLines.map((l) => l.text),
      expected[lang],
      lang,
    );
    assert.ok(bodyLines.length >= 3, lang);
    assert.ok(v.text.startsWith('e0\n1 '), lang);
    // The text is the verbatim source lines of the target.
    assert.ok(SOURCES[lang].includes(bodyLines.map((l) => l.text).join('\n')), lang);
  }
});

test('scoped view: bodies arm shows the callee bodies instead of signatures', async () => {
  for (const lang of SCOPED_LANGS) {
    const sigs = await scopedView(lang, SOURCES[lang], 'top', 'signatures');
    const bodies = await scopedView(lang, SOURCES[lang], 'top', 'bodies');
    assert.ok(bodies.lines.length > sigs.lines.length, lang);
    assert.ok(
      bodies.lines.every((l) => l.editable),
      lang,
    );
    assert.ok(bodies.text.includes('base'), lang);
  }
});

test('scoped view: edits are line-numbered on the view and land in the file', async () => {
  for (const lang of SCOPED_LANGS) {
    const src = SOURCES[lang];
    const v = await scopedView(lang, src, 'mid', 'signatures');
    // Lines: the target (mid), then base's signature.
    const bodyLen = v.lines.filter((l) => l.editable).length;
    const sig = bodyLen + 1;
    assert.equal(v.lines[sig - 1]?.editable, false, lang);
    // Replace a body line of mid, insert after the signature of base (lands after base's end),
    // insert at the top (lands just above mid).
    const second = v.lines[1]?.text ?? '';
    const r = applyScoped(
      src,
      v,
      `2 ${second}  // edited\n+${sig} // after base\n+0 // above mid`,
      'e0',
    );
    assert.equal(r.error, undefined, lang);
    const lines = r.source.split('\n');
    const at = (s: string): number => lines.findIndex((l) => l.includes(s));
    assert.ok(at('// above mid') >= 0 && at('// above mid') < at('edited'), lang);
    assert.ok(at('// above mid') > at('other'), lang);
    // base's end line precedes the inserted line, which precedes mid.
    const baseEnd = lines.findIndex((l) => l.includes('x + 1') || l.includes('x.wrapping_add(1)'));
    assert.ok(at('// after base') > baseEnd, lang);
    assert.ok(at('// after base') < at('// above mid') || at('// after base') < at('edited'), lang);
  }
});

test('scoped view: a signature line is read-only; past-the-end appends; handle optional', async () => {
  const src = SOURCES.ts;
  const v = await scopedView('ts', src, 'mid', 'signatures');
  const n = v.lines.length;
  const ro = applyScoped(
    src,
    v,
    `${n} export function base(x: number): number { return 0; }`,
    'e0',
  );
  assert.match(ro.error ?? '', /read-only signature/);
  const append = applyScoped(src, v, `e0\n+${n + 5} // end`, 'e0');
  assert.equal(append.error, undefined);
  assert.ok(append.source.indexOf('// end') < append.source.indexOf('export function top'));
  assert.match(applyScoped(src, v, 'e9\n1 x', 'e0').error ?? '', /expected handle e0/);
  assert.match(applyScoped(src, v, '1 a\n1 b', 'e0').error ?? '', /duplicate/);
  assert.match(applyScoped(src, v, 'nonsense', 'e0').error ?? '', /bad edit line/);
});

test('scoped view: TypeScript call graph agrees with the TypeScript compiler API', async () => {
  const src = SOURCES.ts;
  const sf = ts.createSourceFile('m.ts', src, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const st of sf.statements)
    if (ts.isFunctionDeclaration(st) && st.name) names.add(st.name.text);
  const graph = new Map<string, string[]>();
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name) continue;
    const calls: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const callee = n.expression.text;
        if (names.has(callee) && !calls.includes(callee)) calls.push(callee);
      }
      ts.forEachChild(n, walk);
    };
    walk(st);
    graph.set(st.name.text, calls);
  }
  for (const f of await indexFunctions('ts', src))
    assert.deepEqual(f.callees, graph.get(f.name), f.name);
});
