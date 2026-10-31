/** Optional formatting/revision capability implemented only by the shared A0 emitters. */
import { sourceComponent, sourceComponentVector } from './source-component.js';
import type {
  NativeSourceMetadataIssue,
  NativeTextMetadataIssue,
} from './source-native-authoring.js';
import type { NativeDiagnosticPorts } from './source-native-render.js';
import { decodeSourceUtf8 } from './source-utf8.js';

export interface NativeFormatOptions {
  /** Synchronous and lazy: the existing A0 formatter/revision companion module. */
  readonly load: () => WebAssembly.Module;
}
export interface NativeFormatRequest {
  /** Signature emits one complete declared header, without a body or source comments. */
  readonly scope?: 'function' | 'program' | 'source' | 'signature';
  readonly functionIndex?: number;
  readonly skipSpecs?: boolean;
  readonly mapping?: boolean;
}
export interface NativeRevisionRequest {
  readonly kind?: 'function' | 'program' | 'semantic';
  readonly functionIndex?: number;
}
export type NativeCapabilityRefusal =
  | { readonly ok: false; readonly reason: 'unavailable' | 'no-arena' }
  | {
      readonly ok: false;
      readonly reason: 'authoring-metadata';
      readonly detail:
        | NativeSourceMetadataIssue
        | NativeTextMetadataIssue
        | 'unsupported-authoring-version';
    }
  | {
      readonly ok: false;
      readonly reason: 'incomplete-ir';
      /** The frontend failed before a complete schema1 state could be supplied to A0. */
      readonly sourceStatus: number;
    };
export type NativeFormatResult =
  | NativeCapabilityRefusal
  | { readonly ok: false; readonly status: number; readonly facts: readonly number[] }
  | {
      readonly ok: true;
      readonly status: 0;
      readonly text: string;
      readonly bytes: Uint8Array;
      /** A0FT schema1, including the native output/event handles for inspection only. */
      readonly facts: readonly number[];
      /** Detached six-word rows: kind, subject, field, byteStart, byteLength, parent. */
      readonly events: Uint32Array;
    };
export type NativeRevisionResult =
  | NativeCapabilityRefusal
  | { readonly ok: false; readonly status: number }
  | {
      readonly ok: true;
      readonly status: 0;
      readonly revision: string;
      readonly bytes: Uint8Array;
    };

const PAGE = 128;
const FORMAT_WORDS = 1 + 3 + PAGE + 1;
const REVISION_WORDS = 1 + 3 + 1;
const FORMATS = ['function', 'program', 'source', 'signature'] as const;
const REVISIONS = ['function', 'program', 'semantic'] as const;

function functionIndex(value: number | undefined): number {
  const index = value ?? 0;
  if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff)
    throw new Error('invalid native formatter function index');
  return index;
}

