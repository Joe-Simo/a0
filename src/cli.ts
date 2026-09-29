#!/usr/bin/env node
/**
 * Local command-line interface.
 *
 *   a0 check <file.a0>
 *   a0 run <file.a0> <function> <args...>
 *   a0 emit <js|c|java|sv> <file.a0> [out]
 *   a0 wasm <file.a0> <out.wasm>
 *   a0 patch <file.a0> <patch-file> [out.a0]
 *   a0 revision <file.a0> <function>
 */

import { readFile, writeFile } from 'node:fs/promises';
import { compile, isTarget, TARGETS } from './backends.js';
import {
  A0Error,
  checkArgument,
  formatProgram,
  formatType,
  LIMITS,
  parseAndValidate,
  run,
  type Value,
} from './core.js';
import { applyPatch, parsePatch, revision, scopedView } from './edit.js';
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
      const program = parseAndValidate(await readSource(file));
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
      const program = parseAndValidate(await readSource(file));
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
      const program = parseAndValidate(await readSource(file));
      const { text } = compile(program, target);
      if (out === undefined) process.stdout.write(text);
      else await writeFile(out, text, 'utf8');
      return;
    }
    case 'wasm': {
      const [file, out] = rest;
      if (file === undefined || out === undefined) usage();
      const program = parseAndValidate(await readSource(file));
      const build = await compileWasm(compile(program, 'c').text);
      await writeFile(out, build.bytes);
      process.stdout.write(`${build.bytes.length} bytes via ${build.compiler} + ${build.linker}\n`);
      return;
    }
    case 'patch': {
      const [file, patchFile, out] = rest;
      if (file === undefined || patchFile === undefined) usage();
      const program = parseAndValidate(await readSource(file));
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
      const program = parseAndValidate(await readSource(file));
      const fn = program.byName.get(name);
      if (fn === undefined) throw new A0Error(`unknown function '${name}'`);
      process.stdout.write(`${scopedView(fn)}\n`);
      return;
    }
    case 'revision': {
      const [file, name] = rest;
      if (file === undefined || name === undefined) usage();
      const program = parseAndValidate(await readSource(file));
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
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
