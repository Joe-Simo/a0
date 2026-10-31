/** Build-only checked local arena bindings. Never selected by ordinary compilation. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assemble, cSignature, cType, emitFunction, prepareCompilation } from '../src/backends.js';
import {
  formatFunction,
  parseAndValidate,
  type TypedFunc,
  type TypedProgram,
} from '../src/core.js';

const TRUSTED_ARENA_SHA256 = '7f2d51b37607b79abe0635b3363e8652f1b0546a7352a5c38686af2cd25886ab';
const operations = ['arena_alloc', 'arena_load', 'arena_store'] as const;

/** Bind actual typed function objects after checking the complete reference module.
 * This is not global name substitution: a changed body or source module is refused.
 * The wrapper must supply A0_LOCAL_ARENA(token), returning only its private capability.
 */
export function compileLocalArena(source: TypedProgram, trustedArenaSource: string): string {
  assert.equal(
    createHash('sha256').update(trustedArenaSource).digest('hex'),
    TRUSTED_ARENA_SHA256,
    'local arena contract source changed; revalidate its semantics before rebinding',
  );
  assert.notEqual(
    source.profile,
    'strict',
    'local arena contract requires canonical compiler semantics',
  );
  const reference = parseAndValidate(trustedArenaSource);
  const program = prepareCompilation(source, 'c');
  for (const expected of reference.functions) {
    const actual = program.byName.get(expected.name);
    assert.ok(actual, `missing local arena dependency ${expected.name}`);
    assert.equal(
      formatFunction(actual),
      formatFunction(expected),
      `untrusted local arena dependency ${expected.name}`,
    );
  }
  const bindings = new Map<TypedFunc, string>();
  for (const name of operations) {
    const fn = program.byName.get(name),
      expected = reference.byName.get(name);
    assert.ok(fn && expected, `missing local arena contract ${name}`);
    assert.equal(
      formatFunction(fn),
      formatFunction(expected),
      `untrusted local arena body ${name}`,
    );
    const result = cType(fn.result),
      signature = cSignature(fn);
    let operation: string;
    if (name === 'arena_alloc')
      operation = 'r.f0 = a0_arena_local_alloc(A0_LOCAL_ARENA(p0), p1, &r.f1); r.f2 = p0;';
    else if (name === 'arena_load')
      operation = 'r.f0 = a0_arena_local_load(A0_LOCAL_ARENA(p0), p1, p2, p3, r.f1.e); r.f2 = p0;';
    else {
      const borrowed = signature.includes('*p4') || signature.includes('* p4');
      operation = `r.f0 = a0_arena_local_store(A0_LOCAL_ARENA(p0), p1, p2, p3, p4${borrowed ? '->' : '.'}e); r.f1 = p0;`;
    }
    bindings.set(
      fn,
      `${signature} {\n  ${result} r; memset(&r, 0, sizeof r);\n  ${operation}\n  ${signature.startsWith('void ') ? '*out = r;' : 'return r;'}\n}`,
    );
  }
  const bodies = program.functions.map(
    (fn) => bindings.get(fn) ?? emitFunction('c', fn, { cIo: 'host', optimize: true }),
  );
  return `#include <string.h>\n${assemble('c', bodies, program, { cIo: 'host', optimize: true })}`;
}
