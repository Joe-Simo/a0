/** Complete local compiler/transport inventory for the explicit JS-target preparation. */
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

export const JS_ARENA_INPUTS = [
  'tools/native/arena_runtime.c',
  'tools/native/arena_runtime.h',
  'tools/native/arena_memory.c',
];
export const JS_PREPARATION_INPUTS = [
  'tools/source-js-build.ts',
  'tools/source-js-load.ts',
  'tools/source-js-artifact.ts',
  'tools/source-cost-control.ts',
  'tools/source-compiler-inputs.ts',
  'tools/source-js-inputs.ts',
  'tools/source-js-prepare.ts',
  'tools/source-js-emit.ts',
  'tools/wasm-stack-bound.ts',
  'tools/measurement-checkout.ts',
  'tools/scrub-results.ts',
];
export function jsCompilerSources(checkout = process.cwd()): string[] {
  return execFileSync('git', ['ls-files', 'src/*.ts'], { cwd: checkout, encoding: 'utf8' })
    .trim()
    .split('\n');
}
export function jsCompilerOutputPaths(checkout = process.cwd()): string[] {
  return [...jsCompilerSources(checkout), ...JS_PREPARATION_INPUTS]
    .map((path) => `dist/${path.slice(0, -3)}.js`)
    .sort();
}
export function jsSourceInputPaths(sources: readonly string[]): string[] {
  return [
    ...new Set([
      ...sources.map((path) => relative(process.cwd(), resolve(path))),
      ...jsCompilerSources(),
      'bun.lock',
      'package.json',
      'tsconfig.json',
      ...JS_PREPARATION_INPUTS,
      ...JS_ARENA_INPUTS,
    ]),
  ].sort();
}
