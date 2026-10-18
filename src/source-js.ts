/** Experimental JS target of the unchanged A0 frontend; only typed ABI/word transport lives here. */
import type { Type } from './core.js';
import { compiledSource, PAGE_WORDS, sourceArena } from './source-compiled.js';
import type { nativeSourceApi } from './source-native.js';
import type { NativeDiagnosticOptions } from './source-native-render.js';

export interface JsSourceFunction {
  readonly params: readonly Type[];
  readonly result: Type;
}
export interface JsSourceArtifact {
  readonly frontend: Readonly<Record<string, unknown>>;
  readonly arena: WebAssembly.Module;
  readonly functions: Readonly<Record<string, JsSourceFunction>>;
}

const page: Type = { kind: 'arr', elem: 'u32', length: PAGE_WORDS };
const state: Type = { kind: 'rec', fields: [...Array<Type>(6).fill(page), 'io'] };
const ir: Type = { kind: 'rec', fields: [page, 'io'] };
const irResult: Type = { kind: 'rec', fields: [page, 'u32', 'io'] };
export const JS_SOURCE_FUNCTION_TYPES: Readonly<Record<string, JsSourceFunction>> = {
  arena_parse_verify_begin: { params: ['io', 'u32', 'u32'], result: state },
  arena_source_unit: { params: ['io', 'u32', 'u32'], result: state },
  arena_verify_resume: { params: [state, 'u32'], result: state },
  arena_verify_status: { params: [page], result: 'u32' },
  arena_verify_begin: { params: ['io', page], result: state },
  source_ir_init: { params: ['io', 'u32', 'u32', 'u32'], result: ir },
  source_ir_symbol: { params: [ir, 'u32', 'u32'], result: irResult },
  source_ir_type: { params: [ir, 'u32', 'u32', 'u32', 'u32'], result: irResult },
};

/** Comparison descends only through the finite expected ABI, including for malformed metadata. */
function sameType(actual: Type | undefined, expected: Type): boolean {
  if (typeof expected === 'string') return actual === expected;
  if (actual === null || typeof actual !== 'object' || actual.kind !== expected.kind) return false;
  if (expected.kind === 'arr')
    return (
      actual.kind === 'arr' &&
      actual.length === expected.length &&
      sameType(actual.elem, expected.elem)
    );
  return (
    actual.kind === 'rec' &&
    Array.isArray(actual.fields) &&
    actual.fields.length === expected.fields.length &&
    expected.fields.every((field, i) => sameType(actual.fields[i], field))
  );
}
function words(type: Type): number {
  if (typeof type === 'string') return 1;
  return type.kind === 'arr'
    ? type.length * words(type.elem)
    : type.fields.reduce((n, field) => n + words(field), 0);
}
function u32(value: unknown): number {
  if (typeof value !== 'number' || value >>> 0 !== value)
    throw new Error('invalid JS frontend u32 ABI');
  return value;
}

