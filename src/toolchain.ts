/**
 * Installed-toolchain integration: Clang/GCC native builds, Clang + wasm-ld for
 * WebAssembly, javac/java for the JVM, Icarus Verilog / Yosys for hardware, and avr-gcc +
 * libsimavr for the ATmega328P.
 *
 * All invocations use argument arrays (never a shell) and a temporary directory.
 * Tool discovery is explicit and reported; absence is a recorded blocker, not a pass.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { A0Error } from './core.js';

export interface ToolResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

export interface ToolInfo {
  readonly name: string;
  readonly path: string | undefined;
  readonly version: string | undefined;
}

const SAFE_ARG = /^[A-Za-z0-9_./=:+,@%-]+$/;

function checkArgs(args: readonly string[]): void {
  for (const a of args) {
    if (!SAFE_ARG.test(a))
      throw new A0Error(`refusing unsafe process argument: ${JSON.stringify(a)}`);
  }
}

export function runTool(
  path: string,
  args: readonly string[],
  options: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): ToolResult {
  checkArgs(args);
  const r = spawnSync(path, args, {
    input: options.input,
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 64 << 20,
    shell: false,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function firstExisting(candidates: readonly (string | undefined)[]): string | undefined {
  for (const c of candidates) if (c !== undefined && c.length > 0 && existsSync(c)) return c;
  return undefined;
}

function onPath(name: string): string | undefined {
  const r = spawnSync('/usr/bin/which', [name], { encoding: 'utf8', shell: false });
  const p = r.stdout.trim();
  return r.status === 0 && p.length > 0 ? p : undefined;
}

function versionOf(
  path: string | undefined,
  args: readonly string[] = ['--version'],
): string | undefined {
  if (path === undefined) return undefined;
  const r = runTool(path, args, { timeoutMs: 10_000 });
  const text = (r.stdout || r.stderr).split('\n')[0]?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

const BREW_PREFIXES = ['/opt/homebrew/opt', '/usr/local/opt'];

export function findClang(): ToolInfo {
  const path = firstExisting([process.env.A0_CLANG, onPath('clang')]);
  return { name: 'clang', path, version: versionOf(path) };
}

export function findClangPlusPlus(): ToolInfo {
  const path = firstExisting([process.env.A0_CLANGXX, onPath('clang++')]);
  return { name: 'clang++', path, version: versionOf(path) };
}

export function findGcc(): ToolInfo {
  // On macOS `gcc` is usually Apple clang; we report the real identity via --version.
  const path = firstExisting([
    process.env.A0_GCC,
    onPath('gcc-15'),
    onPath('gcc-14'),
    onPath('gcc'),
  ]);
  return { name: 'gcc', path, version: versionOf(path) };
}

/** A Clang that can target wasm32 together with a reachable wasm-ld. */
export function findWasmClang(): ToolInfo & { readonly wasmLd: string | undefined } {
  const llvmClangs = BREW_PREFIXES.flatMap((p) => [
    `${p}/llvm/bin/clang`,
    `${p}/llvm@20/bin/clang`,
    `${p}/llvm@19/bin/clang`,
  ]);
  const wasmLd = firstExisting([
    process.env.A0_WASM_LD,
    onPath('wasm-ld'),
    ...BREW_PREFIXES.flatMap((p) => [
      `${p}/lld/bin/wasm-ld`,
      `${p}/llvm/bin/wasm-ld`,
      `${p}/llvm@20/bin/wasm-ld`,
    ]),
  ]);
  const path = firstExisting([process.env.A0_WASM_CLANG, ...llvmClangs, onPath('clang')]);
  return { name: 'wasm-clang', path, version: versionOf(path), wasmLd };
}

export function findJavac(): ToolInfo {
  // macOS ships /usr/bin/javac as a stub that fails without an installed JDK, so prefer Homebrew.
  const path = firstExisting([
    process.env.A0_JAVAC,
    ...BREW_PREFIXES.map((p) => `${p}/openjdk/bin/javac`),
    onPath('javac'),
  ]);
  return { name: 'javac', path, version: versionOf(path, ['-version']) };
}

export function findJava(): ToolInfo {
  const path = firstExisting([
    process.env.A0_JAVA,
    ...BREW_PREFIXES.map((p) => `${p}/openjdk/bin/java`),
    onPath('java'),
  ]);
  return { name: 'java', path, version: versionOf(path, ['-version']) };
}

export function findIverilog(): ToolInfo {
  const path = firstExisting([process.env.A0_IVERILOG, onPath('iverilog')]);
  return { name: 'iverilog', path, version: versionOf(path, ['-V']) };
}

