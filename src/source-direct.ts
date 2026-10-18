/** Transport adapter for the same A0 frontend compiled by the direct Wasm backend. */
import { compiledSource, SOURCE_FUNCTION_WORDS, sourceArena } from './source-compiled.js';
import type { nativeSourceApi } from './source-native.js';
import type { NativeDiagnosticOptions } from './source-native-render.js';
import { readWasmWords, writeWasmWords } from './wasm-words.js';

export interface DirectValue {
  readonly words: number;
  readonly scalar: boolean;
}
export interface DirectFunction {
  readonly params: readonly DirectValue[];
  readonly result: DirectValue;
}
export interface DirectSourceArtifact {
  readonly frontend: WebAssembly.Module;
  readonly arena: WebAssembly.Module;
  readonly functions: Readonly<Record<string, DirectFunction>>;
}

export function directSource(
  artifact: DirectSourceArtifact,
  diagnostics?: NativeDiagnosticOptions,
): ReturnType<typeof nativeSourceApi> {
  const arena = sourceArena(artifact.arena);
  const imports = WebAssembly.Module.imports(artifact.frontend);
  if (
    imports.length !== 2 ||
    imports
      .map((entry) => entry.name)
      .sort()
      .join(',') !== 'a0_runtime_read,a0_runtime_write' ||
    imports.some(
      (entry) =>
        entry.module !== 'a0_arena' ||
        entry.kind !== 'function' ||
        !['a0_runtime_read', 'a0_runtime_write'].includes(entry.name),
    )
  )
    throw new Error('unexpected direct frontend imports');
  const wasm = new WebAssembly.Instance(artifact.frontend, {
    a0_arena: { a0_runtime_read: arena.a0_runtime_read, a0_runtime_write: arena.a0_runtime_write },
  }).exports;
  const memory = wasm.memory;
  const heap = wasm.__heap_base;
  if (!(memory instanceof WebAssembly.Memory) || !(heap instanceof WebAssembly.Global))
    throw new Error('invalid direct frontend memory ABI');
  const heapBase = Number(heap.value);
  let scratchWords = 0;
  for (const [name, expected] of Object.entries(SOURCE_FUNCTION_WORDS)) {
    const fn = artifact.functions[name];
    const callee = wasm[`a0_${name}`];
    if (
      fn === undefined ||
      typeof callee !== 'function' ||
      callee.length !== fn.params.length + (fn.result.scalar ? 0 : 1) ||
      JSON.stringify([...fn.params.map((value) => value.words), fn.result.words]) !==
        JSON.stringify(expected) ||
      [...fn.params, fn.result].some((value) => value.scalar !== (value.words === 1))
    )
      throw new Error(`invalid direct frontend ABI: ${name}`);
    scratchWords = Math.max(
      scratchWords,
      (fn.result.scalar ? 0 : fn.result.words) +
        fn.params.reduce((sum, value) => sum + (value.scalar ? 0 : value.words), 0),
    );
  }
  const end = heapBase + scratchWords * 4;
  if (end > memory.buffer.byteLength)
    memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
  const invoke = (name: string, args: readonly (number | Uint32Array)[]): number | Uint32Array => {
    const fn = artifact.functions[name];
    if (fn === undefined || fn.params.length !== args.length) throw new Error('direct call ABI');
    let next = heapBase + (fn.result.scalar ? 0 : fn.result.words * 4);
    const params = fn.result.scalar ? [] : [heapBase];
    for (let i = 0; i < args.length; i++) {
      const value = args[i];
      const type = fn.params[i];
      if (type === undefined) throw new Error('direct parameter ABI');
      if (type.scalar) {
        if (typeof value !== 'number') throw new Error('direct scalar parameter ABI');
        params.push(value);
      } else {
        if (!(value instanceof Uint32Array) || value.length !== type.words)
          throw new Error('direct aggregate parameter ABI');
        writeWasmWords(memory.buffer, next, value);
        params.push(next);
        next += type.words * 4;
      }
    }
    const callee = wasm[`a0_${name}`] as (...values: number[]) => number;
    const value = callee(...params);
    return fn.result.scalar
      ? value >>> 0
      : Uint32Array.from(readWasmWords(memory.buffer, heapBase, fn.result.words));
  };
  return compiledSource(arena, invoke, () => memory.buffer.byteLength, diagnostics);
}
