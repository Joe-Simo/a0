import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { formatProgram, parseAndValidate, run, textNode, validate } from '../src/core.js';
import { EditSession, parsePatch, programRevision, revision } from '../src/edit.js';
import { formatSource, parseSource, parseSourceNode } from '../src/source.js';
import { sourceEditSyntax } from '../src/source-edit.js';
import { nativeSource } from '../src/source-native.js';

const malformed = ['\ud800', '\udfff', '\ud800x', '\udfff\ud800'];
const source = 'fn f\nx add A 1\nret x\nend\n';
const legacy = 'fn f u32 -> u32\nx add p0 1\nret x\nend\n';
const module = new WebAssembly.Module(await readFile('seed/source-frontend/frontend.wasm'));

test('host and native source readers reject non-scalar UTF16 before lossy encoding', () => {
  const engine = nativeSource(module);
  try {
    for (const value of malformed) {
      for (const input of [`# ${value}\n${source}`, `fn f\nx "${value}"\nret 0\nend\n`]) {
        assert.throws(() => engine.parse(input), /unpaired UTF-16/);
        assert.throws(() => parseSource(input), /unpaired UTF-16/);
      }
      assert.throws(() => parseAndValidate(`# ${value}\n${legacy}`), /unpaired UTF-16/);
      assert.throws(() => parseSourceNode(`x "${value}"`), /unpaired UTF-16/);
      assert.throws(() => textNode('x', value), /unpaired UTF-16/);
    }
    assert.ok(engine.parse(source).ok);
  } finally {
    engine.close();
  }
});

test('valid Unicode scalars retain source bytes, text bytes and reference IR', () => {
  const engine = nativeSource(module);
  try {
    for (const value of ['a', 'Ω', '😀', '\ufffd', '\ud800\udc00', '\ufeff']) {
      const input = `\ufeff# ${value}\nfn f\nx "${value}"\nret 0\nend\n`;
      const host = validate(parseSource(input));
      const native = engine.parse(input);
      assert.ok(native.ok);
      assert.equal(formatProgram(native.program), formatProgram(host));
      const formatted = formatSource(host);
      assert.equal(Buffer.from(formatted).toString('utf8'), formatted);
      assert.deepEqual(
        host.functions[0]?.nodes[0]?.args.map((arg) => ('value' in arg ? arg.value : undefined)),
        [...new TextEncoder().encode(value)],
      );
    }
  } finally {
    engine.close();
  }
});

test('source formatter refuses manually supplied malformed metadata instead of replacing it', () => {
  const program = parseSource(source);
  for (const value of malformed) {
    assert.throws(
      () => formatSource({ ...program, tailComments: [`# ${value}`] }),
      /unpaired UTF-16/,
    );
  }
});

test('malformed edit comments preserve revisions and open handles for the next valid reply', () => {
  for (const mode of ['source', 'legacy']) {
    const session = new EditSession(
      mode === 'source' ? validate(parseSource(source)) : parseAndValidate(legacy),
      mode === 'source' ? { syntax: sourceEditSyntax } : {},
    );
    session.open('f');
    const before = programRevision(session.program);
    const body = mode === 'source' ? 'x add A 2' : 'x add p0 2';
    for (const value of malformed) {
      assert.throws(() => session.apply(`${body} # ${value}`), /unpaired UTF-16/);
      assert.equal(programRevision(session.program), before);
    }
    session.apply(`${body} # 😀`);
    const fn = session.program.byName.get('f');
    assert.ok(fn);
    assert.equal(run(fn, [1]), 3);
    assert.notEqual(programRevision(session.program), before);
  }
});

test('standalone patches reject malformed comments before stripping them', () => {
  const program = validate(parseSource(source));
  const fn = program.byName.get('f');
  assert.ok(fn);
  for (const value of malformed) {
    assert.throws(
      () => parsePatch(`patch f ${revision(fn)}\nx add A 2 # ${value}\nend`, sourceEditSyntax),
      /unpaired UTF-16/,
    );
  }
  assert.doesNotThrow(() =>
    parsePatch(`patch f ${revision(fn)}\nx add A 2 # 😀\nend`, sourceEditSyntax),
  );
});
