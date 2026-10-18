/** Transport adapter for the same A0 frontend compiled by the direct Wasm backend. */
import { type NativeApi, nativeSourceApi } from './source-native.js';
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

interface ArenaApi {
  readonly memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(pointer: number): void;
  a0_arena_create(words: number, output: number): number;
  a0_arena_destroy(session: number): void;
  a0_runtime_read(session: number): number;
  a0_runtime_write(session: number, word: number): void;
  a0_memory_view(session: number, handle: number): number;
  a0_memory_view_length(session: number, handle: number): number;
}
const PAGE_WORDS = 128;
const STATE_WORDS = 6 * PAGE_WORDS + 1;
const IR_WORDS = PAGE_WORDS + 1;
const REQUIRED: Readonly<Record<string, readonly number[]>> = {
  arena_parse_verify_begin: [1, 1, 1, STATE_WORDS],
  arena_source_unit: [1, 1, 1, STATE_WORDS],
  arena_verify_resume: [STATE_WORDS, 1, STATE_WORDS],
  arena_verify_status: [PAGE_WORDS, 1],
  arena_verify_begin: [1, PAGE_WORDS, STATE_WORDS],
  source_ir_init: [1, 1, 1, 1, IR_WORDS],
  source_ir_symbol: [IR_WORDS, 1, 1, IR_WORDS + 1],
  source_ir_type: [IR_WORDS, 1, 1, 1, 1, IR_WORDS + 1],
};

