/** Portable host for the candidate A0 frontend. Parsing, typing and specs execute in A0. */
import type { Comments, Profile, Program, TypedProgram } from './core.js';
import type { SourceUnitComments } from './source-metadata.js';
import type { NativeAuthoringAvailability } from './source-native-authoring.js';
import {
  composeNativeUnits,
  type NativeIrBuilder,
  type NativeUnitOrigin,
  type NativeUnitSnapshot,
  PARSED_VECTOR_WIDTHS,
  SPEC_VECTOR_WIDTHS,
} from './source-native-compose.js';
import {
  type NativeFormatOptions,
  type NativeFormatRequest,
  type NativeFormatResult,
  type NativeRevisionRequest,
  type NativeRevisionResult,
  nativeSourceFormatter,
} from './source-native-format.js';
import { decodeNativeSource, decodeNativeUnit } from './source-native-ir.js';
import { encodeNativeProgram, restoreNativeProgramMetadata } from './source-native-program.js';
import {
  type NativeDiagnosticOptions,
  type NativeDiagnosticPorts,
  type NativeLiveDiagnostic,
  nativeDiagnosticRenderer,
} from './source-native-render.js';
import { losslessSourceString } from './source-utf8.js';
import { readWasmWord, readWasmWords, writeWasmWord, writeWasmWords } from './wasm-words.js';

const OFFSETS = [
  32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 68, 71, 74, 97, 100, 103, 106, 115, 118, 121, 124,
];
export interface NativeApi extends NativeDiagnosticPorts {
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
  frontend_status(): number;
  frontend_ir_init(pointer: number, length: number, budget: number, strict: number): number;
  frontend_ir_upload(pointer: number, count: number): number;
  frontend_ir_symbol(handle: number, length: number): number;
  frontend_ir_type(kind: number, a: number, b: number, fields: number): number;
  frontend_ir_state(): number;
  frontend_ir_value(): number;
  frontend_ir_finish(): number;
  frontend_close(): void;
}
interface NativeState {
  readonly status: number;
  readonly state: readonly number[];
  readonly specState: readonly number[];
}
export type NativeSourceResult =
  | (NativeState & { readonly ok: false; readonly diagnostic?: NativeLiveDiagnostic })
  | (NativeState & { readonly ok: true; readonly program: Program; readonly typed: TypedProgram });
export type NativeUnitResult =
  | (NativeState & { readonly ok: false; readonly diagnostic?: NativeLiveDiagnostic })
  | (NativeState & { readonly ok: true; readonly program: Program });

export type NativeGraphResult = NativeSourceResult & {
  readonly origins: readonly NativeUnitOrigin[];
};

class NativeIrFailure extends Error {
  constructor(readonly status: number) {
    super(`native IR construction failed: ${status}`);
  }
}
const cloneComments = (comments: Comments): Comments => ({
  ...comments,
  ...(comments.leading === undefined ? {} : { leading: [...comments.leading] }),
});
function commentSnapshot(program: Program): SourceUnitComments {
  return {
    ...(program.profileComments === undefined
      ? {}
      : { profileComments: cloneComments(program.profileComments) }),
    ...(program.useComments === undefined
      ? {}
      : {
          useComments: program.useComments.map((comments) =>
            comments === undefined ? undefined : cloneComments(comments),
          ),
        }),
    ...(program.tailComments === undefined ? {} : { tailComments: [...program.tailComments] }),
    functions: program.functions.map((fn) => ({
      ...(fn.comments === undefined ? {} : { comments: cloneComments(fn.comments) }),
      ...(fn.afterComments === undefined ? {} : { afterComments: [...fn.afterComments] }),
    })),
  };
}

