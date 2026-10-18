/** Optional failure-only transport to the existing A0 diagnostic renderer. */
import {
  type NativeDiagnosticPacket,
  type NativeDiagnosticResult,
  nativeDiagnostic,
} from './source-native-diagnostic.js';
import { readWasmWords, writeWasmWords } from './wasm-words.js';

export interface NativeDiagnosticOptions {
  /** Synchronous and lazy: called only when a failed live arena can be rendered. */
  readonly load: () => WebAssembly.Module;
  /** Existing A0 renderer options: 0 disables new fixes; 1 enables them. */
  readonly options?: number;
}
export interface NativeDiagnosticPorts {
  readonly memory: WebAssembly.Memory;
  a0_runtime_read?(token: number): number;
  a0_runtime_write?(token: number, word: number): void;
  frontend_arena_token?(): number;
  frontend_view(handle: number): number;
  frontend_view_length(handle: number): number;
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
  let instance: WebAssembly.Instance | undefined;
  let memory: WebAssembly.Memory | undefined;
  let base = 0;
  let render: ((out: number, io: number, parsed: number, options: number) => void) | undefined;
  return {
    get memoryBytes(): number {
      return memory?.buffer.byteLength ?? 0;
    },
    snapshot(parsed: readonly number[]): NativeLiveDiagnostic {
      if (!ports.a0_runtime_read || !ports.a0_runtime_write || !ports.frontend_arena_token)
        return { rendered: { ok: false, reason: 'unavailable' } };
      const token = ports.frontend_arena_token() >>> 0;
      if (!token) return { rendered: { ok: false, reason: 'no-arena' } };
      if (!instance) {
        const module = options.load();
        const imports = WebAssembly.Module.imports(module);
        if (
          imports.length !== 2 ||
          imports.some(
            (entry) =>
              entry.kind !== 'function' ||
              entry.module !== 'a0_arena' ||
              !['a0_runtime_read', 'a0_runtime_write'].includes(entry.name),
          ) ||
          new Set(imports.map((entry) => entry.name)).size !== 2
        )
          throw new Error('invalid native diagnostic renderer imports');
        instance = new WebAssembly.Instance(module, {
          a0_arena: {
            a0_runtime_read: ports.a0_runtime_read,
            a0_runtime_write: ports.a0_runtime_write,
          },
        });
        const exports = instance.exports;
        if (
          !(exports.memory instanceof WebAssembly.Memory) ||
          !(exports.__heap_base instanceof WebAssembly.Global) ||
          typeof exports.a0_arena_diagnostic_options !== 'function' ||
          exports.a0_arena_diagnostic_options.length !== 4
        )
          throw new Error('invalid native diagnostic renderer ABI');
        memory = exports.memory;
        base = Number(exports.__heap_base.value);
        const end = base + (RESULT_WORDS + PAGE_WORDS) * 4;
        if (!Number.isSafeInteger(base) || base < 0 || base % 4 || end > 0x1_0000_0000)
          throw new Error('invalid native diagnostic renderer scratch');
        if (end > memory.buffer.byteLength)
          memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
        render = exports.a0_arena_diagnostic_options as typeof render;
      }
      if (!memory || !render || parsed.length !== PAGE_WORDS)
        throw new Error('invalid native diagnostic state');
      writeWasmWords(memory.buffer, base + RESULT_WORDS * 4, Uint32Array.from(parsed));
      render(base, token, base + RESULT_WORDS * 4, bits);
      const result = readWasmWords(memory.buffer, base, RESULT_WORDS);
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
        const pointer = ports.frontend_view(handle),
          extent = ports.frontend_view_length(handle);
        if (!handle || !pointer || !length || capacity > extent)
          throw new Error('invalid native diagnostic renderer storage');
        const bytes = readWasmWords(ports.memory.buffer, pointer, length);
        if (bytes.some((value) => value > 255))
          throw new Error('invalid native diagnostic JSON byte');
        json = Uint8Array.from(bytes);
      }
      const packet = { status, facts: Array.from(result.subarray(4, 4 + PAGE_WORDS)), json };
      return { packet, rendered: nativeDiagnostic(packet) };
    },
  };
}
