/** Reproducible candidate grammar/migration audit on a committed source tree. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from '../src/backends.js';
import {
  formatProgram,
  formatSource as legacySource,
  type Program,
  parseAndValidate,
  type TypedProgram,
} from '../src/core.js';
import { link, parseFile } from '../src/link.js';
import { migrateSourceProject } from '../src/migrate.js';
import { formatSource, parseSource } from '../src/source.js';
import { linkSource } from '../src/source-link.js';
import { isReject, listSources } from './dense-loader.js';
import { committedTree } from './measurement-checkout.js';
import { reportJson, writeReport } from './scrub-results.js';

interface NativeResult {
  readonly status: number;
  readonly program: Program;
  readonly typed: TypedProgram;
}
interface NativeFrontend {
  parse(text: string): NativeResult;
  close(): void;
}
const args = process.argv.slice(2);
const option = (name: string): string | undefined =>
  args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = process.cwd();
const identity = committedTree(root);
const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const read = (path: string): Promise<string> => readFile(path, 'utf8');
let engine: NativeFrontend | undefined;
let native: { artifactSha256: string; build: unknown } | undefined;
const artifact = option('native-artifact');
if (artifact !== undefined) {
  const bytes = await readFile(join(resolve(artifact), 'frontend.wasm'));
  const build = JSON.parse(await read(join(resolve(artifact), 'build.json')));
  assert.equal(hash(bytes), build.wasmSHA256, 'native artifact does not match its build record');
  const host = (await import(
    pathToFileURL(join(root, 'experiments/unification/frontend-a0/host.mjs')).href
  )) as { frontend(module: WebAssembly.Module): NativeFrontend };
  engine = host.frontend(new WebAssembly.Module(bytes));
  native = {
    artifactSha256: hash(bytes),
    build: Object.fromEntries(
      [
        'sourceSHA256',
        'cSHA256',
        'wasmSHA256',
        'functions',
        'aggregateBytes',
        'stackBytes',
        'wasmBytes',
      ].map((key) => [key, build[key]]),
    ),
  };
}
const scratch = await mkdtemp(join(tmpdir(), 'a0-source-audit-'));
const rows: {
  entry: string;
  status: 'pass' | 'fail';
  inputSha256?: string;
  sourceSha256?: string;
  files?: number;
  reason?: string;
}[] = [];
try {
  for (const path of listSources(root).filter((path) => !isReject(path, root))) {
    const entry = relative(root, path);
    try {
      const unit = await parseFile(path, read);
      const text = formatSource(unit.program);
      const back = parseSource(text);
      assert.equal(
        legacySource(back),
        legacySource(unit.program),
        'per-file IR or source metadata differs',
      );
      assert.equal(formatSource(back), text, 'formatter is not a fixed point');
      const before = await link(path, read);
      const linkedSource = formatSource(before.program);
      if (engine !== undefined) {
        const actual = engine.parse(linkedSource);
        assert.equal(actual.status, 0, `native refusal ${actual.status}`);
        assert.equal(
          legacySource(actual.program),
          legacySource(before.program),
          'native IR or source metadata differs',
        );
        assert.equal(
          legacySource(actual.typed),
          legacySource(before.program),
          'native typed IR differs',
        );
        for (const fn of actual.typed.functions) {
          assert.equal(actual.typed.byName.get(fn.name), fn, `${fn.name}: typed identity`);
          for (const [name, callee] of fn.calls)
            assert.equal(callee, actual.typed.byName.get(name), `${fn.name}: callee identity`);
          const expected = before.program.byName.get(fn.name);
          assert.ok(expected, fn.name);
          assert.deepEqual([...fn.types], [...expected.types], `${fn.name}: types`);
          assert.equal(
            fn.staticIterations,
            expected.staticIterations,
            `${fn.name}: iteration facts`,
          );
          assert.equal(
            fn.literalIterations,
            expected.literalIterations,
            `${fn.name}: literal iteration facts`,
          );
          assert.deepEqual([...fn.calls.keys()], [...expected.calls.keys()], `${fn.name}: calls`);
        }
      }
      const destination = join(scratch, `project-${rows.length}`);
      const manifest = await migrateSourceProject(path, destination, root);
      const after = await linkSource(join(destination, manifest.entry), read, {
        root: destination,
      });
      assert.equal(
        formatProgram(after.program),
        formatProgram(before.program),
        'migrated linked program differs',
      );
      rows.push({
        entry,
        status: 'pass',
        inputSha256: hash(legacySource(before.program)),
        sourceSha256: hash(linkedSource),
        files: manifest.files.length,
      });
    } catch (error) {
      rows.push({
        entry,
        status: 'fail',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  assert.deepEqual(committedTree(root), identity, 'source tree changed during the audit');
  let selfSource: { functions: number; sourceSha256: string; cSha256: string } | undefined;
  const bootstrap = option('self-bootstrap');
  if (bootstrap !== undefined) {
    assert.ok(engine, '--self-bootstrap requires --native-artifact');
    const input = parseAndValidate(await read(resolve(bootstrap)));
    const source = formatSource(input);
    const actual = engine.parse(source);
    assert.equal(actual.status, 0, 'native frontend refused its own source');
    assert.equal(legacySource(actual.program), legacySource(input), 'self-source IR differs');
    const expectedC = compile(input, 'c', { cIo: 'host' }).text;
    const emittedC = compile(actual.typed, 'c', { cIo: 'host' }).text;
    assert.equal(emittedC, expectedC, 'self-source optimized C differs');
    selfSource = {
      functions: input.functions.length,
      sourceSha256: hash(source),
      cSha256: hash(emittedC),
    };
  }
  const failed = rows.filter((row) => row.status === 'fail').length;
  await writeReport(option('out') ?? join(root, 'results/unified-flat-source-audit.json'), {
    schema: 1,
    scope:
      'Candidate correctness and migration only; no public syntax cutover, performance or AI accuracy claim. Native checking, when present, uses the recorded research artifact and frozen generic host decoder as an independent control.',
    candidate: identity,
    method:
      'All accepted source entries from the committed inventory; exact per-file IR/comments/imports/profiles and formatter fixed points; guarded whole-closure migration with staged shared validation and revision checks; optional A0 native parsed IR and typed facts. Existing native output/spec proofs remain separate.',
    native,
    selfSource,
    entries: rows.length,
    failed,
    rows,
  });
  process.stdout.write(reportJson({ entries: rows.length, failed }));
  if (failed) process.exitCode = 1;
} finally {
  engine?.close();
  await rm(scratch, { recursive: true, force: true });
}