export function nativeSourceFormatter(ports: NativeDiagnosticPorts, options: NativeFormatOptions) {
  const component = sourceComponent(ports, options.load, {
    arena_format_described: { params: [1, PAGE, PAGE, 1, 1, 1, 1], result: FORMAT_WORDS },
    arena_revision: { params: [1, PAGE, PAGE, 1, 1], result: REVISION_WORDS },
    arena_format_authoring: {
      params: [1, PAGE, PAGE, PAGE, 1, 1, 1, 1],
      result: FORMAT_WORDS,
      optional: true,
    },
    arena_revision_authoring: {
      params: [1, PAGE, PAGE, PAGE, 1, 1],
      result: REVISION_WORDS,
      optional: true,
    },
  });
  const token = (): number | NativeCapabilityRefusal => {
    if (!ports.a0_runtime_read || !ports.a0_runtime_write || !ports.frontend_arena_token)
      return { ok: false, reason: 'unavailable' };
    const value = ports.frontend_arena_token() >>> 0;
    return value || { ok: false, reason: 'no-arena' };
  };
  const output = (result: Uint32Array, io: number): Uint8Array => {
    if (result[result.length - 1] !== io)
      throw new Error('native source formatter changed arena token');
    const status = result[0] as number;
    const handle = result[1] as number;
    const length = result[2] as number;
    const capacity = result[3] as number;
    if (status !== 0 && (handle || length || capacity))
      throw new Error('failed native source formatter exposed output');
    const words = sourceComponentVector(ports, handle, length, capacity);
    if (words.some((word) => word > 255)) throw new Error('invalid native formatter output byte');
    return Uint8Array.from(words);
  };
  return {
    get memoryBytes(): number {
      return component.memoryBytes;
    },
    format(
      parsed: Uint32Array,
      specs: Uint32Array,
      request: NativeFormatRequest = {},
      authoring?: Uint32Array,
    ): NativeFormatResult {
      const mode = FORMATS.indexOf(request.scope ?? 'source');
      if (mode < 0) throw new Error('invalid native formatter scope');
      if (
        [request.mapping, request.skipSpecs].some(
          (value) => value !== undefined && typeof value !== 'boolean',
        )
      )
        throw new Error('invalid native formatter flag');
      const id = functionIndex(request.functionIndex);
      const io = token();
      if (typeof io !== 'number') return io;
      const context = authoring;
      const name = context ? 'arena_format_authoring' : 'arena_format_described';
      if (context && !component.has(name))
        return { ok: false, reason: 'authoring-metadata', detail: 'unsupported-authoring-version' };
      const result = component.invoke(name, [
        io,
        parsed,
        specs,
        ...(context ? [context] : []),
        mode,
        id,
        request.skipSpecs ? 1 : 0,
        request.mapping ? 1 : 0,
      ]);
      const bytes = output(result, io);
      const status = result[0] as number;
      const facts = Array.from(result.subarray(4, 4 + PAGE));
      if (
        facts[0] !== status ||
        facts[1] !== 0x41304654 ||
        facts[2] !== 1 ||
        facts[9] !== bytes.length ||
        facts[3] !== (request.mapping ? 1 : 0) ||
        facts[10] !== mode ||
        facts[11] !== id ||
        facts[12] !== (request.skipSpecs ? 1 : 0)
      )
        throw new Error('invalid native formatter descriptor');
      if (status !== 0) {
        if (facts[4] || facts[5] || facts[6])
          throw new Error('failed native formatter exposed mapping');
        return { ok: false, status, facts };
      }
      const events = sourceComponentVector(
        ports,
        facts[4] as number,
        facts[5] as number,
        facts[6] as number,
      );
      if (events.length % 6 || (!request.mapping && (facts[4] || facts[5] || facts[6])))
        throw new Error('invalid native formatter mapping extent');
      return { ok: true, status: 0, text: decodeSourceUtf8(bytes), bytes, facts, events };
    },
    revision(
      parsed: Uint32Array,
      specs: Uint32Array,
      request: NativeRevisionRequest = {},
      authoring?: Uint32Array,
    ): NativeRevisionResult {
      const mode = REVISIONS.indexOf(request.kind ?? 'program');
      if (mode < 0) throw new Error('invalid native revision kind');
      const id = functionIndex(request.functionIndex);
      const io = token();
      if (typeof io !== 'number') return io;
      const context = authoring;
      const name = context ? 'arena_revision_authoring' : 'arena_revision';
      if (context && !component.has(name))
        return { ok: false, reason: 'authoring-metadata', detail: 'unsupported-authoring-version' };
      const result = component.invoke(name, [
        io,
        parsed,
        specs,
        ...(context ? [context] : []),
        mode,
        id,
      ]);
      const bytes = output(result, io);
      const status = result[0] as number;
      if (status !== 0) return { ok: false, status };
      const revision = decodeSourceUtf8(bytes);
      if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('invalid native revision output');
      return { ok: true, status: 0, revision, bytes };
    },
  };
}
