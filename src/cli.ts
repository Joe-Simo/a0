#!/usr/bin/env node
/**
 * Local command-line interface.
 *
 *   a0 check <file.a0>
 *   a0 run <file.a0> <function> <args...> [--fuel=N] [--max-trips=N]
 *   a0 emit <js|c|java|sv|arm64|x86_64|riscv64|avr|wasm|arm32> <file.a0> [out]
 *   a0 emit c --parallel[=auto|gpu] <file.a0> [out]   (automatic parallel folds, src/parallel.ts)
 *   a0 emit c --traps=N <file.a0> [out]   (trap runtime: stops past N fold/loop trips with one code line)
 *   a0 wasm <file.a0> <out.wasm>
 *   a0 patch <file.a0> <patch-file> [out.a0]
 *   a0 revision <file.a0> <function>
 *   a0 mcp <file-or-dir>   (MCP server over stdio, src/mcp.ts)
 *
 * `emit wasm` writes the binary module of A0's own wasm32 backend (src/wasm.ts; no C, Clang,
 * or wasm-ld). `a0 wasm` builds the C-derived module instead: the C backend compiled by Clang
 * and linked by wasm-ld (the build the site ships); both have the same exports and io layout.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { compile, isTarget, TARGETS } from './backends.js';
import { compileCached, DiskCache } from './cache.js';
import {
  A0Error,
  checkArgument,
  formatDiagnostic,
  formatProgram,
  formatType,
  LIMITS,
  run,
  type TypedProgram,
  type Value,
} from './core.js';
import { applyPatch, parsePatch, revision, scopedView } from './edit.js';
import { link } from './link.js';
import { serveStdio } from './mcp.js';
import { parallelC } from './parallel.js';
import { compileWasm } from './toolchain.js';
import { wasmModuleBytes } from './wasm.js';

function usage(): never {
  process.stderr.write(
    [
      'usage:',
      '  a0 check <file.a0>',
      '  a0 run <file.a0> <function> <args...> [--fuel=N] [--max-trips=N]',
      `  a0 emit <${TARGETS.join('|')}> <file.a0> [out]`,
      '  a0 emit c --parallel[=auto|gpu] <file.a0> [out]   # threads (+ Metal when built as ObjC)',
      '  a0 emit c --traps=N <file.a0> [out]       # trip cap N; the stop prints one trap line, exit 3',
      '  a0 wasm <file.a0> <out.wasm>             # C backend + Clang + wasm-ld (emit wasm: direct)',
      '  a0 patch <file.a0> <patch-file> [out.a0]',
      '  a0 revision <file.a0> <function>',
      '  a0 view <file.a0> <function>          # function plus callee signatures',
      '  a0 mcp <file-or-dir>                  # MCP server (stdio), paths confined to the root;',
      '      tools: a0_open a0_program a0_apply a0_check a0_run a0_emit a0_save',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

async function readSource(path: string): Promise<string> {
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > LIMITS.maxSourceBytes)
    throw new A0Error('source too large');
  return text;
}

/** Load a file and everything it `use`s as one validated program. */
async function loadProgram(path: string): Promise<TypedProgram> {
  return (await link(path, (p) => readFile(p, 'utf8'))).program;
}

function parseValue(text: string): Value {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new A0Error(`invalid argument '${text}'`);
  return Number(text);
}

