#!/usr/bin/env node
/**
 * Local command-line interface.
 *
 *   a0 check <file.a0>
 *   a0 run <file.a0> <function> <args...>
 *   a0 emit <js|c|java|sv|arm64|x86_64> <file.a0> [out]
 *   a0 wasm <file.a0> <out.wasm>
 *   a0 patch <file.a0> <patch-file> [out.a0]
 *   a0 revision <file.a0> <function>
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
import { compileWasm } from './toolchain.js';

function usage(): never {
  process.stderr.write(
    [
      'usage:',
      '  a0 check <file.a0>',
      '  a0 run <file.a0> <function> <args...>',
      `  a0 emit <${TARGETS.join('|')}> <file.a0> [out]`,
      '  a0 wasm <file.a0> <out.wasm>',
      '  a0 patch <file.a0> <patch-file> [out.a0]',
      '  a0 revision <file.a0> <function>',
      '  a0 view <file.a0> <function>          # function plus callee signatures',
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
      const [file, name, ...args] = rest;
      if (file === undefined || name === undefined) usage();
      const program = await loadProgram(file);
      const fn = program.byName.get(name);
      if (fn === undefined) throw new A0Error(`unknown function '${name}'`);
      const values = args.map(parseValue);
      for (const [i, t] of fn.params.entries()) checkArgument(t, values[i] as Value, `p${i}`);

      process.stdout.write(`${String(run(fn, values))}\n`);
      return;
    }
    case 'emit': {
      const [target, file, out] = rest;
      if (target === undefined || file === undefined || !isTarget(target)) usage();
      const program = await loadProgram(file);
      const cache = process.env.A0_NO_CACHE === '1' ? undefined : new DiskCache();
      const { text, hits, misses } =
        cache === undefined
          ? { ...compile(program, target), hits: 0, misses: 0 }
          : await compileCached(program, target, cache);
      if (out === undefined) process.stdout.write(text);
      else await writeFile(out, text, 'utf8');
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
    default:
      usage();
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`error: ${formatDiagnostic(err)}\n`);
  process.exit(1);
});
