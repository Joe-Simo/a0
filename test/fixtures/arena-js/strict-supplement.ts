import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { A0Error, makeIo, parseAndValidate, run, type Value } from '../../../src/core.js';
import type { CandidateEmitter } from './conformance.js';
import { STRICT_SUPPLEMENT_CASES, STRICT_SUPPLEMENT_SOURCE } from './strict-fixtures.js';

const IDS = { bounds: 'A0710', divzero: 'A0711', input: 'A0712' } as const;

/** Independent literal expectations; reference-only by default, candidate only if supplied. */
export async function checkStrictSupplement(emit: CandidateEmitter, dir: string) {
  const program = parseAndValidate(STRICT_SUPPLEMENT_SOURCE);
  assert.equal(program.byName.get('sf_inline')?.nodes.at(-1)?.id, 'retval2');
  assert.equal(program.byName.get('sf_inline_three')?.nodes.at(-1)?.id, 'retval3');
  let module: Record<string, (...args: unknown[]) => unknown> | undefined;
  if (emit !== undefined) {
    const result = await emit(STRICT_SUPPLEMENT_SOURCE, program);
    assert.equal(result.code, 0, 'strict supplement must be supported by versioned table entry');
    await mkdir(dir, { recursive: true });
    const file = `${dir}/${createHash('sha256').update(result.text).digest('hex')}.mjs`;
    await writeFile(file, result.text);
    module = await import(pathToFileURL(file).href);
  }
  let traps = 0,
    successes = 0;
  const observations: {
    fn: string;
    input?: readonly number[];
    trap?: unknown;
    result?: unknown;
    position?: number;
    output?: readonly number[];
  }[] = [];
  for (const row of STRICT_SUPPLEMENT_CASES) {
    const fn = program.byName.get(row.fn);
    assert.ok(fn);
    const args: Value[] = [...row.args];
    if (row.input !== undefined) args.push(makeIo(row.input));
    const expectedArgs = structuredClone(args);
    let value: Value | undefined;
    let error: A0Error | undefined;
    try {
      value = run(fn, expectedArgs, { fuel: 100000 });
    } catch (caught) {
      assert.ok(caught instanceof A0Error && caught.trap !== undefined);
      error = caught;
    }
    if (row.trap !== undefined) {
      assert.ok(error);
      assert.deepEqual(
        { code: error.code, id: error.id, trap: error.trap },
        { code: 'runtime', id: IDS[row.trap.kind], trap: row.trap },
        `${row.fn}: literal reference trap metadata`,
      );
      traps++;
    } else {
      assert.equal(error, undefined);
      assert.deepEqual(value, row.expected, `${row.fn}: literal reference value`);
      successes++;
    }
    const io =
      row.input === undefined ? undefined : (expectedArgs.at(-1) as ReturnType<typeof makeIo>);
    if (io !== undefined) {
      assert.equal(io.position, row.position);
      assert.deepEqual(io.output, row.output);
    }
    if (module !== undefined) {
      const invoke = module[row.fn];
      assert.ok(invoke);
      const actualArgs = structuredClone(args);
      if (error !== undefined)
        assert.throws(
          () => invoke(...actualArgs),
          (caught: unknown) => {
            assert.ok(caught instanceof Error);
            const actual = caught as A0Error;
            assert.deepEqual(
              { code: actual.code, id: actual.id, trap: actual.trap },
              { code: error.code, id: error.id, trap: error.trap },
              `${row.fn}: candidate trap metadata`,
            );
            return true;
          },
        );
      else assert.deepEqual(invoke(...actualArgs), value, `${row.fn}: candidate value`);
      assert.deepEqual(actualArgs, expectedArgs, `${row.fn}: committed IO and caller values`);
    }
    observations.push({
      fn: row.fn,
      ...(row.input === undefined ? {} : { input: row.input }),
      ...(error === undefined ? { result: value } : { trap: error.trap }),
      ...(io === undefined ? {} : { position: io.position, output: io.output }),
    });
  }
  return {
    status: 'passed',
    stage:
      module === undefined
        ? 'reference-only strict expectations; no candidate'
        : 'versioned strict table supplement',
    comparisons: module === undefined ? 0 : STRICT_SUPPLEMENT_CASES.length,
    referenceCases: STRICT_SUPPLEMENT_CASES.length,
    traps,
    successes,
    syntheticIDs: ['retval2', 'retval3'],
    observations,
  };
}
