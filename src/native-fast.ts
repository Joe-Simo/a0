/**
 * The fast path of `a0 check`: a prebuilt native checker (tools/native/a0.c, built by
 * `node dist/tools/native-check.js --build-only`, compiler/check.a0 compiled through the C
 * backend) is started instead of the TypeScript checker, which a compiled `a0` pays its runtime
 * start-up for. It only imports node built-ins, so nothing of the compiler is loaded before it.
 *
 * Used only when the command is `a0 check FILE.a0` with no flag, and the native checker accepts
 * the program: its stdout (one line per function: name, types, node count, revision, as
 * src/cli.ts prints them; `--lines`) is then written as it is. Anything else (a diagnostic, a
 * program over a capacity of the native checker, an unreadable file, no native checker) falls
 * through to the TypeScript checker, which prints the diagnostic, so the output and the exit code
 * are the TypeScript CLI's in every case; the differential of test/native-check.test.ts holds
 * the native accept to the TypeScript one.
 *
 * Where the checker is: `A0_NATIVE_CHECK=PATH` names it (`0` turns the fast path off); else a file
 * `a0-check` (`a0-check.exe` on Windows) next to the `a0` executable. A `node` or `bun` process
 * never looks next to itself.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The native checker to use, or undefined. */
export function nativeCheckBinary(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | undefined {
  const forced = env.A0_NATIVE_CHECK;
  if (forced === '0') return undefined;
  if (forced !== undefined && forced !== '') return existsSync(forced) ? forced : undefined;
  const name = basename(execPath).toLowerCase();
  if (/^(node|bun)(\.exe)?$/.test(name)) return undefined;
  const sibling = join(dirname(execPath), platform === 'win32' ? 'a0-check.exe' : 'a0-check');
  return existsSync(sibling) ? sibling : undefined;
}

/** Whether the arguments are `check FILE.a0` and nothing else. */
export function isPlainCheck(args: readonly string[]): args is readonly ['check', string] {
  return args.length === 2 && args[0] === 'check' && (args[1] as string).endsWith('.a0');
}

/** Run the native checker on `a0 check FILE`; true when it accepted and its output was written. */
export function tryNativeCheck(args: readonly string[]): boolean {
  if (!isPlainCheck(args)) return false;
  const exe = nativeCheckBinary();
  if (exe === undefined) return false;
  const r = spawnSync(exe, ['check', '--lines', args[1]], {
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 1 << 28,
    windowsHide: true,
  });
  if (r.status !== 0 || r.error !== undefined) return false;
  process.stdout.write(r.stdout);
  return true;
}