/** The value of a `--name=N` flag (a non-negative integer), or undefined when absent. */
function flagNumber(args: readonly string[], name: string): number | undefined {
  const a = args.find((x) => x.startsWith(`${name}=`));
  if (a === undefined) return undefined;
  const text = a.slice(name.length + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new A0Error(`invalid ${name} '${text}'`);
  return Number(text);
}

async function main(argv: readonly string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'check': {
      const [file] = rest;
      if (file === undefined) usage();
      const program = await loadProgram(file);
      for (const fn of program.functions) {
        process.stdout.write(
          `${fn.name} (${fn.params.map(formatType).join(', ')}) -> ${formatType(fn.result)}: ${fn.nodes.length} nodes, rev ${revision(fn).slice(0, 12)}\n`,
        );
      }
      return;
    }
    case 'run': {
      const flags = rest.filter((a) => a.startsWith('--'));
      const [file, name, ...args] = rest.filter((a) => !a.startsWith('--'));
      if (file === undefined || name === undefined) usage();
      const program = await loadProgram(file);
      const fn = program.byName.get(name);
      if (fn === undefined) throw new A0Error(`unknown function '${name}'`);
      const values = args.map(parseValue);
      for (const [i, t] of fn.params.entries()) checkArgument(t, values[i] as Value, `p${i}`);
      const fuel = flagNumber(flags, '--fuel');
      const maxTrips = flagNumber(flags, '--max-trips');
      process.stdout.write(
        `${String(
          run(fn, values, {
            fuel: fuel ?? LIMITS.defaultFuel,
            ...(maxTrips === undefined ? {} : { maxTrips }),
          }),
        )}\n`,
      );
      return;
    }
    case 'emit': {
      const flag = rest.find((a) => a.startsWith('--parallel'));
      const trips = flagNumber(rest, '--traps');
      const [target, file, out] = rest.filter((a) => a !== flag && !a.startsWith('--traps'));
      if (target === undefined || file === undefined || !isTarget(target)) usage();
      const program = await loadProgram(file);
      if (flag !== undefined) {
        const mode = flag === '--parallel' ? 'auto' : flag.slice('--parallel='.length);
        if (target !== 'c' || (mode !== 'auto' && mode !== 'gpu' && mode !== 'off')) usage();
        const cParallel = parallelC({ mode });
        const text = compile(program, 'c', cParallel === undefined ? {} : { cParallel }).text;
        if (out === undefined) process.stdout.write(text);
        else await writeFile(out, text, 'utf8');
        return;
      }
      if (trips !== undefined) {
        if (target !== 'c') usage();
        const text = compile(program, 'c', { cTrap: { maxTrips: trips } }).text;
        if (out === undefined) process.stdout.write(text);
        else await writeFile(out, text, 'utf8');
        return;
      }
      const cache = process.env.A0_NO_CACHE === '1' ? undefined : new DiskCache();
      const { text, hits, misses } =
        cache === undefined
          ? { ...compile(program, target), hits: 0, misses: 0 }
          : await compileCached(program, target, cache);
      // The wasm target's text is the binary module in base64; the output gets the bytes.
      const data = target === 'wasm' ? wasmModuleBytes(text) : text;
      if (out === undefined) process.stdout.write(data);
      else await writeFile(out, data);
      if (process.env.A0_CACHE_STATS === '1')
        process.stderr.write(`cache: ${hits} hits, ${misses} misses\n`);
      return;
    }
    case 'wasm': {
      const [file, out] = rest;
      if (file === undefined || out === undefined) usage();
      const program = await loadProgram(file);
      const cache = process.env.A0_NO_CACHE === '1' ? undefined : new DiskCache();
      const cText =
        cache === undefined
          ? compile(program, 'c').text
          : (await compileCached(program, 'c', cache)).text;
      const build = await compileWasm(cText, cache);
      await writeFile(out, build.bytes);
      process.stdout.write(
        `${build.bytes.length} bytes via ${build.compiler} + ${build.linker}${build.cached ? ' (cached artifact)' : ''}\n`,
      );
      return;
    }
    case 'patch': {
      const [file, patchFile, out] = rest;
      if (file === undefined || patchFile === undefined) usage();
      const program = await loadProgram(file);
      const patch = parsePatch(await readSource(patchFile));
      const next = applyPatch(program, patch);
      const text = formatProgram(next);
      if (out === undefined) process.stdout.write(text);
      else await writeFile(out, text, 'utf8');
      return;
    }
    case 'view': {
      const [file, name] = rest;
      if (file === undefined || name === undefined) usage();
      const program = await loadProgram(file);
      const fn = program.byName.get(name);
      if (fn === undefined) throw new A0Error(`unknown function '${name}'`);
      process.stdout.write(`${scopedView(fn)}\n`);
      return;
    }
    case 'revision': {
      const [file, name] = rest;
      if (file === undefined || name === undefined) usage();
      const program = await loadProgram(file);
      const fn = program.byName.get(name);
      if (fn === undefined) throw new A0Error(`unknown function '${name}'`);
      process.stdout.write(`${revision(fn)}\n`);
      return;
    }
    case 'mcp': {
      const [root] = rest;
      if (root === undefined) usage();
      await serveStdio(root);
      return;
    }
    default:
      usage();
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`error: ${formatDiagnostic(err)}\n`);
  process.exit(1);
});
