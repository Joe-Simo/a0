/** WebAssembly memory is little-endian, independently of its JavaScript host. */
const NATIVE_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;
function extent(buffer: ArrayBufferLike, pointer: number, count: number): void {
  if (
    !Number.isSafeInteger(pointer) ||
    pointer < 0 ||
    pointer % 4 ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    pointer + count * 4 > buffer.byteLength
  )
    throw new RangeError('invalid Wasm word extent');
}
export function readWasmWords(
  buffer: ArrayBufferLike,
  pointer: number,
  count: number,
  nativeLittleEndian = NATIVE_LITTLE_ENDIAN,
): Uint32Array {
  extent(buffer, pointer, count);
  if (nativeLittleEndian) return new Uint32Array(buffer, pointer, count);
  const data = new DataView(buffer, pointer, count * 4);
  return Uint32Array.from({ length: count }, (_, index) => data.getUint32(index * 4, true));
}
export function writeWasmWords(
  buffer: ArrayBufferLike,
  pointer: number,
  words: Uint32Array,
  nativeLittleEndian = NATIVE_LITTLE_ENDIAN,
): void {
  extent(buffer, pointer, words.length);
  if (nativeLittleEndian) {
    new Uint32Array(buffer, pointer, words.length).set(words);
    return;
  }
  const stable = words.buffer === buffer ? words.slice() : words;
  const data = new DataView(buffer, pointer, stable.length * 4);
  for (let index = 0; index < stable.length; index++)
    data.setUint32(index * 4, stable[index] as number, true);
}
export function readWasmWord(buffer: ArrayBufferLike, pointer: number): number {
  extent(buffer, pointer, 1);
  return new DataView(buffer, pointer, 4).getUint32(0, true);
}
export function writeWasmWord(buffer: ArrayBufferLike, pointer: number, value: number): void {
  extent(buffer, pointer, 1);
  new DataView(buffer, pointer, 4).setUint32(0, value, true);
}
