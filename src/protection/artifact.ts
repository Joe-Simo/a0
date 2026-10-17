/** Wasm release adapter: no source crypto or key dependency. */
import { ProtectionError } from './errors.js';

const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface ProtectedArtifact {
  readonly bytes: Uint8Array;
  readonly privateDebug: readonly { readonly name: string; readonly section: Uint8Array }[];
  readonly level: 'artifact-hygiene';
}
/** Unknown custom sections (including licenses), exports, data and strict diagnostics are preserved. */
export function protectWasm(bytes: Uint8Array): ProtectedArtifact {
  if (!WebAssembly.validate(bytes as BufferSource)) throw new ProtectionError('INVALID_WASM');
  const out: Uint8Array[] = [bytes.slice(0, 8)];
  const privateDebug: { name: string; section: Uint8Array }[] = [];
  let at = 8;
  const leb = (): number => {
    let n = 0;
    let shift = 0;
    for (let k = 0; k < 5; k++) {
      const b = bytes[at++];
      if (b === undefined) throw new ProtectionError('INVALID_WASM');
      n += (b & 127) * 2 ** shift;
      if ((b & 128) === 0) return n;
      shift += 7;
    }
    throw new ProtectionError('INVALID_WASM');
  };
  while (at < bytes.length) {
    const start = at;
    const id = bytes[at++];
    const size = leb();
    const end = at + size;
    if (end > bytes.length) throw new ProtectionError('INVALID_WASM');
    if (id === 0) {
      const length = leb();
      if (at + length > end) throw new ProtectionError('INVALID_WASM');
      const name = text.decode(bytes.subarray(at, at + length));
      if (
        name === 'name' ||
        name.startsWith('.debug_') ||
        name === 'sourceMappingURL' ||
        name === 'external_debug_info'
      )
        privateDebug.push({ name, section: bytes.slice(start, end) });
      else out.push(bytes.slice(start, end));
    } else out.push(bytes.slice(start, end));
    at = end;
  }
  const release = new Uint8Array(out.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of out) {
    release.set(part, offset);
    offset += part.length;
  }
  if (!WebAssembly.validate(release as BufferSource))
    throw new ProtectionError('INVALID_PROTECTED_WASM');
  return { bytes: release, privateDebug, level: 'artifact-hygiene' };
}
