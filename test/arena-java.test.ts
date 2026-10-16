import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { formatProgram, type TypedProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, findJava, findJavac, runTool } from '../src/toolchain.js';
import { emitChunked, runStageChunk } from '../tools/bootstrap.js';
import {
  type JavaTools,
  type NativeResult,
  type Plan,
  runJava,
  runNative,
  type TargetDriver,
} from './fixtures/arena-java/runtime.js';
import { buildVerifiedNativeSeed } from './helpers/native-source-compiler.js';

const clang = findClang();
const skip =
  process.platform === 'win32'
    ? 'the ordered-linked test transport is POSIX'
    : clang.path === undefined
      ? 'clang is unavailable'
      : false;
const fixtures = resolve('test/fixtures/arena-java');
const runtime = resolve('tools/native');
const roots = [
  'arena_java_begin_options',
  'arena_java_resume',
  'arena_java_result',
  'arena_java_link_begin_options',
  'arena_java_link_resume',
  'arena_java_link_result',
  'java_emit_options',
  'fs_hello',
  'arena_finish',
  'ew_emit',
] as const;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
let scratch: string | undefined;
let prepared: Promise<{ dir: string; binaries: readonly string[] }> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function closure(program: TypedProgram): TypedProgram {
  const seen = new Set<string>();
  function visit(name: string): void {
    if (seen.has(name)) return;
    seen.add(name);
    const fn = program.byName.get(name);
    assert.ok(fn, name);
    for (const node of fn.nodes)
      for (const callee of [node.callee, node.pred]) if (callee !== undefined) visit(callee);
  }
  for (const root of roots) visit(root);
  const functions = program.functions.filter((fn) => seen.has(fn.name));
  return { ...program, functions, byName: new Map(functions.map((fn) => [fn.name, fn])) };
}

function prepare(): Promise<{ dir: string; binaries: readonly string[] }> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-java-'));
    scratch = dir;
    const seed = await buildVerifiedNativeSeed(dir, clang);
    assert.ok(seed.clang.path);
    const linked = await link(join(fixtures, 'probe.a0'), (path) => readFile(path, 'utf8'));
    const emitted = emitChunked(formatProgram(closure(linked.program)), (chunk, bounds) =>
      runStageChunk(seed.exe, chunk, bounds),
    );
    assert.equal(emitted.code, 0, `A0 seed rejected ${emitted.failed?.own.join(',')}`);
    await writeFile(join(dir, 'module.c'), emitted.text);
    const api: string[] = [];
    for (const [key, name] of Object.entries({
      UNIT_STATE: 'arena_java_begin_options',
      LINK_STATE: 'arena_java_link_begin_options',
      TARGET_RESULT: 'java_emit_options',
      HELLO_RESULT: 'fs_hello',
      EW_RESULT: 'ew_emit',
    })) {
      const type = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(type, name);
      api.push(`#define ${key} ${type}`);
    }
    await writeFile(join(dir, 'api.h'), `${api.join('\n')}\n`);
    const binaries: string[] = [];
    for (const level of [0, 2]) {
      const exe = join(dir, `arena-java-O${level}`);
      const built = runTool(
        seed.clang.path,
        [
          '-std=c11',
          `-O${level}`,
          '-Wall',
          '-Wextra',
          '-Wno-unused-parameter',
          '-Werror',
          '-fsanitize=undefined',
          '-fno-sanitize-recover=all',
          '-I',
          dir,
          '-I',
          runtime,
          join(fixtures, 'driver.c'),
          '-o',
          exe,
        ],
        { cwd: dir, timeoutMs: 180000 },
      );
      assert.ok(built.ok, built.stderr);
      binaries.push(exe);
    }
    return { dir, binaries };
  })();
  return prepared;
}

