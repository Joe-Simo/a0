/**
 * The compiler version and the target names, apart from the backends. The CLI needs them to print
 * `--version` and the usage text; keeping them here lets `a0 check` start without loading any backend
 * (src/backends.ts re-exports all of them, so no caller changes).
 */

export const COMPILER_VERSION = 'a0c-0.1.39';

export type Target =
  | 'js'
  | 'c'
  | 'java'
  | 'sv'
  | 'arm64'
  | 'x86_64'
  | 'riscv64'
  | 'avr'
  | 'wasm'
  | 'arm32';
export const TARGETS: readonly Target[] = [
  'js',
  'c',
  'java',
  'sv',
  'arm64',
  'x86_64',
  'riscv64',
  'avr',
  'wasm',
  'arm32',
];

export function isTarget(text: string): text is Target {
  return (TARGETS as readonly string[]).includes(text);
}
