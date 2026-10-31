/**
 * Local command-line interface.
 *
 *   a0 check <file.a0>...                (add --dense to any command to read dense text; `.a0d` files always are)
 *   a0 init [dir]         (AGENTS.md + agent rule files, src/agents.ts)
 *   a0 hook               (after-edit check for agent hooks: JSON on stdin)
 *   a0 run <file.a0> <function> <args...> [--fuel=N] [--max-trips=N]
 *   a0 emit <js|c|java|sv|arm64|x86_64|riscv64|avr|wasm|arm32> <file.a0> [out]
 *   a0 emit c --parallel[=auto|gpu] <file.a0> [out]   (automatic parallel folds, src/parallel.ts)
 *   a0 emit c --traps=N <file.a0> [out]   (trap runtime: stops past N fold/loop trips with one code line)
 *   a0 wasm <file.a0> <out.wasm>
 *   a0 patch <file.a0> <patch-file> [out.a0]
 *   a0 revision <file.a0> <function>
 *   a0 dense <file.a0> [out] [--normalize] [--comments]   (canonical to dense text, src/dense.ts)
 *   a0 canon <file.a0d> [out]             (dense text to canonical)
 *   a0 migrate <file> <new-directory> [--root=directory]   (verified source-dependency copy)
 *   a0 mcp <file-or-dir>   (MCP server over stdio, src/mcp.ts)
 *   a0 lsp [root]          (Language Server Protocol over stdio, src/lsp.ts)
 *
 * `emit wasm` writes the binary module of A0's own wasm32 backend (src/wasm.ts; no C, Clang,
 * or wasm-ld). `a0 wasm` builds the C-derived module instead: the C backend compiled by Clang
 * and linked by wasm-ld (the build the site ships); both have the same exports and io layout.
 */

import {
  A0Error,
  checkArgument,
  formatDiagnostic,
  formatSource,
  formatType,
  LIMITS,
  type Profile,
  parseAndValidate,
  run,
  type TypedProgram,
  type Value,
  validate,
} from './core.js';
import { diag } from './diagnostics.js';
import { link, parseFile } from './link.js';
import type { MigrationManifest } from './migrate.js';
import { readFile, writeFd } from './node-fs.js';
import { protectionPolicy, requireProtectedTarget } from './protection-policy.js';
import type { ContractResult } from './prove.js';
import { revision } from './revision.js';
import type { McpFrontend } from './source-edit.js';
import { COMPILER_VERSION, isTarget, TARGETS } from './targets.js';
import { A0_VERSION } from './version.js';

