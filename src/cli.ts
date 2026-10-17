#!/usr/bin/env node
/**
 * The entry of `node dist/src/cli.js` (and of src/a0.ts after its native fast path): node's module
 * compile cache is turned on where the runtime has it (node 22.1 and later:
 * module.enableCompileCache; bun has none and goes on unchanged), then the command line of
 * src/cli-main.ts is loaded, so a later start reuses the compiled code of the CLI and what it
 * imports instead of compiling it again. Nothing of the compiler is imported here: the cache must
 * be on before its first module is compiled.
 */
import * as nodeModule from 'node:module';

const enable = (nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache;
if (typeof enable === 'function') {
  try {
    enable();
  } catch {
    // a cache directory that cannot be written: the start-up is the uncached one
  }
}
// The asynchronous module load still follows cache initialization. Avoid top-level await so
// pinned Bun can bundle the standalone executable as CJS bytecode.
void import('./cli-main.js');