export function directSource(artifact: DirectSourceArtifact): ReturnType<typeof nativeSourceApi> {
  if (WebAssembly.Module.imports(artifact.arena).length)
    throw new Error('generic arena module must be import-free');
  const arena = new WebAssembly.Instance(artifact.arena).exports as unknown as ArenaApi;
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
  for (const [name, expected] of Object.entries(REQUIRED)) {
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
  const aggregate = (name: string, args: readonly (number | Uint32Array)[]): Uint32Array => {
    const out = invoke(name, args);
    if (typeof out === 'number') throw new Error('direct aggregate result ABI');
    return out;
  };
  const scalar = (name: string, args: readonly (number | Uint32Array)[]): number => {
    const out = invoke(name, args);
    if (typeof out !== 'number') throw new Error('direct scalar result ABI');
    return out;
  };
  const pages = arena.malloc(3 * PAGE_WORDS * 4) >>> 0;
  if (!pages) throw new Error('direct frontend view allocation failed');
  const parsedPointer = pages,
    specPointer = pages + PAGE_WORDS * 4,
    irPointer = pages + 2 * PAGE_WORDS * 4;
  let session = 0,
    status = 0,
    irValue = 0,
    active = false;
  let state: Uint32Array = new Uint32Array(STATE_WORDS),
    irState: Uint32Array = new Uint32Array(IR_WORDS);
  const reply = (expected: number): number => {
    const code = arena.a0_runtime_read(session) >>> 0;
    const count = arena.a0_runtime_read(session) >>> 0;
    return code || (count === expected ? 0 : 5);
  };
  const send = (op: number, args: readonly number[]): void => {
    arena.a0_runtime_write(session, op);
    arena.a0_runtime_write(session, args.length);
    for (const value of args) arena.a0_runtime_write(session, value);
  };
  const reset = (): void => {
    if (session) arena.a0_arena_destroy(session);
    session = status = irValue = 0;
    active = false;
    state.fill(0);
    irState.fill(0);
    writeWasmWords(arena.memory.buffer, irPointer, irState.subarray(0, PAGE_WORDS));
  };
  const start = (budget: number): number => {
    reset();
    session = arena.a0_arena_create(budget, 0) >>> 0;
    if (!session) {
      status = 4;
      return status;
    }
    status = reply(2);
    if (status) return status;
    arena.a0_runtime_read(session);
    arena.a0_runtime_read(session);
    return 0;
  };
  const upload = (pointer: number, count: number, bytes: boolean): number => {
    send(1, [count || 1]);
    status = reply(1);
    if (status) return 0;
    const handle = arena.a0_runtime_read(session) >>> 0;
    const input = bytes
      ? new Uint8Array(arena.memory.buffer, pointer, count)
      : readWasmWords(arena.memory.buffer, pointer, count);
    for (let offset = 0; offset < count; ) {
      const n = Math.min(PAGE_WORDS, count - offset);
      const args = [handle, offset, n];
      for (let i = 0; i < n; i++) args.push(input[offset + i] as number);
      send(3, args);
      status = reply(0);
      if (status) return 0;
      offset += n;
    }
    return handle;
  };
  const finish = (): number => {
    while (state[1] !== 11) state = aggregate('arena_verify_resume', [state, 97]);
    status = scalar('arena_verify_status', [state.slice(0, PAGE_WORDS)]);
    return status;
  };
  const parse = (pointer: number, length: number, budget: number, unit: boolean): number => {
    if (start(budget)) return status;
    const handle = upload(pointer, length, true);
    if (!handle) return status;
    state = aggregate(unit ? 'arena_source_unit' : 'arena_parse_verify_begin', [
      session,
      handle,
      length,
    ]);
    return finish();
  };
  const currentIr = (): Uint32Array => {
    irState.set(readWasmWords(arena.memory.buffer, irPointer, PAGE_WORDS));
    return irState;
  };
  const updateIr = (result: Uint32Array): number => {
    irState.set(result.subarray(0, PAGE_WORDS));
    irState[PAGE_WORDS] = result[PAGE_WORDS + 1] as number;
    irValue = result[PAGE_WORDS] as number;
    writeWasmWords(arena.memory.buffer, irPointer, irState.subarray(0, PAGE_WORDS));
    status = result[0] as number;
    return status;
  };
  const api: NativeApi = {
    memory: arena.memory,
    malloc: (size) => arena.malloc(size) >>> 0,
    free: arena.free,
    frontend_abi: () => 3,
    frontend_parse: (p, n, b) => parse(p, n, b, false),
    frontend_parse_unit: (p, n, b) => parse(p, n, b, true),
    frontend_state() {
      writeWasmWords(
        arena.memory.buffer,
        parsedPointer,
        state.subarray(PAGE_WORDS, 2 * PAGE_WORDS),
      );
      return parsedPointer;
    },
    frontend_specs() {
      writeWasmWords(
        arena.memory.buffer,
        specPointer,
        state.subarray(2 * PAGE_WORDS, 3 * PAGE_WORDS),
      );
      return specPointer;
    },
    frontend_status: () => status,
    frontend_view: (handle) => arena.a0_memory_view(session, handle) >>> 0,
    frontend_view_length: (handle) => arena.a0_memory_view_length(session, handle) >>> 0,
    frontend_ir_init(p, n, budget, strict) {
      if (start(budget)) return status;
      const handle = upload(p, n, true);
      if (!handle) return status;
      irState = aggregate('source_ir_init', [session, handle, n, strict]);
      writeWasmWords(arena.memory.buffer, irPointer, irState.subarray(0, PAGE_WORDS));
      status = irState[0] as number;
      active = status === 0;
      return status;
    },
    frontend_ir_upload(p, n) {
      if (!active) {
        status = 5;
        return 0;
      }
      return upload(p, n, false);
    },
    frontend_ir_symbol(handle, length) {
      if (!active) {
        status = 5;
        return status;
      }
      return updateIr(aggregate('source_ir_symbol', [currentIr(), handle, length]));
    },
    frontend_ir_type(kind, a, b, fields) {
      if (!active) {
        status = 5;
        return status;
      }
      return updateIr(aggregate('source_ir_type', [currentIr(), kind, a, b, fields]));
    },
    frontend_ir_state: () => (active ? irPointer : 0),
    frontend_ir_value: () => irValue,
    frontend_ir_finish() {
      if (!active) {
        status = 5;
        return status;
      }
      const input = currentIr();
      active = false;
      state = aggregate('arena_verify_begin', [
        input[PAGE_WORDS] as number,
        input.slice(0, PAGE_WORDS),
      ]);
      return finish();
    },
    frontend_close() {
      reset();
      arena.free(pages);
    },
  };
  return nativeSourceApi(api, () => arena.memory.buffer.byteLength + memory.buffer.byteLength);
}