/** memoryBytes reports retained Wasm buffers only; JS heap/JIT/GC costs require process metrics. */
export function jsSource(
  artifact: JsSourceArtifact,
  diagnostics?: NativeDiagnosticOptions,
): ReturnType<typeof nativeSourceApi> {
  const names = Object.keys(JS_SOURCE_FUNCTION_TYPES).sort();
  if (JSON.stringify(Object.keys(artifact.functions).sort()) !== JSON.stringify(names))
    throw new Error('invalid JS frontend function inventory');
  for (const name of names) {
    const expected = JS_SOURCE_FUNCTION_TYPES[name] as JsSourceFunction;
    const actual = artifact.functions[name];
    const callee = artifact.frontend[name];
    if (
      !actual ||
      !Array.isArray(actual.params) ||
      actual.params.length !== expected.params.length ||
      !expected.params.every((type, i) => sameType(actual.params[i], type)) ||
      !sameType(actual.result, expected.result) ||
      typeof callee !== 'function' ||
      callee.length !== expected.params.length
    )
      throw new Error(`invalid JS frontend ABI: ${name}`);
  }
  const factory = artifact.frontend.a0_make_host_io;
  if (typeof factory !== 'function')
    throw new Error('JS frontend requires host word IO capability');
  const arena = sourceArena(artifact.arena);
  let tokenWord = 0;
  let token: unknown;
  const io = (word: number): unknown => {
    if (!word) throw new Error('invalid JS frontend arena token');
    if (word !== tokenWord) {
      const created = factory(
        () => arena.a0_runtime_read(word) >>> 0,
        (value: number) => arena.a0_runtime_write(word, value),
      );
      token = created;
      tokenWord = word;
    }
    return token;
  };
  const invoke = (name: string, args: readonly (number | Uint32Array)[]): number | Uint32Array => {
    const signature = JS_SOURCE_FUNCTION_TYPES[name];
    const callee = artifact.frontend[name];
    if (!signature || typeof callee !== 'function' || args.length !== signature.params.length)
      throw new Error('invalid JS frontend call ABI');
    const pack = (type: Type, input: Uint32Array, cursor: { at: number }): unknown => {
      if (type === 'io') return io(input[cursor.at++] as number);
      if (type === 'u32') return u32(input[cursor.at++]);
      if (type === 'bool') {
        const word = u32(input[cursor.at++]);
        if (word > 1) throw new Error('invalid JS frontend bool ABI');
        return word === 1;
      }
      if (type.kind === 'arr' && type.elem === 'u32') {
        const at = cursor.at;
        cursor.at += type.length;
        return input.subarray(at, cursor.at);
      }
      if (type.kind === 'arr' && type.elem === 'bool') {
        const values = Array.from({ length: type.length }, () => pack('bool', input, cursor));
        return Uint8Array.from(values, (value) => (value ? 1 : 0));
      }
      return type.kind === 'arr'
        ? Array.from({ length: type.length }, () => pack(type.elem, input, cursor))
        : type.fields.map((field) => pack(field, input, cursor));
    };
    const params = signature.params.map((type, i) => {
      const arg = args[i];
      const input = typeof arg === 'number' ? Uint32Array.of(u32(arg)) : arg;
      if (!(input instanceof Uint32Array) || input.length !== words(type))
        throw new Error('invalid JS frontend parameter ABI');
      return pack(type, input, { at: 0 });
    });
    const value = callee(...params);
    const output = new Uint32Array(words(signature.result));
    const cursor = { at: 0 };
    const unpack = (type: Type, result: unknown): void => {
      if (type === 'io') {
        if (result !== token) throw new Error('JS frontend changed arena token');
        output[cursor.at++] = tokenWord;
      } else if (type === 'u32') output[cursor.at++] = u32(result);
      else if (type === 'bool') {
        if (typeof result !== 'boolean') throw new Error('invalid JS frontend bool ABI');
        output[cursor.at++] = result ? 1 : 0;
      } else if (type.kind === 'arr' && type.elem === 'u32') {
        if (!(result instanceof Uint32Array) || result.length !== type.length)
          throw new Error('invalid JS frontend array ABI');
        output.set(result, cursor.at);
        cursor.at += type.length;
      } else {
        if (
          (!Array.isArray(result) && !(result instanceof Uint8Array)) ||
          result.length !== (type.kind === 'arr' ? type.length : type.fields.length)
        )
          throw new Error('invalid JS frontend aggregate ABI');
        if (type.kind === 'arr')
          for (const item of result)
            unpack(
              type.elem,
              type.elem === 'bool' && result instanceof Uint8Array ? item === 1 : item,
            );
        else
          type.fields.forEach((field, i) => {
            unpack(field, result[i]);
          });
      }
    };
    unpack(signature.result, value);
    return typeof signature.result === 'string' ? (output[0] as number) : output;
  };
  return compiledSource(arena, invoke, () => 0, diagnostics);
}
