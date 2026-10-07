#!/usr/bin/env node
/**
 * The entry of the standalone `a0` executable (tools/release.sh): the native checker when it can
 * answer `a0 check FILE.a0` (src/native-fast.ts, nothing else loaded), the command line of
 * src/cli.ts otherwise. src/cli.ts stays the entry for `node dist/src/cli.js`.
 */
import { tryNativeCheck } from './native-fast.js';

if (!tryNativeCheck(process.argv.slice(2))) void import('./cli.js');