export function nativeSource(
  module: WebAssembly.Module,
  diagnostics?: NativeDiagnosticOptions,
  formatting?: NativeFormatOptions,
): {
  readonly memoryBytes: number;
  parse(source: string, budget?: number): NativeSourceResult;
  parseUnit(source: string, budget?: number): NativeUnitResult;
  /** Experimental compiler IR check through the same A0 checker; locations are synthetic. */
  checkProgram(program: Program, budget?: number): NativeSourceResult;
  /** Units must already be resolved, ordered and assigned a coherent profile by the graph loader. */
  checkUnits(
    units: readonly NativeUnitResult[],
    profile: Profile,
    budget?: number,
  ): NativeGraphResult;
  /** Formatting uses only this engine's current live result; output is detached. */
  format(
    result: NativeSourceResult | NativeUnitResult,
    request?: NativeFormatRequest,
  ): NativeFormatResult;
  /** Content/semantic hashes retain the established private revision serialization. */
  revision(
    result: NativeSourceResult | NativeUnitResult,
    request?: NativeRevisionRequest,
  ): NativeRevisionResult;
  close(): void;
} {
  if (WebAssembly.Module.imports(module).length)
    throw new Error('source frontend must be import-free');
  const api = new WebAssembly.Instance(module).exports as unknown as NativeApi;
  return nativeSourceApi(api, undefined, diagnostics, formatting);
}

