#!/usr/bin/env node
/**
 * The entry of the standalone `a0` executable (tools/release.sh): the native checker when it can
 * answer `a0 check FILE.a0` (src/native-fast.ts, nothing else loaded), the command line of
 * src/cli.ts otherwise. src/cli.ts stays the entry for `node dist/src/cli.js`.
 *
 * Before the command line is loaded, node's module compile cache is turned on where the runtime
 * has it (node 22.1 and later: module.enableCompileCache; bun has none and goes on unchanged), so
 * a later start reuses the compiled code of src/cli.ts and what it imports.
 */
import * as nodeModule from 'node:module';
import { tryNativeCheck } from './native-fast.js';

if (!tryNativeCheck(process.argv.slice(2))) {
  const enable = (nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache;
  if (typeof enable === 'function') {
    try {
      enable();
    } catch {
      // a cache directory that cannot be written: the start-up is the uncached one
    }
  }
  void import('./cli.js');
}