export function findVvp(): ToolInfo {
  const path = firstExisting([process.env.A0_VVP, onPath('vvp')]);
  return { name: 'vvp', path, version: versionOf(path, ['-V']) };
}

export function findYosys(): ToolInfo {
  const path = firstExisting([process.env.A0_YOSYS, onPath('yosys')]);
  return { name: 'yosys', path, version: versionOf(path, ['-V']) };
}

export function findAvrGcc(): ToolInfo {
  const path = firstExisting([process.env.A0_AVR_GCC, onPath('avr-gcc')]);
  return { name: 'avr-gcc', path, version: versionOf(path) };
}

/** A libsimavr install (headers and static library) for an in-process AVR simulator host. */
export function findSimavr(): {
  readonly prefix: string | undefined;
  readonly version: string | undefined;
} {
  const prefix = [process.env.A0_SIMAVR_PREFIX, '/opt/homebrew', '/usr/local', '/usr'].find(
    (p) =>
      p !== undefined &&
      existsSync(join(p, 'include', 'simavr', 'sim_avr.h')) &&
      existsSync(join(p, 'lib', 'libsimavr.a')),
  );
  // simavr has no --version; a Homebrew keg's directory name carries it.
  const keg = prefix === undefined ? undefined : join(prefix, 'opt', 'simavr');
  const version =
    keg !== undefined && existsSync(keg) ? `simavr ${basename(realpathSync(keg))}` : undefined;
  return { prefix, version };
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'a0-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface WasmBuild {
  readonly bytes: Uint8Array;
  readonly compiler: string;
  readonly linker: string;
  /** True when served from the persistent artifact cache. */
  readonly cached: boolean;
}

/**
 * Compile emitted C to a freestanding wasm32 module exporting every a0_* function.
 * Requires a Clang with the wasm32 target and a wasm-ld; both are reported.
 */
export interface ArtifactStore {
  get(key: string): Promise<Buffer | undefined>;
  put(key: string, data: Buffer | string): Promise<void>;
}

export const WASM_FLAGS = [
  '--target=wasm32',
  '-O2',
  '-nostdlib',
  '-fuse-ld=lld',
  '-Wl,--no-entry',
  '-Wl,--export-all',
  // Aggregate values live on the wasm stack; a page program with hundreds of text literals
  // in one function exceeds wasm-ld's 64 KiB default.
  '-Wl,-z,stack-size=1048576',
] as const;

export async function compileWasm(cSource: string, cache?: ArtifactStore): Promise<WasmBuild> {
  const clang = findWasmClang();
  if (clang.path === undefined) throw new A0Error('wasm: no clang found (set A0_WASM_CLANG)');
  if (clang.wasmLd === undefined)
    throw new A0Error('wasm: no wasm-ld found (install lld, or set A0_WASM_LD)');
  const ldDir = dirname(clang.wasmLd);
  // Persistent artifact: keyed by toolchain identity, flags, and the exact module text.
  const key =
    cache === undefined
      ? undefined
      : createHash('sha256')
          .update(
            `wasm|${clang.version ?? clang.path}|${clang.wasmLd}|${WASM_FLAGS.join(' ')}|${createHash('sha256').update(cSource, 'utf8').digest('hex')}`,
          )
          .digest('hex');
  if (cache !== undefined && key !== undefined) {
    const hit = await cache.get(key);
    if (hit !== undefined)
      return {
        bytes: new Uint8Array(hit),
        compiler: clang.path,
        linker: clang.wasmLd,
        cached: true,
      };
  }
  const built = await buildWasm(cSource, clang.path, clang.wasmLd, ldDir);
  if (cache !== undefined && key !== undefined) await cache.put(key, Buffer.from(built.bytes));
  return built;
}

async function buildWasm(
  cSource: string,
  clangPath: string,
  wasmLd: string,
  ldDir: string,
): Promise<WasmBuild> {
  return withTempDir(async (dir) => {
    const src = join(dir, 'module.c');
    const out = join(dir, 'module.wasm');
    await writeFile(src, cSource, 'utf8');
    const args = [...WASM_FLAGS, `-B${ldDir}`, '-o', out, src];
    const env = { ...process.env, PATH: `${ldDir}${delimiter}${process.env.PATH ?? ''}` };
    const r = runTool(clangPath, args, { env });
    if (!r.ok) throw new A0Error(`wasm compilation failed:\n${r.stderr}`);
    return {
      bytes: new Uint8Array(await readFile(out)),
      compiler: clangPath,
      linker: wasmLd,
      cached: false,
    };
  });
}
