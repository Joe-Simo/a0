/** Exact source closure shared by optional diagnostic companion builds and their loader. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';

export const DIAGNOSTIC_OPTIONS = {
  wasmExports: ['arena_diagnostic_options', 'arena_verified_diagnostic_options'],
  wasmSimd: true,
  optimize: true,
  wasmIo: { module: 'a0_arena', read: 'a0_runtime_read', write: 'a0_runtime_write' },
} as const;
export async function diagnosticInputs(entry: string) {
  const linked = await link(entry, (path) => readFile(path, 'utf8'));
  const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  const inputs = await Promise.all(
    [
      ...new Set([
        ...linked.sources.map(({ path }) => relative(process.cwd(), path)),
        ...execFileSync('git', ['ls-files', 'src/*.ts'], { encoding: 'utf8' }).trim().split('\n'),
        'tools/source-diagnostic-build.ts',
        'tools/source-diagnostic-inputs.ts',
        'tools/source-native-load.ts',
      ]),
    ]
      .sort()
      .map(async (path) => ({ path, sha256: hash(await readFile(path)) })),
  );
  return { linked, inputs, sourceSHA256: hash(formatProgram(linked.program)) };
}
