import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTool } from '../../../dist/src/toolchain.js';
import { CLANG, ROOT } from './transport.mjs';

const dir = join(ROOT, 'targets');
mkdirSync(dir, { recursive: true });
let ordinal = 0;
export function target(result, main, before = '') {
  assert.equal(result.code, 0);
  const stem = join(dir, String(ordinal++).padStart(4, '0'));
  // No rewriting, substitution or source-parser fallback. Including callers own
  // the public hook macros and ordinary C invocation/observation code only.
  writeFileSync(`${stem}.module.c`, result.bytes);
  writeFileSync(
    `${stem}.c`,
    `#include <assert.h>\n#include <stdbool.h>\n#include <stdint.h>\n#include <string.h>\n${before}\n#include "${stem.split('/').at(-1)}.module.c"\n${main}\n`,
  );
  for (const level of [0, 2]) {
    const exe = `${stem}-O${level}`;
    const built = runTool(
      CLANG,
      [
        '-std=c11',
        `-O${level}`,
        '-Wall',
        '-Wextra',
        '-Wno-unused-parameter',
        '-Werror',
        '-fsanitize=undefined',
        '-fno-sanitize-recover=all',
        `${stem}.c`,
        '-o',
        exe,
      ],
      { timeoutMs: 180000 },
    );
    assert.ok(built.ok, `target O${level}: ${built.stderr}`);
    const ran = runTool(exe, [], { timeoutMs: 120000 });
    assert.ok(ran.ok, `target O${level}: ${ran.stderr}`);
  }
}
export function returnType(result, name) {
  const found = new RegExp(`^(a0t_[A-Za-z0-9_]+) a0_${name}\\(`, 'm').exec(
    Buffer.from(result.bytes).toString(),
  )?.[1];
  assert.ok(found, `actual emitted return type ${name}`);
  return found;
}
export const scalarMain = (cases) =>
  `int main(void) {\n${cases
    .map(
      ({ functionName, args, expected }) =>
        `assert((uint32_t)a0_${functionName}(${args.map((v) => `${Number(v) >>> 0}u`).join(',')}) == ${Number(expected) >>> 0}u);`,
    )
    .join('\n')}\nreturn 0;\n}`;
