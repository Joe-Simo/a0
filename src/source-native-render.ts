/** Optional failure-only transport to the existing A0 diagnostic renderer. */

import { sourceComponent, sourceComponentVector } from './source-component.js';
import {
  type NativeDiagnosticPacket,
  type NativeDiagnosticResult,
  nativeDiagnostic,
} from './source-native-diagnostic.js';
import { readWasmWords } from './wasm-words.js';

export interface NativeDiagnosticOptions {
  /** Synchronous and lazy: called only when a failed live arena can be rendered. */
  readonly load: () => WebAssembly.Module;
  /** Existing A0 renderer options: 0 disables new fixes; 1 enables them. */
  readonly options?: number;
  /** Verified companion capability; forwards all six native pages without interpreting them. */
  readonly verification?: true;
}
export interface NativeDiagnosticPorts {
  readonly memory: WebAssembly.Memory;
  a0_runtime_read?(token: number): number;
  a0_runtime_write?(token: number, word: number): void;
  frontend_arena_token?(): number;
  frontend_view(handle: number): number;
  frontend_view_length(handle: number): number;
  frontend_verification?(): number;
}
export type NativeLiveDiagnostic =
  | { readonly packet: NativeDiagnosticPacket; readonly rendered: NativeDiagnosticResult }
  | {
      readonly rendered: {
        readonly ok: false;
        readonly reason: 'unavailable' | 'no-arena' | 'incomplete-ir';
      };
    };

const PAGE_WORDS = 128;
// Result: (status, (handle,length,capacity), facts[128], io).
const RESULT_WORDS = 1 + 3 + PAGE_WORDS + 1;

export function nativeDiagnosticRenderer(
  ports: NativeDiagnosticPorts,
  options: NativeDiagnosticOptions,
) {
  const bits = options.options ?? 1;
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffff_ffff)
    throw new Error('invalid native diagnostic options');
  const component = sourceComponent(ports, options.load, {
    arena_diagnostic_options: { params: [1, PAGE_WORDS, 1], result: RESULT_WORDS },
    ...(options.verification
      ? {
          arena_verified_diagnostic_options: {
            params: [1, ...Array<number>(6).fill(PAGE_WORDS), 1],
            result: RESULT_WORDS,
          },
        }
      : {}),
  });
  return {
    get memoryBytes(): number {
      return component.memoryBytes;
    },
    snapshot(parsed: readonly number[]): NativeLiveDiagnostic {
      if (!ports.a0_runtime_read || !ports.a0_runtime_write || !ports.frontend_arena_token)
        return { rendered: { ok: false, reason: 'unavailable' } };
      const token = ports.frontend_arena_token() >>> 0;
      if (!token) return { rendered: { ok: false, reason: 'no-arena' } };
      if (parsed.length !== PAGE_WORDS) throw new Error('invalid native diagnostic state');
      let result: Uint32Array;
      if (options.verification && ports.frontend_verification) {
        const pointer = ports.frontend_verification();
        if (!pointer) return { rendered: { ok: false, reason: 'incomplete-ir' } };
        const words = Uint32Array.from(readWasmWords(ports.memory.buffer, pointer, 6 * PAGE_WORDS));
        if (parsed.some((value, index) => value !== words[PAGE_WORDS + index]))
          throw new Error('native diagnostic verification snapshot differs');
        result = component.invoke('arena_verified_diagnostic_options', [
          token,
          ...Array.from({ length: 6 }, (_, index) =>
            words.subarray(index * PAGE_WORDS, (index + 1) * PAGE_WORDS),
          ),
          bits,
        ]);
      } else {
        result = component.invoke('arena_diagnostic_options', [
          token,
          Uint32Array.from(parsed),
          bits,
        ]);
      }
      if (result[RESULT_WORDS - 1] !== token)
        throw new Error('native diagnostic renderer changed arena token');
      const status = result[0] as number,
        handle = result[1] as number,
        length = result[2] as number,
        capacity = result[3] as number;
      if (length > capacity || (status !== 0 && (handle || length || capacity)))
        throw new Error('invalid native diagnostic renderer vector');
      let json = new Uint8Array();
      if (status === 0) {
        if (!handle || !length) throw new Error('invalid native diagnostic renderer storage');
        const bytes = sourceComponentVector(ports, handle, length, capacity);
        if (bytes.some((value) => value > 255))
          throw new Error('invalid native diagnostic JSON byte');
        json = Uint8Array.from(bytes);
      }
      const packet = { status, facts: Array.from(result.subarray(4, 4 + PAGE_WORDS)), json };
      return { packet, rendered: nativeDiagnostic(packet) };
    },
  };
}
