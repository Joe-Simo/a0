/** Lazy flat-word Wasm calls over an existing frontend's live arena ports. */
import type { NativeDiagnosticPorts } from './source-native-render.js';
import { readWasmWords, writeWasmWords } from './wasm-words.js';

export interface SourceComponentFunction {
  readonly params: readonly number[];
  readonly result: number;
  readonly optional?: boolean;
}

export function sourceComponent(
  ports: NativeDiagnosticPorts,
  load: () => WebAssembly.Module,
  functions: Readonly<Record<string, SourceComponentFunction>>,
) {
  let memory: WebAssembly.Memory | undefined;
  let exports: WebAssembly.Exports | undefined;
  let base = 0;
  const prepare = (): void => {
    if (exports) return;
    if (!ports.a0_runtime_read || !ports.a0_runtime_write)
      throw new Error('native source component ports unavailable');
    const module = load();
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
      throw new Error('invalid native source component imports');
    const candidate = new WebAssembly.Instance(module, {
      a0_arena: {
        a0_runtime_read: ports.a0_runtime_read,
        a0_runtime_write: ports.a0_runtime_write,
      },
    }).exports;
    if (
      !(candidate.memory instanceof WebAssembly.Memory) ||
      !(candidate.__heap_base instanceof WebAssembly.Global)
    )
      throw new Error('invalid native source component memory ABI');
    let scratch = 0;
    for (const [name, signature] of Object.entries(functions)) {
      const callee = candidate[`a0_${name}`];
      if (callee === undefined && signature.optional) continue;
      if (
        typeof callee !== 'function' ||
        callee.length !== signature.params.length + 1 ||
        [signature.result, ...signature.params].some(
          (words) => !Number.isSafeInteger(words) || words < 1,
        )
      )
        throw new Error(`invalid native source component ABI: ${name}`);
      scratch = Math.max(
        scratch,
        signature.result +
          signature.params.reduce((sum, words) => sum + (words > 1 ? words : 0), 0),
      );
    }
    const heap = Number(candidate.__heap_base.value);
    const end = heap + scratch * 4;
    if (!Number.isSafeInteger(heap) || heap < 0 || heap % 4 || end > 0x1_0000_0000)
      throw new Error('invalid native source component scratch');
    if (end > candidate.memory.buffer.byteLength)
      candidate.memory.grow(Math.ceil((end - candidate.memory.buffer.byteLength) / 65536));
    base = heap;
    memory = candidate.memory;
    exports = candidate;
  };
  return {
    get memoryBytes(): number {
      return memory?.buffer.byteLength ?? 0;
    },
    has(name: string): boolean {
      prepare();
      return typeof exports?.[`a0_${name}`] === 'function';
    },
    invoke(name: string, args: readonly (number | Uint32Array)[]): Uint32Array {
      const signature = functions[name];
      if (!signature || signature.params.length !== args.length)
        throw new Error('invalid native source component call');
      prepare();
      if (!memory || !exports) throw new Error('missing native source component');
      let next = base + signature.result * 4;
      const values = [base];
      for (const [index, words] of signature.params.entries()) {
        const value = args[index];
        if (words === 1) {
          if (
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < 0 ||
            value > 0xffff_ffff
          )
            throw new Error('invalid native source component word');
          values.push(value);
        } else {
          if (!(value instanceof Uint32Array) || value.length !== words)
            throw new Error('invalid native source component aggregate');
          writeWasmWords(memory.buffer, next, value);
          values.push(next);
          next += words * 4;
        }
      }
      const callee = exports[`a0_${name}`] as (...params: number[]) => void;
      callee(...values);
      return Uint32Array.from(readWasmWords(memory.buffer, base, signature.result));
    },
  };
}

/** Detach an arena vector before the owning frontend can reset or close its session. */
export function sourceComponentVector(
  ports: NativeDiagnosticPorts,
  handle: number,
  length: number,
  capacity: number,
): Uint32Array {
  if (length > capacity || (!handle && capacity))
    throw new Error('invalid native source component vector');
  if (!handle) return new Uint32Array();
  const pointer = ports.frontend_view(handle);
  const extent = ports.frontend_view_length(handle);
  if ((!pointer && capacity) || capacity > extent)
    throw new Error('invalid native source component storage');
  return Uint32Array.from(readWasmWords(ports.memory.buffer, pointer, length));
}
