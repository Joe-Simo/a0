/**
 * Pure helpers of the UI word protocol shared by site/app.ts and its tests: no DOM access.
 */
/**
 * Read a length-prefixed byte string at `start`: the length word is clamped to the words that
 * remain, so a hostile length cannot allocate past the stream. Returns the bytes and the index
 * after them.
 */
export function readBytes(words, start) {
    const i = start + 1;
    const n = Math.min((words[start] ?? 0) >>> 0, Math.max(0, words.length - i));
    const bytes = new Uint8Array(n);
    for (let k = 0; k < n; k += 1)
        bytes[k] = words[i + k] & 0xff;
    return { bytes, next: i + n };
}
/**
 * An href the page may set: http(s), a site-relative path, a fragment, or mailto. A path must
 * not start with `//` or `/\\`, which browsers resolve as another host.
 */
export function safeHref(value) {
    return /^(https?:|\/(?![/\\])|#|mailto:)/i.test(value);
}
