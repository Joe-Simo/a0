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

const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

export const existsSync: typeof import('node:fs').existsSync = fs.existsSync;

/** A file's text (fs.promises.readFile with an encoding). */
export function readFile(path: string, encoding: 'utf8'): Promise<string> {
  return new Promise((ok, fail) => {
    fs.readFile(path, encoding, (e, text) => (e === null ? ok(text) : fail(e)));
  });
}

/** Source bytes for host adapters that require fatal UTF-8 decoding. */
export function readBytes(path: string): Promise<Buffer> {
  return new Promise((ok, fail) => {
    fs.readFile(path, (e, bytes) => (e === null ? ok(bytes) : fail(e)));
  });
}

/** Write a file (fs.promises.writeFile). */
export function writeFile(
  path: string,
  data: string | Uint8Array,
  encoding?: 'utf8',
): Promise<void> {
  return new Promise((ok, fail) => {
    const done = (e: NodeJS.ErrnoException | null): void => (e === null ? ok() : fail(e));
    if (encoding === undefined) fs.writeFile(path, data, done);
    else fs.writeFile(path, data, encoding, done);
  });
}

/** The canonical path, symlinks followed (fs.promises.realpath: the native realpath). */
export function realpath(path: string): Promise<string> {
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
export function writeFd(fd: 1 | 2, data: string | Uint8Array): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let off = 0;
  while (off < bytes.length) {
    try {
      off += fs.writeSync(fd, bytes, off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
      Atomics.wait(pause, 0, 0, 1);
    }
  }
}