/** Internal transport boundary shared by compiled backends of the same A0 frontend. */
export function nativeSourceApi(
  api: NativeApi,
  retainedMemoryBytes: () => number = () => api.memory.buffer.byteLength,
  diagnostics?: NativeDiagnosticOptions,
  formatting?: NativeFormatOptions,
): ReturnType<typeof nativeSource> {
  if (typeof api.frontend_abi !== 'function' || api.frontend_abi() !== 3)
    throw new Error('unsupported source frontend ABI');
  let closed = false;
  const renderer =
    diagnostics === undefined ? undefined : nativeDiagnosticRenderer(api, diagnostics);
  const formatter = formatting === undefined ? undefined : nativeSourceFormatter(api, formatting);
  let generation = 0;
  let authoring: NativeAuthoringAvailability = {};
  let formatStates = new WeakMap<
    object,
    {
      generation: number;
      sourceStatus: number;
      parsed: Uint32Array;
      specs: Uint32Array;
      authoring: NativeAuthoringAvailability;
    }
  >();
  const remember = <T extends NativeState>(result: T): T => {
    if (formatter)
      formatStates.set(result, {
        generation,
        sourceStatus: result.status,
        authoring: { ...authoring },
        parsed: Uint32Array.from(result.state),
        specs: Uint32Array.from(result.specState),
      });
    return result;
  };
  let snapshots = new WeakMap<NativeUnitResult, NativeUnitSnapshot>();
  const assertOpen = (): void => {
    if (closed) throw new Error('source frontend is closed');
  };
  const checkBudget = (budget: number): void => {
    assertOpen();
    if (!Number.isInteger(budget) || budget < 0 || budget > 0xffff_ffff)
      throw new Error('invalid source frontend allocation budget');
  };
  const page = (pointer: number): number[] =>
    Array.from(readWasmWords(api.memory.buffer, pointer, 128));
  const view = (handle: number, count?: number): Uint32Array => {
    const pointer = api.frontend_view(handle),
      length = api.frontend_view_length(handle);
    const n = count ?? length;
    if (!Number.isSafeInteger(n) || n < 0 || n > length || (!pointer && n))
      throw new Error('invalid source frontend storage view');
    return readWasmWords(api.memory.buffer, pointer, n);
  };
  const readResult = (status: number) => {
    const state = page(api.frontend_state()),
      specState = page(api.frontend_specs());
    if (status !== 0)
      return {
        ok: false as const,
        status,
        state,
        specState,
        ...(renderer === undefined ? {} : { diagnostic: renderer.snapshot(state) }),
      };
    const tables = new Map(
      OFFSETS.map((offset) => [offset, view(state[offset] as number, state[offset + 1] as number)]),
    );
    const specTables = new Map(
      SPEC_VECTOR_WIDTHS.map(([offset]) => [
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
  const withSource = (source: string, action: (pointer: number, length: number) => number) => {
    const bytes = new TextEncoder().encode(losslessSourceString(source)),
      pointer = api.malloc(bytes.length || 1);
    if (!pointer) throw new Error('source frontend host allocation failed');
    try {
      new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
      return { value: action(pointer, bytes.length), byteLength: bytes.length };
    } finally {
      api.free(pointer);
    }
  };
  const readSource = (source: string, budget: number, unit: boolean) => {
    checkBudget(budget);
    const result = withSource(source, (pointer, length) => {
      generation++;
      authoring = {};
      return unit
        ? api.frontend_parse_unit(pointer, length, budget)
        : api.frontend_parse(pointer, length, budget);
    });
    return { ...readResult(result.value), byteLength: result.byteLength };
  };
  const checked = (status: number): void => {
    if (status !== 0) throw new NativeIrFailure(status);
  };
  const upload = (words: Uint32Array): number => {
    if (!words.length) return 0;
    const pointer = api.malloc(words.byteLength);
    if (!pointer) throw new NativeIrFailure(4);
    try {
      writeWasmWords(api.memory.buffer, pointer, words);
      const handle = api.frontend_ir_upload(pointer, words.length);
      if (!handle) {
        const status = api.frontend_status();
        if (!status) throw new Error('native IR upload returned an empty handle');
        throw new NativeIrFailure(status);
      }
      return handle;
    } finally {
      api.free(pointer);
    }
  };
  const builderPointer = (): number => {
    const pointer = api.frontend_ir_state();
    if (!pointer) throw new Error('native IR builder is not active');
    return pointer;
  };
  const irBuilder = (budget: number): NativeIrBuilder => ({
    initialize(source, strict) {
      checked(
        withSource(source, (pointer, length) => {
          generation++;
          authoring = {};
          return api.frontend_ir_init(pointer, length, budget, strict ? 1 : 0);
        }).value,
      );
    },
    upload,
    ...(formatter === undefined
      ? {}
      : {
          authoring(value: NativeAuthoringAvailability) {
            authoring = { ...value };
          },
        }),
    symbol(name) {
      const bytes = new TextEncoder().encode(name),
        // Empty identities still need a valid zero-length span for native classification.
        handle = upload(bytes.length ? Uint32Array.from(bytes) : new Uint32Array(1));
      checked(api.frontend_ir_symbol(handle, bytes.length));
      return api.frontend_ir_value();
    },
    type(kind, a, b, fields) {
      const handle = upload(fields);
      checked(api.frontend_ir_type(kind, a, b, handle));
      return api.frontend_ir_value();
    },
    get(index) {
      return readWasmWord(api.memory.buffer, builderPointer() + index * 4);
    },
    set(index, value) {
      writeWasmWord(api.memory.buffer, builderPointer() + index * 4, value);
    },
  });
  const irFailure = (error: unknown) => {
    if (!(error instanceof NativeIrFailure)) throw error;
    const pointer = api.frontend_ir_state(),
      state = pointer ? page(pointer) : Array<number>(128).fill(0);
    state[0] = error.status;
    return {
      ok: false as const,
      status: error.status,
      state,
      specState: Array<number>(128).fill(0),
      ...(renderer === undefined
        ? {}
        : {
            diagnostic: {
              rendered: {
                ok: false as const,
                reason: 'incomplete-ir' as const,
              },
            },
          }),
    };
  };
  return {
    get memoryBytes() {
      return retainedMemoryBytes() + (renderer?.memoryBytes ?? 0) + (formatter?.memoryBytes ?? 0);
    },
    parse(source, budget = 16_000_000) {
      const result = readSource(source, budget, false);
      if (!result.ok) return remember(result);
      const { byteLength: _bytes, tables, specTables, symbols, ...state } = result;
      return remember({
        ...state,
        ...decodeNativeSource(state.state, tables, symbols, source, specTables),
      });
    },
    parseUnit(source, budget = 16_000_000) {
      const result = readSource(source, budget, true);
      if (!result.ok) return remember(result);
      const { byteLength, tables, specTables, symbols, ...state } = result;
      const program = decodeNativeUnit(state.state, tables, symbols, source, specTables);
      const parsed = { ...state, program };
      snapshots.set(parsed, {
        source,
        byteLength,
        symbols,
        tables: new Map(
          PARSED_VECTOR_WIDTHS.map(([slot]) => [
            slot,
            Uint32Array.from(tables.get(slot) as Uint32Array),
          ]),
        ),
        specs: new Map(
          SPEC_VECTOR_WIDTHS.map(([slot]) => [
            slot,
            Uint32Array.from(specTables.get(slot) as Uint32Array),
          ]),
        ),
        typeRows: Uint32Array.from(tables.get(68) as Uint32Array),
        typeFields: Uint32Array.from(tables.get(71) as Uint32Array),
        comments: commentSnapshot(program),
        ...(formatter === undefined
          ? {}
          : {
              metadata: {
                profileLine: state.state[24] as number,
                tailFirst: state.state[25] as number,
                tailCount: state.state[26] as number,
              },
            }),
      });
      return remember(parsed);
    },
    checkProgram(program, budget = 16_000_000) {
      checkBudget(budget);
      try {
        const source = encodeNativeProgram(program, irBuilder(budget));
        const result = readResult(api.frontend_ir_finish());
        if (!result.ok) return remember(result);
        const { tables, specTables, symbols, ...state } = result;
        const decoded = decodeNativeSource(state.state, tables, symbols, source, specTables);
        return remember({ ...state, ...restoreNativeProgramMetadata(decoded, program) });
      } catch (error) {
        return remember(irFailure(error));
      }
    },
    checkUnits(units, profile, budget = 16_000_000) {
      checkBudget(budget);
      if (profile !== 'canonical' && profile !== 'strict')
        throw new Error('invalid source-unit profile');
      const inputs = units.map((unit) => {
        const snapshot = snapshots.get(unit);
        if (!unit.ok || snapshot === undefined)
          throw new Error('expected a parsed unit owned by this frontend');
        return snapshot;
      });
      try {
        const composition = composeNativeUnits(inputs, irBuilder(budget), profile === 'strict');
        const result = readResult(api.frontend_ir_finish());
        if (!result.ok) return remember({ ...result, origins: composition.origins });
        const { tables, specTables, symbols, ...state } = result;
        return remember({
          ...state,
          origins: composition.origins,
          ...decodeNativeSource(
            state.state,
            tables,
            symbols,
            composition.source,
            specTables,
            composition.comments,
          ),
        });
      } catch (error) {
        return remember({
          ...irFailure(error),
          origins: [],
        });
      }
    },
    format(result, request) {
      assertOpen();
      if (!formatter) return { ok: false, reason: 'unavailable' };
      const state = formatStates.get(result);
      if (!state || state.generation !== generation)
        throw new Error('expected a current result owned by this frontend');
      if (state.parsed[93] === 0)
        return { ok: false, reason: 'incomplete-ir', sourceStatus: state.sourceStatus };
      const detail =
        state.authoring.text ??
        ((request?.scope ?? 'source') === 'source' ? state.authoring.source : undefined);
      if (state.sourceStatus === 0 && detail !== undefined)
        return { ok: false, reason: 'authoring-metadata', detail };
      return formatter.format(state.parsed, state.specs, request);
    },
    revision(result, request) {
      assertOpen();
      if (!formatter) return { ok: false, reason: 'unavailable' };
      const state = formatStates.get(result);
      if (!state || state.generation !== generation)
        throw new Error('expected a current result owned by this frontend');
      if (state.parsed[93] === 0)
        return { ok: false, reason: 'incomplete-ir', sourceStatus: state.sourceStatus };
      if (state.sourceStatus === 0 && state.authoring.text !== undefined)
        return { ok: false, reason: 'authoring-metadata', detail: state.authoring.text };
      return formatter.revision(state.parsed, state.specs, request);
    },
    close() {
      if (!closed) api.frontend_close();
      closed = true;
      snapshots = new WeakMap();
      formatStates = new WeakMap();
    },
  };
}