function usage(frontend?: McpFrontend): never {
  stderr(
    [
      'usage:',
      '  a0 --version                           # release and compiler version',
      '  a0 seal on|off|status|keygen|unlock|resume|share|rotate|revoke|export|import [root] [options]',
      '  a0 protect on|off|status [root]         # future releases; both controls default off',
      '  a0 check <file.a0>... [--json] [--fix] [--hints] [--prove [--deny-disproved] [--prove-timeout=MS]]    # --json: diagnostics as fields; --fix: apply the exact fixes; --prove: Z3 proof of pre/post',
      '  a0 explain [A0nnnn|--verify]           # what a diagnostic means, a failing and a fixed example',
      '  a0 run <file.a0> <function> <args...> [--fuel=N] [--max-trips=N]',
      `  a0 emit <${TARGETS.join('|')}> <file.a0> [out]`,
      '  a0 emit c --parallel[=auto|gpu] <file.a0> [out]   # threads (+ Metal when built as ObjC)',
      '  a0 emit c --traps=N <file.a0> [out]       # trip cap N; the stop prints one trap line, exit 3',
      '  a0 wasm <file.a0> <out.wasm>             # C backend + Clang + wasm-ld (emit wasm: direct)',
      '  a0 patch <file.a0> <patch-file> [out.a0]',
      '  a0 revision <file.a0> <function>',
      '  a0 dense <file.a0> [out] [--normalize] [--comments]   # canonical file to dense text',
      '  a0 canon <file.a0d> [out]               # dense file to canonical text',
      '  a0 migrate <file> <new-directory> [--root=directory]  # verified, lossless project copy',
      '  (any command: --dense reads files as dense text; .a0d files always are)',
      '  (--dense=a0 reads them with the dense reader written in A0, compiler/dense.a0)',
      "  (any command: --profile strict|canonical overrides the program's `profile` line; strict runs in the interpreter and on js, c, java, dotnet, wasm, riscv64, arm32 and avr)",
      '  a0 view <file.a0> <function>          # function plus callee signatures',
      '  a0 mcp <file-or-dir>                  # MCP server (stdio), paths confined to the root;',
      '      tools: a0_open a0_program a0_apply a0_check a0_run a0_emit a0_save',
      '  a0 lsp [root]                         # language server (stdio), files confined to root (default: cwd)',
      '  a0 init [dir]                         # AGENTS.md, CLAUDE.md/GEMINI.md pointers, agent rules',
      '  a0 hook                               # agent after-edit hook: tool-call JSON on stdin',
      '',
    ]
      .filter(
        (line) =>
          frontend === undefined ||
          !/ {2}a0 (dense|canon) |\(any command: --dense|\(--dense=a0/.test(line),
      )
      .map((line) =>
        frontend === undefined ? line : line.replace(/^ {2}a0 /, '  node .a0/cli.mjs '),
      )
      .join('\n'),
  );
  process.exit(2);
}

async function readSource(path: string): Promise<string> {
  protectionPolicy(path);
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > LIMITS.maxSourceBytes) throw diag('A0810');
  return text;
}

interface Invocation {
  readonly frontend?: McpFrontend;
  readonly profile?: Profile;
  readonly denseA0: boolean;
}

const sourceOwners = new WeakMap<TypedProgram, readonly string[]>();
function owners(program: TypedProgram): readonly string[] {
  const paths = sourceOwners.get(program);
  if (paths === undefined) throw new Error('missing source ownership for managed output');
  return paths;
}
async function writeOutput(
  sources: readonly string[],
  destination: string,
  data: string | Uint8Array,
): Promise<void> {
  const { writeManagedFile } = await import('./plaintext-write.js');
  await writeManagedFile(sources, destination, data);
}

/** Load through the invocation's single frontend and retain ownership for every output. */
async function loadProgram(
  path: string,
  dense: boolean,
  captureOwners: boolean,
  invocation: Invocation,
): Promise<TypedProgram> {
  const read = (p: string): Promise<string> => {
    protectionPolicy(p);
    return readFile(p, 'utf8');
  };
  const profile = invocation.profile === undefined ? {} : { profile: invocation.profile };
  const readDenseA0 = invocation.denseA0 ? (await import('./dense-a0.js')).readDenseA0 : undefined;
  const linked =
    invocation.frontend !== undefined
      ? await invocation.frontend.link(path, read, profile)
      : await link(path, read, {
          dense,
          ...(readDenseA0 !== undefined
            ? { denseReader: (text, used, p) => readDenseA0(text, used, p).text }
            : {}),
          ...profile,
        });
  if (captureOwners)
    sourceOwners.set(
      linked.program,
      linked.sources.map((source) => source.path),
    );
  return linked.program;
}

/** Take `--profile=NAME` or `--profile NAME` out of the arguments and remember it. */
function takeProfile(args: readonly string[]): { args: string[]; profile?: Profile } {
  const out: string[] = [];
  let profile: Profile | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    let name: string | undefined;
    if (a === '--profile') {
      name = args[i + 1];
      i += 1;
    } else if (a.startsWith('--profile=')) name = a.slice('--profile='.length);
    else {
      out.push(a);
      continue;
    }
    if (name !== 'strict' && name !== 'canonical') throw diag('A0814', ['--profile', name ?? '']);
    profile = name;
  }
  return { args: out, ...(profile === undefined ? {} : { profile }) };
}

/**
 * `a0 check --fix`: apply every exact fix to a single file, and write it only when the result is
 * accepted (a diagnostic with no exact fix leaves the file untouched and is reported by the check
 * that follows).
 */
