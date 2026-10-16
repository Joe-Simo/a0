/**
 * The file system calls of the `a0 check` path, taken from node:fs through `require`.
 *
 * Importing `node:fs` or `node:fs/promises` as an ES module builds the module's namespace, which
 * reads every export, the lazy ones included (`fs.promises`, the stream classes): that loads about
 * twenty internal modules (streams, readline) that a check never uses, at every start of the CLI.
 * `require('node:fs')` returns the same object without reading them. The promise forms below are
 * the callback calls of node:fs, which fail with the same errors as node:fs/promises.
 */
import { createRequire } from 'node:module';
const fs = createRequire(import.meta.url)('node:fs');
export const existsSync = fs.existsSync;
/** A file's text (fs.promises.readFile with an encoding). */
export function readFile(path, encoding) {
    return new Promise((ok, fail) => {
        fs.readFile(path, encoding, (e, text) => (e === null ? ok(text) : fail(e)));
    });
}
/** Write a file (fs.promises.writeFile). */
export function writeFile(path, data, encoding) {
    return new Promise((ok, fail) => {
        const done = (e) => (e === null ? ok() : fail(e));
        if (encoding === undefined)
            fs.writeFile(path, data, done);
        else
            fs.writeFile(path, data, encoding, done);
    });
}
/** The canonical path, symlinks followed (fs.promises.realpath: the native realpath). */
export function realpath(path) {
    return new Promise((ok, fail) => {
        fs.realpath.native(path, (e, resolved) => (e === null ? ok(resolved) : fail(e)));
    });
}
const pause = new Int32Array(new SharedArrayBuffer(4));
/**
 * Write text or bytes to stdout (fd 1) or stderr (fd 2) at once and in full. The one-shot commands of the CLI
 * write through here rather than through process.stdout and process.stderr: the first touch of
 * either builds a stream (a net.Socket on a pipe, a tty.WriteStream on a terminal), which loads
 * node's stream and net modules, about 10 ms of each start of `a0 check`. A pipe left non-blocking
 * by the reader answers EAGAIN while it is full; the write then waits a millisecond and goes on.
 */
export function writeFd(fd, data) {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < bytes.length) {
        try {
            off += fs.writeSync(fd, bytes, off);
        }
        catch (e) {
            if (e.code !== 'EAGAIN')
                throw e;
            Atomics.wait(pause, 0, 0, 1);
        }
    }
}
//# sourceMappingURL=node-fs.js.map