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
