/** Internal compiler-implementation experiment. The ordinary optimizer derives a
 * new frozen compiler input; source acceptance and the resulting IR are checked
 * by the same A0 frontend. This does not optimize user input or replace seed/. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Func, formatProgram, type Program } from '../src/core.js';
import { optimize } from '../src/optimize.js';
import { type NativeSourceResult, nativeSource } from '../src/source-native.js';
import { C_STAGE_ENTRY } from './c-arena-stage.js';
import { writeReport } from './scrub-results.js';
import { inspectNativeSourceArtifact, nativeSourceArtifact } from './source-native-artifact.js';

type Frontend = Pick<ReturnType<typeof nativeSource>, 'parse' | 'checkProgram'>;
const sha = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** An explicit research artifact never silently selects the bundled fixture. */
export async function cStageOptimizerFrontend(directory?: string) {
  if (directory === undefined)
    return Object.assign(nativeSource(await nativeSourceArtifact()), {
      artifact: 'verified bundled source frontend' as const,
    });
  const snapshot = await inspectNativeSourceArtifact(directory);
  return Object.assign(nativeSource(snapshot.module), { artifact: snapshot.provenance });
}

function checked(result: NativeSourceResult, phase: string) {
  assert.ok(
    result.ok,
    `${phase}: A0 frontend rejected with status ${result.status}, location ${result.state[80]}`,
  );
  return result;
}

/** Keep source order and contract-only dependencies as well as executable calls.
 * Removing compiler functions is allowed only after their callers are optimized;
 * no generated C definition or externally visible wrapper is rewritten here. */
function entryProgram(program: Program, root: string): Program {
  const byName = new Map(program.functions.map((fn) => [fn.name, fn]));
  const reached = new Set<string>();
  const pending = [root];
  while (pending.length) {
    const name = pending.pop();
    assert.ok(name !== undefined);
    if (reached.has(name)) continue;
    const fn = byName.get(name);
    assert.ok(fn, `missing compiler dependency ${name}`);
    reached.add(name);
    const expressions = [
      ...fn.nodes,
      ...(fn.spec?.pre === undefined ? [] : [fn.spec.pre]),
      ...(fn.spec?.post === undefined ? [] : [fn.spec.post]),
    ];
    for (const node of expressions) {
      if (node.callee !== undefined) pending.push(node.callee);
      if (node.pred !== undefined) pending.push(node.pred);
    }
  }
  return { ...program, functions: program.functions.filter((fn) => reached.has(fn.name)) };
}

/** The normal optimizer deliberately returns metadata-free functions. Restore
 * source/spec metadata before independent A0 checking, rather than silently
 * weakening the compiler-input contract to make an optimized graph pass. */
export function prepareStandardCStageCompiler(
  frontend: Frontend,
  original: string,
  budget: number,
  root = C_STAGE_ENTRY,
) {
  const input = checked(frontend.parse(original, budget), 'original compiler source');
  const optimized = optimize(input.typed);
  const metadata = new Map(input.program.functions.map((fn) => [fn.name, fn]));
  const functions: Func[] = optimized.program.functions.map((fn) => {
    const originalFunction = metadata.get(fn.name);
    assert.ok(originalFunction, `optimizer introduced function ${fn.name}`);
    return { ...originalFunction, ...fn };
  });
  const full = checked(
    frontend.checkProgram({ ...input.program, functions }, budget),
    'optimized compiler IR',
  );
  const closed = checked(
    frontend.checkProgram(entryProgram(full.program, root), budget),
    'optimized compiler entry closure',
  );
  const source = formatProgram(closed.program);
  return {
    source,
    program: closed.program,
    typed: closed.typed,
    report: {
      originalBytes: Buffer.byteLength(original),
      originalSHA256: sha(original),
      originalFunctions: input.program.functions.length,
      originalNodes: optimized.stats.before,
      optimizedAllFunctions: full.program.functions.length,
      optimizedAllNodes: optimized.stats.after,
      frozenFunctions: closed.program.functions.length,
      frozenNodes: closed.program.functions.reduce((sum, fn) => sum + fn.nodes.length, 0),
      frozenBytes: Buffer.byteLength(source),
      frozenSHA256: sha(source),
      removedFunctions: full.program.functions
        .filter((fn) => !closed.typed.byName.has(fn.name))
        .map((fn) => fn.name),
      root,
      allocationBudget: budget,
      acceptance:
        'A0 source parse/check/spec; optimized IR and entry closure checked directly in A0',
      preparation:
        'existing optimize(TypedProgram); source/spec metadata restored before A0 checking',
      frozenSpelling: 'existing formatProgram; no generated C transformation',
    },
  };
}

async function main() {
  const options = new Map(
    process.argv.slice(2).map((arg) => {
      const at = arg.indexOf('=');
      assert.ok(at > 2, 'arguments use --name=value');
      return [arg.slice(2, at), arg.slice(at + 1)];
    }),
  );
  for (const key of options.keys())
    assert.ok(['original', 'out', 'budget', 'frontend'].includes(key), `unknown argument ${key}`);
  assert.ok(options.get('original') && options.get('out'), '--original and --out are required');
  const input = resolve(options.get('original') as string),
    out = resolve(options.get('out') as string),
    budget = Number(options.get('budget') ?? 100_000_000);
  assert.ok(Number.isInteger(budget) && budget >= 0 && budget <= 0xffff_ffff);
  const originalBytes = await readFile(input),
    original = originalBytes.toString('utf8');
  assert.ok(Buffer.from(original).equals(originalBytes), 'frozen compiler source must be UTF-8');
  await mkdir(out, { recursive: true });
  const frontend = await cStageOptimizerFrontend(options.get('frontend'));
  try {
    const prepared = prepareStandardCStageCompiler(frontend, original, budget);
    await writeFile(join(out, 'original-compiler.a0'), originalBytes, { flag: 'wx' });
    await writeFile(join(out, 'optimized-compiler.a0'), prepared.source, { flag: 'wx' });
    assert.equal(sha(await readFile(input)), sha(originalBytes), 'original compiler is immutable');
    await writeReport(join(out, 'preparation.json'), {
      status: 'prepared-not-yet-reproduced',
      frontend: frontend.artifact,
      ...prepared.report,
    });
  } finally {
    frontend.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
