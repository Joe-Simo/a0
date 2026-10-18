import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { nativeSource } from '../src/source-native.js';
import type { NativeUnitSourceSpan } from '../src/source-native-unit-origins.js';

const module = new WebAssembly.Module(await readFile('seed/source-frontend/frontend.wasm'));

test('authentic native units expose detached duplicate-node/spec/return origins in original UTF8 and UTF16 coordinates', () => {
  const frontend = nativeSource(module);
  const source = [
    '# Ω😀',
    'fn f u32 -> u32 # header',
    'ex 0 -> 1 # example',
    'pre lt A 9 # precondition',
    'post gt r 0 # postcondition',
    'x add A 1 # first',
    'x sub x 1 # duplicate',
    'ret add x 1 # synthetic return',
    'end # end',
    '',
  ].join('\r\n');
  try {
    const unit = frontend.parseUnit(source);
    assert.ok(unit.ok, 'duplicate body IDs are grammar-valid before checking');
    const origins = frontend.unitSourceOrigins(unit),
      fn = origins.functions[0];
    assert.ok(fn);
    assert.equal(origins.functions.length, 1);
    const bytes = new TextEncoder().encode(source);
    const text = (span: NativeUnitSourceSpan): string => {
      const value = source.slice(span.utf16Start, span.utf16Start + span.utf16Length);
      assert.equal(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(span.byteStart, span.byteStart + span.byteLength),
        ),
        value,
      );
      assert.equal(source.slice(0, span.utf16Start).split('\n').length, span.line);
      assert.equal(Buffer.byteLength(source.slice(0, span.utf16Start)), span.byteStart);
      return value.trimEnd();
    };
    assert.equal(text(fn.header), 'fn f u32 -> u32');
    assert.deepEqual(
      fn.nodes.map((node) => node.nodeIndex),
      [0, 1, 2],
    );
    assert.deepEqual(
      fn.nodes.map((node) => node.syntheticReturn),
      [false, false, true],
    );
    assert.deepEqual(
      fn.nodes.map((node) => node.span.line),
      [6, 7, 8],
    );
    assert.deepEqual(
      fn.nodes.map((node) => text(node.span)),
      ['x add A 1', 'x sub x 1', 'ret add x 1'],
    );
    assert.equal(text(fn.ret), 'ret add x 1');
    assert.equal(text(fn.end), 'end');
    assert.equal(text(fn.examples[0]?.span as NativeUnitSourceSpan), 'ex 0 -> 1');
    assert.equal(text(fn.pre as NativeUnitSourceSpan), 'pre lt A 9');
    assert.equal(text(fn.post as NativeUnitSourceSpan), 'post gt r 0');
    const saved = structuredClone(origins);
    (fn.nodes[0]?.span as { line: number }).line = 99;
    (unit.state as number[])[2] = 99;
    (unit.program.functions as unknown[]).length = 0;
    assert.deepEqual(
      frontend.unitSourceOrigins(unit),
      saved,
      'caller mutations never alter retained native tables',
    );
    assert.ok(frontend.parse('fn identity\nret A\nend\n').ok);
    assert.deepEqual(
      frontend.unitSourceOrigins(unit),
      saved,
      'later arena generations keep detached native ownership',
    );
    frontend.close();
    assert.throws(() => frontend.unitSourceOrigins(unit), /closed/);
    assert.equal(
      saved.functions[0]?.nodes[0]?.span.line,
      6,
      'already detached metadata survives close',
    );
  } finally {
    frontend.close();
  }
});

test('unit origins enforce authentic engine ownership and cannot be obtained from failed or forged results', () => {
  const frontend = nativeSource(module),
    peer = nativeSource(module);
  try {
    const unit = frontend.parseUnit('fn f\nret 1\nend\n'),
      other = peer.parseUnit('fn f\nret 1\nend\n'),
      failed = frontend.parseUnit('fn f\nret\nend\n');
    assert.ok(unit.ok && other.ok && !failed.ok);
    for (const value of [other, failed, { ...unit }])
      assert.throws(() => frontend.unitSourceOrigins(value), /parsed unit owned by this frontend/);
    assert.equal(frontend.unitSourceOrigins(unit).functions.length, 1);
  } finally {
    frontend.close();
    peer.close();
  }
});
