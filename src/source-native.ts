/** Portable host for the candidate A0 frontend. All source parsing, typing and specs execute in A0. */
import type { Program, TypedProgram } from './core.js';
import { decodeNativeSource, decodeNativeUnit } from './source-native-ir.js';

const OFFSETS = [
  32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 68, 71, 74, 97, 100, 103, 106, 115, 118, 121, 124,
];
interface NativeApi {
  memory: WebAssembly.Memory;
  frontend_abi(): number;
  malloc(size: number): number;
  free(pointer: number): void;
  frontend_parse(pointer: number, length: number, budget: number): number;
  frontend_parse_unit(pointer: number, length: number, budget: number): number;
  frontend_state(): number;
  frontend_specs(): number;
  frontend_view(handle: number): number;
  frontend_view_length(handle: number): number;
  frontend_close(): void;
}
interface NativeState {
  readonly status: number;
  readonly state: readonly number[];
  readonly specState: readonly number[];
}
export type NativeSourceResult =
  | (NativeState & { readonly ok: false })
  | (NativeState & { readonly ok: true; readonly program: Program; readonly typed: TypedProgram });

export type NativeUnitResult =
  | (NativeState & { readonly ok: false })
  | (NativeState & { readonly ok: true; readonly program: Program });

export function nativeSource(module: WebAssembly.Module): {
  parse(source: string, budget?: number): NativeSourceResult;
  parseUnit(source: string, budget?: number): NativeUnitResult;
  close(): void;
} {
  if (WebAssembly.Module.imports(module).length)
    throw new Error('source frontend must be import-free');
  const api = new WebAssembly.Instance(module).exports as unknown as NativeApi;
  if (typeof api.frontend_abi !== 'function' || api.frontend_abi() !== 2)
    throw new Error('unsupported source frontend ABI');
  let closed = false;
  const view = (handle: number, count?: number): Uint32Array => {
    const pointer = api.frontend_view(handle),
      length = api.frontend_view_length(handle);
    const n = count ?? length;
    if (!Number.isSafeInteger(n) || n < 0 || n > length || (!pointer && n))
      throw new Error('invalid source frontend storage view');
    return new Uint32Array(api.memory.buffer, pointer, n);
  };
  const readSource = (source: string, budget: number, unit: boolean) => {
    if (closed) throw new Error('source frontend is closed');
    if (!Number.isInteger(budget) || budget < 0 || budget > 0xffff_ffff)
      throw new Error('invalid source frontend allocation budget');
    const bytes = new TextEncoder().encode(source),
      pointer = api.malloc(bytes.length || 1);
    if (!pointer) throw new Error('source frontend host allocation failed');
    let status: number;
    try {
      new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
      status = unit
        ? api.frontend_parse_unit(pointer, bytes.length, budget)
        : api.frontend_parse(pointer, bytes.length, budget);
    } finally {
      api.free(pointer);
    }
    const state = Array.from(new Uint32Array(api.memory.buffer, api.frontend_state(), 128));
    const specState = Array.from(new Uint32Array(api.memory.buffer, api.frontend_specs(), 128));
    if (status !== 0) return { ok: false as const, status, state, specState };
    const tables = new Map(
      OFFSETS.map((offset) => [offset, view(state[offset] as number, state[offset + 1] as number)]),
    );
    const specTables = new Map(
      [32, 35, 38, 41, 44, 47, 50, 62].map((offset) => [
        offset,
        view(specState[offset] as number, specState[offset + 1] as number),
      ]),
    );
    const symbols: string[] = [],
      rows = tables.get(62);
    if (rows === undefined) throw new Error('missing native symbol table');
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    for (let id = 0; id < (state[67] as number); id++) {
      const at = id * 5,
        handle = rows[at],
        start = rows[at + 1],
        length = rows[at + 2];
      if (handle === undefined || start === undefined || length === undefined)
        throw new Error('invalid native symbol row');
      symbols.push(decoder.decode(Uint8Array.from(view(handle, start + length).subarray(start))));
    }
    return { ok: true as const, status, state, specState, tables, specTables, symbols };
  };
  return {
    parse(source, budget = 16_000_000) {
      const result = readSource(source, budget, false);
      if (!result.ok) return result;
      const { tables, specTables, symbols, ...state } = result;
      return { ...state, ...decodeNativeSource(state.state, tables, symbols, source, specTables) };
    },
    parseUnit(source, budget = 16_000_000) {
      const result = readSource(source, budget, true);
      if (!result.ok) return result;
      const { tables, specTables, symbols, ...state } = result;
      return {
        ...state,
        program: decodeNativeUnit(state.state, tables, symbols, source, specTables),
      };
    },
    close() {
      if (!closed) api.frontend_close();
      closed = true;
    },
  };
}
