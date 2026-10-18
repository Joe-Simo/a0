/** Compiler provenance for explicit same-source C code-generation experiments. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { formatType, type TypedProgram } from '../src/core.js';

export interface SourceCompilerInput {
  readonly path: string;
  readonly sha256: string;
}

export interface NativeCompileRoots {
  readonly checkout: string;
  readonly artifact: string;
  readonly sysroot: string;
  readonly resource: string;
}

/** Structural signatures bind the A0 API consumed by a native adapter. */
export function sourceFunctionSignatures(program: TypedProgram, names: readonly string[]) {
  assert.equal(new Set(names).size, names.length, 'duplicate consumed A0 function');
  return [...names].sort().map((name) => {
    const fn = program.byName.get(name);
    assert.ok(fn, `missing consumed A0 function ${name}`);
    return { name, params: fn.params.map(formatType), result: formatType(fn.result) };
  });
}

function nativeRoots(roots: NativeCompileRoots) {
  return Object.entries(roots)
    .map(([name, path]) => [name, resolve(path)] as const)
    .sort((a, b) => b[1].length - a[1].length);
}

/** Hash the effective cc1 invocation, including implicit config and include environment expansion. */
export function nativeCompileCommandSHA256(trace: string, roots: NativeCompileRoots): string {
  const commands = trace.split(/\r?\n/).filter((line) => /(?:^|\s)"?-cc1"?\s+"?-/.test(line));
  assert.equal(commands.length, 1, 'native compilation lacks one effective cc1 invocation');
  let portable = commands[0] as string;
  for (const [name, path] of nativeRoots(roots)) portable = portable.replaceAll(path, `<${name}>`);
  return createHash('sha256').update(portable).digest('hex');
}

/** -H is collected from the compilation itself, so this inventory is its actual include closure. */
export async function nativeCompileInputs(trace: string, roots: NativeCompileRoots) {
  const files = new Set([join(roots.artifact, 'driver.c')]);
  for (const line of trace.split(/\r?\n/)) {
    const path = /^\.+ (.+)$/.exec(line)?.[1];
    if (path !== undefined) files.add(resolve(roots.checkout, path));
  }
  assert.ok(files.size > 1, 'native compilation emitted no include dependencies');
  const inputs = await Promise.all(
    [...files].map(async (path) => {
      let label: string | undefined;
      for (const [name, root] of nativeRoots(roots))
        if (path.startsWith(root + sep)) {
          label = `<${name}>/${relative(root, path).replaceAll('\\', '/')}`;
          break;
        }
      label ??= `<external-${createHash('sha256').update(path).digest('hex')}>/${basename(path)}`;
      return {
        path: label,
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      };
    }),
  );
  return inputs.sort((a, b) => a.path.localeCompare(b.path));
}

const CONFIGURATION = [
  'package.json',
  'bun.lock',
  'tsconfig.json',
  '.npmrc',
  'bunfig.toml',
  '.bunfig.toml',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];
const HELPERS = [
  'tools/source-native-build.ts',
  'tools/source-compiler-inputs.ts',
  'tools/scrub-results.ts',
];

/** All tracked compiler sources, its actual TS configuration chain and dependency configuration. */
export async function sourceCompilerInputs(checkout: string) {
  const root = resolve(checkout);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const tracked = new Set(git('ls-files', '-z').split('\0').filter(Boolean));
  for (const path of ['package.json', 'bun.lock', 'tsconfig.json', ...HELPERS])
    assert.ok(tracked.has(path), `missing compiler input ${path}`);
  const configuration = new Set(CONFIGURATION.filter((path) => tracked.has(path)));
  const present = new Set(await readdir(root));
  for (const path of CONFIGURATION)
    if (present.has(path)) assert.ok(tracked.has(path), `untracked compiler configuration ${path}`);
  for (const path of tracked)
    if (
      path === 'tools/package.json' ||
      (path.startsWith('src/') && path.endsWith('/package.json'))
    )
      configuration.add(path);
  const config = ts.getParsedCommandLineOfConfigFile(
    join(root, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      readFile: (path) => {
        const local = relative(root, path).replaceAll('\\', '/');
        assert.ok(
          !isAbsolute(local) && !local.split(/[\\/]/).includes('..') && tracked.has(local),
          'compiler configuration must be tracked inside its checkout',
        );
        configuration.add(local);
        return ts.sys.readFile(path);
      },
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  assert.ok(config, 'missing compiler TypeScript configuration');
  assert.equal(config.errors.length, 0, 'invalid compiler TypeScript configuration');
  const paths = [
    ...new Set([
      ...[...tracked].filter((path) => path.startsWith('src/')),
      ...configuration,
      ...HELPERS,
    ]),
  ].sort();
  assert.ok(paths.some((path) => path.startsWith('src/') && path.endsWith('.ts')));
  const inputs = await Promise.all(
    paths.map(async (path): Promise<SourceCompilerInput> => {
      assert.ok((await lstat(join(root, path))).isFile(), `compiler input must be a file: ${path}`);
      return {
        path,
        sha256: createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      };
    }),
  );
  return {
    inputs,
    configuration: [...configuration].sort(),
    build: { node: process.version, typescript: ts.version },
    checkout: {
      commit: git('rev-parse', 'HEAD'),
      tree: git('rev-parse', 'HEAD^{tree}'),
      dirty: git('status', '--porcelain', '--untracked-files=normal') !== '',
    },
  };
}
