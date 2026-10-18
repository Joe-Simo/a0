/** UTF8 transport must preserve every scalar of the supplied JavaScript string. */
export function losslessSourceString(value: string, context = 'native source'): string {
  if (typeof value !== 'string') throw new Error(`${context}: expected a string`);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    const next = value.charCodeAt(index + 1);
    if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff))
      throw new Error(`${context}: unpaired UTF-16 surrogate`);
    index++;
  }
  return value;
}

/** Preserve a leading BOM as source content and refuse malformed file/transport bytes. */
export function decodeSourceUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