async function fixFile(path: string, frontend?: McpFrontend): Promise<void> {
  const source = await readSource(path);
  if (/^\s*use\s/m.test(source)) return;
  const { fixAll } = await import('./fix.js');
  const out = fixAll(source, (t) => {
    if (frontend === undefined) parseAndValidate(t);
    else validate(frontend.syntax.parse(t));
  });
  if (out.applied.length === 0) return;
  if (out.error === undefined) {
    await writeOutput([path], path, out.text);
    stderr(`fixed ${out.applied.length} exact edit(s) in ${path}\n`);
  } else {
    stderr(
      `not written: ${out.applied.length} exact edit(s) apply, then ${formatDiagnostic(out.error, false)}\n`,
    );
  }
}

function parseValue(text: string): Value {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw diag('A0811', [text]);
  return Number(text);
}

/** The value of a `--name=N` flag (a non-negative integer), or undefined when absent. */
function flagNumber(args: readonly string[], name: string): number | undefined {
  const a = args.find((x) => x.startsWith(`${name}=`));
  if (a === undefined) return undefined;
  const text = a.slice(name.length + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw diag('A0814', [name, text]);
  return Number(text);
}

/** One line of `a0 check --prove`: proved, or the note or warning (an error with --deny-disproved). */
function formatContract(c: ContractResult, file: string | undefined, deny: boolean): string {
  const at = file === undefined ? '' : `${file}: `;
  if (c.status === 'proved')
    return `${at}${c.fn}: contract proved (${c.lines.join(' ')}, ${Math.round(c.ms)} ms)`;
  const level = c.status === 'unknown' ? 'note' : deny ? 'error' : 'warning';
  return `${at}${level}: ${formatDiagnostic(c.error, false)}`;
}

/** The CLI's own output: whole, synchronous writes to fd 1 and fd 2 (src/node-fs.ts writeFd). */
const stdout = (data: string | Uint8Array): void => writeFd(1, data);
const stderr = (text: string): void => writeFd(2, text);

/**
 * End a one-shot command. A natural exit frees the whole heap page by page before the process goes
 * (about 10 ms after a check of a large program); `process.exit` skips that teardown. Everything the
 * command printed has already been written (stdout and stderr above are synchronous). The exit code
 * is `process.exitCode`, as on a natural exit.
 */
function exitNow(): void {
  process.exit();
}

export async function main(args: readonly string[], frontend?: McpFrontend): Promise<void> {
  try {
    return await mainInvocation(args, frontend);
  } catch (error) {
    throw error instanceof A0Error ? (frontend?.diagnostic?.(error) ?? error) : error;
  }
}

async function mainInvocation(args: readonly string[], frontend?: McpFrontend): Promise<void> {
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V' || args[0] === 'version')) {
    stdout(`a0 ${A0_VERSION} (compiler ${COMPILER_VERSION})\n`);
    return;
  }
  const denseA0 = args.includes('--dense=a0');
  const dense = denseA0 || args.includes('--dense');
  const parsed = takeProfile(args.filter((a) => a !== '--dense' && a !== '--dense=a0'));
  const [cmd, ...rest] = parsed.args;
  if (
    frontend !== undefined &&
    ((dense && cmd !== 'migrate') || ['dense', 'canon'].includes(cmd ?? ''))
  )
    throw diag('A0814', [
      cmd ?? '',
      'command or legacy reader option is not available in a source-bound invocation',
    ]);
  const invocation: Invocation = {
    denseA0,
    ...(frontend === undefined ? {} : { frontend }),
    ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
  };
  const load = (path: string, dense: boolean, captureOwners = false) =>
    loadProgram(path, dense, captureOwners, invocation);
  switch (cmd) {
    case 'seal':
    case 'protect':
      await (await import('./protection/cli.js')).protectionCli(cmd, rest, frontend);
      return;
    case 'check': {
      const flags = rest.filter((a) => a.startsWith('--'));
      const files = rest.filter((a) => !a.startsWith('--'));
      if (
        files.length === 0 ||
        flags.some(
          (f) =>
            f !== '--json' &&
            f !== '--fix' &&
            f !== '--hints' &&
            f !== '--prove' &&
            f !== '--deny-disproved' &&
            !f.startsWith('--prove-timeout='),
        ) ||
        ((flags.includes('--deny-disproved') ||
          flags.some((f) => f.startsWith('--prove-timeout='))) &&
          !flags.includes('--prove'))
      )
        usage(frontend);
      const prove = flags.includes('--prove');
      const deny = flags.includes('--deny-disproved');
      const proveTimeout = flagNumber(flags, '--prove-timeout');
      const json = flags.includes('--json');
      const hints = flags.includes('--hints') ? '`a0 check --fix`' : false;
      let failed = 0;
      for (const file of files) {
        if (flags.includes('--fix')) await fixFile(file, frontend);
        let program: TypedProgram;
        try {
          program = await load(file, dense);
        } catch (e) {
          failed++;
          if (json && e instanceof A0Error) {
            const source = await readFile(file, 'utf8').catch(() => '');
            const { diagnosticLine } = await import('./fix.js');
            const line = diagnosticLine(source, e) ?? e.line ?? null;
            stdout(
              `${JSON.stringify({ ok: false, file, diagnostics: [{ ...e.toJSON(), line }] })}\n`,
            );
          } else {
            stderr(`${file}: error: ${formatDiagnostic(e, hints)}\n`);
          }
          continue;
        }
        const lines = program.functions.map(
          (fn) =>
            `${files.length > 1 ? `${file}: ` : ''}${fn.name} (${fn.params.map(formatType).join(', ')}) -> ${formatType(fn.result)}: ${fn.nodes.length} nodes, rev ${revision(fn).slice(0, 12)}`,
        );
        const contracts = prove
          ? await (await import('./prove.js')).proveContracts(
              program,
              proveTimeout === undefined ? {} : { timeoutMs: proveTimeout },
            )
          : [];
        if (deny && contracts.some((c) => c.status === 'disproved')) failed++;
        stdout(
          json
            ? `${JSON.stringify({
                ok: true,
                file,
                functions: lines,
                ...(prove
                  ? {
                      contracts: contracts.map((c) => ({
                        fn: c.fn,
                        status: c.status,
                        lines: c.lines,
                        ms: Math.round(c.ms),
                        ...(c.diagnostic === undefined ? {} : { diagnostic: c.diagnostic }),
                      })),
                    }
                  : {}),
              })}\n`
            : `${[...lines, ...contracts.map((c) => formatContract(c, files.length > 1 ? file : undefined, deny))].join('\n')}\n`,
        );
      }
      if (failed > 0) process.exitCode = 1;
      exitNow();
      return;
    }
    case 'explain': {
      const [what] = rest;
      if (frontend !== undefined && (!frontend.explain || !frontend.verifyExplanations))
        throw diag('A0814', ['explain', 'frontend has no diagnostic examples']);
      if (what === undefined) {
        stdout((await import('./explain.js')).explainIndex());
        return;
      }
      if (what === '--verify') {
        const problems =
          frontend === undefined
            ? (await import('./explain.js')).verifyExamples()
            : await frontend.verifyExplanations!();
        stdout(problems.length === 0 ? 'every example holds\n' : `${problems.join('\n')}\n`);
        if (problems.length > 0) process.exitCode = 1;
        return;
      }
      const text =
        frontend === undefined
          ? (await import('./explain.js')).explain(what)
          : await frontend.explain!(what);
      if (text === undefined) throw diag('A0813', [what]);
      stdout(text);
      return;
    }
    case 'init': {
      protectionPolicy(rest[0] ?? '.');
      if (frontend !== undefined && frontend.initializeProject === undefined)
        throw diag('A0814', ['init', 'frontend has no initialization capability']);
      const report =
        frontend === undefined
          ? await (await import('./agents.js')).init(rest[0] ?? '.')
          : await frontend.initializeProject!(rest[0] ?? '.');
      for (const p of report.written) stdout(`wrote ${p}\n`);
      for (const p of report.skipped) stdout(`kept ${p} (exists)\n`);
      return;
    }
    case 'hook': {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const out = await (await import('./agents.js')).hookResponse(
        Buffer.concat(chunks).toString('utf8'),
        (p) => load(p, false),
        frontend?.command,
      );
      if (out !== undefined) stdout(`${out}\n`);
      return;
    }
    case 'run': {
      const flags = rest.filter((a) => a.startsWith('--'));
      const [file, name, ...args] = rest.filter((a) => !a.startsWith('--'));
      if (file === undefined || name === undefined) usage(frontend);
      const program = await load(file, dense);
      const fn = program.byName.get(name);
      if (fn === undefined) throw diag('A0812', [name]);
      const values = args.map(parseValue);
      for (const [i, t] of fn.params.entries()) checkArgument(t, values[i] as Value, `p${i}`);
      const fuel = flagNumber(flags, '--fuel');
      const maxTrips = flagNumber(flags, '--max-trips');
      stdout(
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
      if (target === undefined || file === undefined || !isTarget(target)) usage(frontend);
      const protectedBuild = protectionPolicy(file).protect;
      if (protectedBuild) requireProtectedTarget(target);
      const program = await load(file, dense, true);
      const { compile } = await import('./backends.js');
      if (flag !== undefined) {
        const mode = flag === '--parallel' ? 'auto' : flag.slice('--parallel='.length);
        if (target !== 'c' || (mode !== 'auto' && mode !== 'gpu' && mode !== 'off'))
          usage(frontend);
        const cParallel = (await import('./parallel.js')).parallelC({ mode });
        const text = compile(program, 'c', cParallel === undefined ? {} : { cParallel }).text;
        if (out === undefined) stdout(text);
        else await writeOutput(owners(program), out, text);
        return;
      }
      if (trips !== undefined) {
        if (target !== 'c') usage(frontend);
        const text = compile(program, 'c', { cTrap: { maxTrips: trips } }).text;
        if (out === undefined) stdout(text);
        else await writeOutput(owners(program), out, text);
        return;
      }
      const { compileCached, DiskCache } = await import('./cache.js');
      const cache = process.env.A0_NO_CACHE === '1' ? undefined : new DiskCache(undefined, file);
      const { text, hits, misses } =
        cache === undefined
          ? { ...compile(program, target), hits: 0, misses: 0 }
          : await compileCached(program, target, cache);
      // The wasm target's text is the binary module in base64; the output gets the bytes.
      let data: string | Uint8Array =
        target === 'wasm' ? (await import('./wasm.js')).wasmModuleBytes(text) : text;
      if (protectedBuild)
        data = (await import('./protection/artifact.js')).protectWasm(data as Uint8Array).bytes;
      if (out === undefined) stdout(data);
      else await writeOutput(owners(program), out, data);
      if (process.env.A0_CACHE_STATS === '1') stderr(`cache: ${hits} hits, ${misses} misses\n`);
      return;
    }
    case 'wasm': {
      const [file, out] = rest;
      if (file === undefined || out === undefined) usage(frontend);
      // C-derived builds materialize intermediates in external tools. The reviewed direct adapter is explicit.
      if (protectionPolicy(file).protect)
        throw new Error('A0 protection: USE_EMIT_WASM_FOR_PROTECTED_BUILD');
      const program = await load(file, dense, true);
      const { compile } = await import('./backends.js');
      const { compileCached, DiskCache } = await import('./cache.js');
      const { compileWasm } = await import('./toolchain.js');
      const cache = process.env.A0_NO_CACHE === '1' ? undefined : new DiskCache(undefined, file);
      const cText =
        cache === undefined
          ? compile(program, 'c').text
          : (await compileCached(program, 'c', cache)).text;
      const build = await compileWasm(cText, cache);
      await writeOutput(owners(program), out, build.bytes);
      stdout(
        `${build.bytes.length} bytes via ${build.compiler} + ${build.linker}${build.cached ? ' (cached artifact)' : ''}\n`,
      );
      return;
    }
    case 'patch': {
      const [file, patchFile, out] = rest;
      if (file === undefined || patchFile === undefined) usage(frontend);
      const program = await load(file, dense, true);
      const { applyPatch, parsePatch } = await import('./edit.js');
      const patch = parsePatch(await readSource(patchFile), frontend?.syntax);
      const next = applyPatch(program, patch, frontend?.syntax);
      const text = frontend?.print(next) ?? formatSource(next);
      if (out === undefined) stdout(text);
      else await writeOutput([...owners(program), patchFile], out, text);
      return;
    }
    case 'view': {
      const [file, name] = rest;
      if (file === undefined || name === undefined) usage(frontend);
      const program = await load(file, dense);
      const fn = program.byName.get(name);
      if (fn === undefined) throw diag('A0812', [name]);
      const { EditSession, scopedView, scopedViewDense } = await import('./edit.js');
      const view =
        frontend === undefined
          ? dense
            ? scopedViewDense(fn, program, 'deps')
            : scopedView(fn)
          : new EditSession(program, { syntax: frontend.syntax })
              .open(name, { scope: 'deps' })
              .text.split('\n')
              .slice(1)
              .join('\n');
      stdout(`${view}\n`);
      return;
    }
    case 'revision': {
      const [file, name] = rest;
      if (file === undefined || name === undefined) usage(frontend);
      const program = await load(file, dense);
      const fn = program.byName.get(name);
      if (fn === undefined) throw diag('A0812', [name]);
      stdout(`${revision(fn)}\n`);
      return;
    }
    case 'dense': {
      const flags = rest.filter((a) => a.startsWith('--'));
      const [file, out] = rest.filter((a) => !a.startsWith('--'));
      if (file === undefined) usage(frontend);
      const paths: string[] = [];
      const { program, known } = await parseFile(file, (p) => {
        paths.push(p);
        protectionPolicy(p);
        return readFile(p, 'utf8');
      });
      const { formatDense, normalizeProgram } = await import('./dense.js');
      const shown = flags.includes('--normalize') ? normalizeProgram(program, known) : program;
      const text = formatDense(shown, { known, comments: flags.includes('--comments') });
      if (out === undefined) stdout(text);
      else await writeOutput(paths, out, text);
      return;
    }
    case 'migrate': {
      const flags = rest.filter((a) => a.startsWith('--'));
      const [file, out, ...extra] = rest.filter((a) => !a.startsWith('--'));
      if (
        file === undefined ||
        out === undefined ||
        extra.length > 0 ||
        flags.some((f) => !f.startsWith('--root=') || f === '--root=') ||
        flags.length > 1 ||
        denseA0 ||
        parsed.profile !== undefined
      )
        usage(frontend);
      const root = flags[0]?.slice('--root='.length);
      let manifest: MigrationManifest;
      if (frontend === undefined) {
        manifest = await (await import('./migrate.js')).migrateProject(file, out, root, dense);
      } else {
        if (frontend.migrateLegacy === undefined)
          throw diag('A0814', ['migrate', 'frontend has no legacy import capability']);
        manifest = await frontend.migrateLegacy(file, out, root, dense);
      }
      stdout(`${JSON.stringify(manifest, null, 2)}\n`);
      return;
    }
    case 'canon': {
      const [file, out] = rest;
      if (file === undefined) usage(frontend);
      const paths: string[] = [];
      const { program } = await parseFile(
        file,
        (p) => {
          paths.push(p);
          protectionPolicy(p);
          return readFile(p, 'utf8');
        },
        true,
      );
      const text = formatSource(program);
      if (out === undefined) stdout(text);
      else await writeOutput(paths, out, text);
      return;
    }
    case 'mcp': {
      const [root] = rest;
      if (root === undefined) usage(frontend);
      await (await import('./mcp.js')).serveStdio(root, frontend === undefined ? {} : { frontend });
      return;
    }
    case 'lsp': {
      // Editors pass `--stdio`; stdio is the only transport.
      const [root] = rest.filter((a) => a !== '--stdio');
      await (await import('./lsp.js')).serveLsp(root ?? process.cwd(), frontend);
      return;
    }
    default:
      usage(frontend);
  }
}

export function reportCliError(err: unknown): never {
  stderr(
    `error: ${formatDiagnostic(err, process.argv[2] === 'check' && process.argv.includes('--hints') ? '`a0 check --fix`' : false)}\n`,
  );
  process.exit(1);
}
