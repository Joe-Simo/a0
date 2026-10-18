/** Native rejection/compatibility controls for private A128; no parser or printer substitute. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import type { Program } from '../src/core.js';
import { link } from '../src/link.js';
import { formatSource } from '../src/source.js';
import { type NativeApi, nativeSource } from '../src/source-native.js';
import type { NativeIrBuilder } from '../src/source-native-compose.js';
import { nativeSourceFormatter } from '../src/source-native-format.js';
import { encodeNativeProgram } from '../src/source-native-program.js';
import { readWasmWord, readWasmWords, writeWasmWord, writeWasmWords } from '../src/wasm-words.js';
import { prepareSourceFormat } from '../tools/source-native-load.js';

const frontendPath = process.env.A0_FORMAT_FRONTEND;
const formatPath = process.env.A0_FORMAT_COMPANION;
assert.ok(frontendPath && formatPath, 'A0_FORMAT_FRONTEND/COMPANION required');
const frontend = new WebAssembly.Module(await readFile(join(frontendPath, 'frontend.wasm')));
const companion = await prepareSourceFormat(formatPath);
const linked = await link('compiler/revision_arena.a0', (path) => readFile(path, 'utf8'));
const legacy = new WebAssembly.Module(
  Buffer.from(
    compile(linked.program, 'wasm', {
      wasmExports: ['arena_format_described', 'arena_revision'],
      wasmSimd: true,
      optimize: true,
      wasmIo: { module: 'a0_arena', read: 'a0_runtime_read', write: 'a0_runtime_write' },
    }).text,
    'base64',
  ),
);

const program: Program = {
  functions: [
    {
      name: 'literal',
      params: ['u32'],
      result: 'u32',
      nodes: [
        { id: 'bytes', op: 'arr', args: [{ kind: 'u32', value: 65 }], text: 'B' },
        {
          id: 'next',
          op: 'add',
          args: [
            { kind: 'param', index: 0 },
            { kind: 'u32', value: 1 },
          ],
        },
      ],
      ret: { kind: 'node', id: 'next' },
      afterComments: [],
      spec: {
        examples: [],
        pre: {
          id: 'pre',
          op: 'lt',
          args: [
            { kind: 'param', index: 0 },
            { kind: 'u32', value: 100 },
          ],
        },
      },
    },
  ],
  tailComments: ['# independent program tail'],
};

test('A128 rejects changed versions, identities, extents, ownership and text spans natively and atomically', () => {
  const api = new WebAssembly.Instance(frontend).exports as unknown as NativeApi;
  const variants: [string, Uint32Array, boolean][] = [];
  let descriptor: Uint32Array | undefined;
  const checked = (status: number): void => {
    assert.equal(status, 0);
  };
  const upload = (words: Uint32Array): number => {
    if (!words.length) return 0;
    const pointer = api.malloc(words.byteLength);
    assert.ok(pointer);
    try {
      writeWasmWords(api.memory.buffer, pointer, words);
      const handle = api.frontend_ir_upload(pointer, words.length);
      assert.ok(handle);
      return handle;
    } finally {
      api.free(pointer);
    }
  };
  const view = (handle: number, count: number) =>
    Uint32Array.from(readWasmWords(api.memory.buffer, api.frontend_view(handle), count));
  const builder: NativeIrBuilder = {
    initialize(source, strict) {
      const bytes = new TextEncoder().encode(source),
        pointer = api.malloc(bytes.length || 1);
      assert.ok(pointer);
      try {
        new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
        checked(api.frontend_ir_init(pointer, bytes.length, 100_000_000, strict ? 1 : 0));
      } finally {
        api.free(pointer);
      }
    },
    upload,
    symbol(name) {
      const bytes = new TextEncoder().encode(name);
      checked(
        api.frontend_ir_symbol(
          upload(bytes.length ? Uint32Array.from(bytes) : new Uint32Array(1)),
          bytes.length,
        ),
      );
      return api.frontend_ir_value();
    },
    type(kind, a, b, fields) {
      checked(api.frontend_ir_type(kind, a, b, upload(fields)));
      return api.frontend_ir_value();
    },
    get(index) {
      return readWasmWord(api.memory.buffer, api.frontend_ir_state() + index * 4);
    },
    set(index, value) {
      writeWasmWord(api.memory.buffer, api.frontend_ir_state() + index * 4, value);
    },
    authoring(_availability, value) {
      assert.ok(value);
      descriptor = value.slice();
      const change = (name: string, slot: number, replacement: number, revisionRelevant = true) => {
        const changed = value.slice();
        changed[slot] = replacement;
        variants.push([name, changed, revisionRelevant]);
      };
      for (const [name, slot] of [
        ['magic', 0],
        ['version', 1],
        ['source handle', 2],
        ['source length', 3],
        ['function count', 4],
        ['body count', 5],
        ['spec count', 6],
        ['tail length', 8],
        ['body length', 14],
        ['spec length', 17],
      ] as const)
        change(name, slot, (value[slot] as number) + 1);
      change('zero magic', 0, 0);
      const empty = new Uint32Array(128);
      variants.push(['empty explicit descriptor', empty, true]);
      change('tail capacity', 9, 0);
      change('absent program tail', 10, 0);
      change('program tail extent', 11, 0xffff_ffff, false);
      change('program tail count', 12, 0xffff_ffff, false);
      const table = (
        name: string,
        slot: number,
        mutate: (rows: Uint32Array) => void,
        revisionRelevant = true,
      ) => {
        const words = view(value[slot] as number, value[slot + 1] as number);
        mutate(words);
        change(name, slot, upload(words), revisionRelevant);
      };
      table(
        'tail presence',
        7,
        (rows) => {
          rows[0] = 2;
        },
        false,
      );
      table(
        'function tail extent',
        7,
        (rows) => {
          rows.set([1, 0xffff_ffff, 1]);
        },
        false,
      );
      table('text presence', 13, (rows) => {
        rows[0] = 2;
      });
      table('text start', 13, (rows) => {
        rows[1] = 0xffff_ffff;
      });
      table('text length', 13, (rows) => {
        rows[2] = 0xffff_ffff;
      });
      table('non-array text', 13, (rows) => {
        rows.set(rows.subarray(0, 3), 3);
      });
      table('contract text', 16, (rows) => {
        rows.set([1, 0, 1]);
      });
    },
  };
  try {
    encodeNativeProgram(program, builder);
    checked(api.frontend_ir_finish());
    assert.ok(descriptor);
    const parsed = Uint32Array.from(readWasmWords(api.memory.buffer, api.frontend_state(), 128));
    const specs = Uint32Array.from(readWasmWords(api.memory.buffer, api.frontend_specs(), 128));
    const before = [parsed.slice(), specs.slice()];
    const formatter = nativeSourceFormatter(api, companion);
    const valid = formatter.format(parsed, specs, { mapping: true }, descriptor);
    assert.ok(valid.ok);
    assert.equal(valid.text, formatSource(program));
    assert.ok(
      valid.facts.slice(32, 52).every((word) => word === 0),
      'private authoring descriptor is not returned in F',
    );
    const validRevision = formatter.revision(parsed, specs, { kind: 'program' }, descriptor);
    assert.ok(validRevision.ok);
    for (const [name, altered, revisionRelevant] of variants) {
      const formatted = formatter.format(parsed, specs, { mapping: true }, altered);
      assert.ok(!formatted.ok && 'status' in formatted, name);
      assert.equal(formatted.status, 7, name);
      assert.deepEqual(formatted.facts.slice(4, 7), [0, 0, 0], name);
      assert.equal(formatted.facts[9], 0, name);
      const revision = formatter.revision(parsed, specs, { kind: 'program' }, altered);
      if (revisionRelevant) assert.deepEqual(revision, { ok: false, status: 7 }, name);
      else {
        // Historical and semantic revisions intentionally do not traverse source-only tail ownership.
        assert.ok(revision.ok, name);
        assert.equal(revision.revision, validRevision.revision, name);
      }
    }
    assert.deepEqual(parsed, before[0]);
    assert.deepEqual(specs, before[1]);
    const after = formatter.format(parsed, specs, { mapping: true }, descriptor);
    assert.ok(after.ok);
    assert.equal(after.text, valid.text);
    assert.deepEqual(after.events, valid.events);
  } finally {
    api.frontend_close();
  }
});

test('legacy companion exports remain callable and absent A128 capability refuses explicitly', () => {
  const engine = nativeSource(frontend, undefined, { load: () => legacy });
  try {
    const source = 'fn identity\nret A\nend\n';
    const parsed = engine.parse(source);
    assert.ok(parsed.ok);
    const old = engine.format(parsed);
    assert.ok(old.ok);
    assert.equal(old.text, source);
    const revision = engine.revision(parsed);
    assert.ok(revision.ok);
    const simple: Program = {
      functions: [
        {
          name: 'identity',
          params: ['u32'],
          result: 'u32',
          nodes: [],
          ret: { kind: 'param', index: 0 },
        },
      ],
    };
    const checked = engine.checkProgram(simple);
    assert.ok(checked.ok);
    const simpleFormat = engine.format(checked);
    assert.ok(simpleFormat.ok);
    assert.equal(simpleFormat.text, source);
    assert.ok(engine.revision(checked).ok);
    const authored = engine.checkProgram(program);
    assert.ok(authored.ok);
    const refusal = {
      ok: false,
      reason: 'authoring-metadata',
      detail: 'unsupported-authoring-version',
    };
    assert.deepEqual(engine.format(authored), refusal);
    assert.deepEqual(engine.revision(authored), refusal);
  } finally {
    engine.close();
  }
});