interface ExecutedTarget {
  readonly level: number;
  readonly name: string;
  readonly mode: number;
  readonly text: string;
  readonly driver: TargetDriver;
}
let matrix: Promise<{ dir: string; targets: readonly ExecutedTarget[] }> | undefined;
function runMatrix(): Promise<{ dir: string; targets: readonly ExecutedTarget[] }> {
  matrix ??= (async () => {
    const { dir, binaries } = await prepare();
    const plan = JSON.parse(await readFile(join(fixtures, 'plan.json'), 'utf8')) as Plan;
    const linkedOracle = JSON.parse(
      await readFile(join(fixtures, 'linked-oracle.json'), 'utf8'),
    ) as {
      rows: readonly {
        name: string;
        code: number;
        diagnostic: number;
        diagnosticStage: number;
      }[];
    };
    const targets: ExecutedTarget[] = [];
    const paired: NativeResult[][] = [];
    for (const [level, exe] of binaries.entries()) {
      const observed: NativeResult[] = [];
      for (const row of plan.rows) {
        for (const mode of row.targetDriver === undefined ? [row.mode ?? 0] : [0, 2]) {
          const got = runNative(exe, { ...row, mode });
          assert.equal(got.code, row.code, row.name);
          if (got.code !== 0) assert.equal(got.text, '');
          if (row.expectedTargetSHA256 !== undefined)
            assert.equal(sha(got.text), row.expectedTargetSHA256, row.name);
          if (row.diagnostic !== undefined) assert.equal(got.m[1], row.diagnostic, row.name);
          if (row.specDiagnostic !== undefined)
            assert.equal(got.v[20], row.specDiagnostic, row.name);
          if (row.pending) {
            assert.equal(got.e[0], 0);
            assert.notEqual(got.e[1], 3);
          }
          if (got.code === 0 && mode === 0) assert.ok(got.snapshots > 0, row.name);
          if (row.targetDriver !== undefined)
            targets.push({ level, name: row.name, mode, text: got.text, driver: row.targetDriver });
          observed.push(got);
        }
      }
      for (const [index, row] of plan.linkCases.entries()) {
        const root = join(dir, `links-O${level}`, String(index));
        await mkdir(root, { recursive: true });
        for (const [file, source] of Object.entries(row.files))
          await writeFile(
            join(root, file),
            typeof source === 'string' ? source : Buffer.from(source.data),
          );
        const expected = linkedOracle.rows.find((item) => item.name === row.name);
        for (const quantum of [1, 7]) {
          const got = runNative(exe, {
            name: row.name,
            code: row.code ?? expected?.code ?? 0,
            mode: 1,
            entry: join(root, 'entry.a0'),
            root,
            ...(row.override === undefined ? {} : { override: row.override }),
            quantum,
          });
          assert.equal(got.code, row.code ?? expected?.code, row.name);
          if (expected !== undefined) {
            assert.equal(got.l[5], expected.diagnostic, row.name);
            assert.equal(got.l[4], expected.diagnosticStage, row.name);
          }
          if (got.code !== 0) assert.equal(got.text, '');
          else {
            assert.equal(got.l[18], 1);
            assert.equal(got.d[3], 1);
            assert.equal(got.d[15], 2);
            if (quantum === 1) assert.ok(got.snapshots > 0);
            const driver =
              row.targetDriver ??
              (index === 0
                ? {
                    file: 'LinkedDriver.java',
                    className: 'LinkedDriver',
                    source:
                      'public final class LinkedDriver { public static void main(String[] a) { if(A0Module.entry(2)!=3) throw new AssertionError(); } }\n',
                    expected: '',
                    cases: 1,
                  }
                : undefined);
            if (driver !== undefined && quantum === 1)
              targets.push({ level, name: row.name, mode: 1, text: got.text, driver });
          }
          observed.push(got);
        }
      }
      assert.equal(observed.length, 130);
      paired.push(observed);
    }
    assert.deepEqual(paired[0], paired[1], 'O0/O2 must retain identical packet replies');
    return { dir, targets };
  })();
  return matrix;
}

function javaTools(): JavaTools | undefined {
  const java = findJava();
  if (java.path === undefined) return undefined;
  const major = Number(/version "(?:1\.)?(\d+)/.exec(java.version ?? '')?.[1]);
  if (!(major >= 16)) return undefined;
  const javac = findJavac();
  const compilerMajor = Number(/javac (?:1\.)?(\d+)/.exec(javac.version ?? '')?.[1]);
  if (javac.path !== undefined && compilerMajor >= 16 && compilerMajor <= major)
    return { java: java.path, compiler: javac.path, compilerPrefix: [] };
  const modules = spawnSync(java.path, ['--list-modules'], { encoding: 'utf8', timeout: 10000 });
  if (modules.status === 0 && /^jdk\.compiler@/m.test(modules.stdout))
    return {
      java: java.path,
      compiler: java.path,
      compilerPrefix: ['-m', 'jdk.compiler/com.sun.tools.javac.Main'],
    };
  return undefined;
}
const jdk = javaTools();
const javaSkip =
  skip || (jdk === undefined ? 'JDK16+ with javac or jdk.compiler is unavailable' : false);

test('native A0 Java source/direct/ordered-link retains exact full-word artifacts, refusals and resources', {
  skip,
  timeout: 600000,
}, async () => {
  await runMatrix();
});

test('native A0 Java executes canonical, checked, strict, alias and IO public ABI on the JVM', {
  skip: javaSkip,
  timeout: 600000,
}, async () => {
  assert.ok(jdk);
  const { dir, targets } = await runMatrix();
  assert.equal(targets.length, 44);
  for (const [i, target] of targets.entries())
    await runJava(jdk, join(dir, 'jvm', String(i)), target.text, target.driver);
});

test('native-emitted Java alias and checked-overflow regression oracles reject generated-target faults', {
  skip: javaSkip,
  timeout: 600000,
}, async () => {
  assert.ok(jdk);
  const { dir, targets } = await runMatrix();
  for (const level of [0, 1]) {
    const target = targets.find(
      (item) => item.level === level && item.name === 'independent-canonical' && item.mode === 0,
    );
    assert.ok(target);
    const alias = target.text.replaceAll('copy = a.clone()', 'copy = a');
    assert.notEqual(alias, target.text);
    await runJava(jdk, join(dir, 'fault-alias', String(level)), alias, target.driver, false);
    const flag = target.text.replace('Integer.compareUnsigned(s, a) >= 0', 'true');
    assert.notEqual(flag, target.text);
    await runJava(jdk, join(dir, 'fault-flag', String(level)), flag, target.driver, false);
  }
});
