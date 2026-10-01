/**
 * gate-scope: from a diff, which gate steps are needed. Free, local, deterministic.
 *
 * The map is static. Each gate step names its entry files; the import closure of those entries
 * (TypeScript `from './x.js'` edges and A0 `use "x.a0"` edges, read from the working tree) says which
 * source files the step exercises. A few rules sit on top of the closure because the backends all
 * hang off src/backends.ts, so a plain closure would say every backend change needs everything:
 * a leaf backend is mapped by hand to the steps that actually run it. Anything unmapped runs more,
 * never less. By default a results-only change runs lint only (the gate writes those files); with
 * `--strict-results` a changed results file also runs the step that reproduces it. Callers may only ADD steps (`--add-steps=a,b`); `--json` prints every decision with
 * its reasons so any wrapper can drive the tools.
 *
 *   node dist/tools/dev/gate-scope.js [--base=<ref>] [--files=a,b] [--light] [--strict-results] [--add-steps=a,b] [--json]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedFiles, defaultBase, defaultRepo } from './repo.js';

export type StepId =
  | 'lint'
  | 'typecheck'
  | 'test'
  | 'verify'
  | 'equiv'
  | 'hw'
  | 'app'
  | 'dotnet'
  | 'gpu'
  | 'selfhost'
  | 'selfhost-c'
  | 'bootstrap'
  | 'tokens'
  | 'site';

export interface StepInfo {
  readonly id: StepId;
  readonly what: string;
  /** Entry files whose import closure the step exercises. */
  readonly entries: readonly string[];
  /** Kept by --light. */
  readonly light: boolean;
}

export const STEPS: readonly StepInfo[] = [
  { id: 'lint', what: 'biome check plus claim-check on changed lines', entries: [], light: true },
  { id: 'typecheck', what: 'tsc --noEmit over src, test, tools', entries: [], light: true },
  {
    id: 'test',
    what: 'unit tests (node --test dist/test)',
    entries: [
      'test/core.test.ts',
      'test/edit.test.ts',
      'test/macho.test.ts',
      'test/mcp.test.ts',
      'test/parallel.test.ts',
      'test/security.test.ts',
      'test/sitegen.test.ts',
      'test/behavior.test.ts',
      'test/trap.test.ts',
      'test/loss-ledger.test.ts',
      'test/seed.test.ts',
    ],
    light: true,
  },
  {
    id: 'verify',
    what: 'differential corpus on every backend (tools/verify.ts)',
    entries: ['tools/verify.ts'],
    light: false,
  },
  { id: 'equiv', what: 'Z3 equivalence proofs', entries: ['tools/equiv-verify.ts'], light: false },
  {
    id: 'hw',
    what: 'SystemVerilog simulation and synthesis',
    entries: ['tools/hw-verify.ts'],
    light: false,
  },
  {
    id: 'app',
    what: 'Life and the self-hosted lexer, parser, checker and emitters',
    entries: ['tools/app.ts'],
    light: false,
  },
  { id: 'dotnet', what: 'C# backend', entries: ['tools/dotnet-verify.ts'], light: false },
  { id: 'gpu', what: 'Metal backend', entries: ['tools/gpu-verify.ts'], light: false },
  {
    id: 'selfhost',
    what: 'A0 AArch64 emitter against the TypeScript one',
    entries: ['tools/selfhost-verify.ts'],
    light: false,
  },
  {
    id: 'selfhost-c',
    what: 'A0 C emitter against the TypeScript one',
    entries: ['tools/selfhost-c.ts'],
    light: false,
  },
  {
    id: 'bootstrap',
    what: 'stage 1 to 3 fixed point (C, arm64, Mach-O)',
    entries: ['tools/bootstrap.ts', 'tools/bootstrap-arm64.ts', 'tools/bootstrap-macho.ts'],
    light: false,
  },
  {
    id: 'tokens',
    what: 'token counts of sources and emissions (tools/token-bench.ts; no timing)',
    entries: ['tools/token-bench.ts'],
    light: false,
  },
  {
    id: 'site',
    what: 'site build (page generator, wasm, render)',
    entries: ['tools/site-build.ts'],
    light: true,
  },
];

export const ALL_STEPS: readonly StepId[] = STEPS.map((s) => s.id);
const CODE_STEPS: readonly StepId[] = ['lint', 'typecheck'];

/**
 * src files imported by backends.ts (so by nearly every step) that only some steps really run:
 * the closure would over-approximate, so these are mapped by hand. Each list is a floor.
 */
export const LEAF_OVERRIDES: Readonly<Record<string, readonly StepId[]>> = {
  'src/riscv64.ts': ['test', 'verify'],
  'src/avr.ts': ['test', 'verify'],
  'src/arm32.ts': ['test', 'verify'],
  'src/x86_64.ts': ['test', 'verify'],
  'src/wasm.ts': ['test', 'verify', 'site'],
  'src/arm64.ts': ['test', 'verify', 'app', 'selfhost', 'bootstrap'],
  'src/arm64enc.ts': ['test', 'verify', 'app', 'selfhost', 'bootstrap'],
  'src/macho.ts': ['test', 'bootstrap'],
  'src/hw.ts': ['test', 'hw'],
  'src/dotnet.ts': ['test', 'dotnet'],
  'src/metal.ts': ['test', 'verify', 'gpu'],
  'src/parallel.ts': ['test', 'verify', 'gpu'],
  'src/link.ts': ['test', 'app', 'selfhost', 'selfhost-c', 'bootstrap', 'site'],
  'src/cache.ts': ['test'],
  'src/mcp.ts': ['test'],
  'src/cli.ts': ['test'],
};

/** Shared emitter, checker, optimizer, toolchain: everything runs. */
export const SHARED_CORE: readonly string[] = [
  'src/core.ts',
  'src/optimize.ts',
  'src/backends.ts',
  'src/edit.ts',
  'src/toolchain.ts',
];

/** Config that changes how every step builds or runs. */
const CONFIG_FILES: readonly string[] = [
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'biome.json',
  'tools/corpus.ts',
];

export interface StepReason {
  readonly step: StepId;
  readonly reasons: string[];
}

export interface Scope {
  readonly files: readonly string[];
  readonly steps: readonly StepReason[];
  /** Steps dropped by --light. */
  readonly skipped: readonly StepReason[];
  readonly light: boolean;
  readonly class: 'empty' | 'docs-or-results' | 'single-backend' | 'wide' | 'everything';
}

const importRe = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const useRe = /^\s*use\s+"([^"]+\.a0)"/gm;
const A0_DIRS = ['compiler', 'site', 'site/gen', 'examples'];

/** Files reached from `entry`: TS relative imports and A0 `use` lines. Paths are repo-relative. */
export function closureOf(root: string, entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  const abs = join(root, entry);
  if (!existsSync(abs)) return seen;
  seen.add(entry);
  const text = readFileSync(abs, 'utf8');
  if (entry.endsWith('.ts')) {
    for (const m of text.matchAll(importRe)) {
      const rel = posix.normalize(
        posix.join(posix.dirname(entry), (m[1] as string).replace(/\.js$/, '.ts')),
      );
      closureOf(root, rel, seen);
    }
  } else if (entry.endsWith('.a0')) {
    for (const m of text.matchAll(useRe)) {
      const name = m[1] as string;
      for (const d of [posix.dirname(entry), ...A0_DIRS]) {
        const cand = posix.normalize(posix.join(d, name));
        if (existsSync(join(root, cand))) {
          closureOf(root, cand, seen);
          break;
        }
      }
    }
  }
  return seen;
}

/** Data and sources a step reads that no import names. */
function dataDeps(root: string): Map<StepId, string[]> {
  const list = (d: string, ext: string): string[] =>
    existsSync(join(root, d))
      ? readdirSync(join(root, d))
          .filter((f) => f.endsWith(ext))
          .map((f) => `${d}/${f}`)
      : [];
  const examples = list('examples', '.a0');
  const compiler = list('compiler', '.a0');
  const siteAll = [...list('site', '.a0'), ...list('site/gen', '.a0'), ...list('site/gen', '.tpl')];
  return new Map<StepId, string[]>([
    ['app', [...examples, ...compiler, 'site/ui.a0']],
    ['selfhost', [...examples, 'compiler/emit_arm64.a0']],
    ['selfhost-c', [...examples, 'compiler/emit_c.a0']],
    ['bootstrap', [...examples, 'compiler/boot.a0', 'compiler/front512.a0']],
    ['tokens', [...examples, 'MODEL_GUIDE.min.txt']],
    [
      'site',
      [
        ...siteAll,
        'site/app.ts',
        'site/wire.ts',
        'site/index.html',
        'site/docs.html',
        'site/favicon.svg',
        'site/gen/style.css',
        'site/gen/scene.glsl',
        'MODEL_GUIDE.min.txt',
      ],
    ],
    [
      'test',
      [
        'site/gen/sitegen.a0',
        ...list('site/gen', '.tpl'),
        // The seed (seed/) compiles compiler/*.a0: a compiler change makes it stale (test/seed.test.ts).
        ...compiler,
        ...['a0c-seed.c', 'stage-main.c', 'driver.c', 'bootstrap.sh', 'plan.txt', 'MANIFEST'].map(
          (f) => `seed/${f}`,
        ),
      ],
    ],
  ]);
}

export interface StepMap {
  readonly closures: ReadonlyMap<StepId, ReadonlySet<string>>;
}

export function buildStepMap(root: string): StepMap {
  const data = dataDeps(root);
  const closures = new Map<StepId, Set<string>>();
  for (const s of STEPS) {
    const set = new Set<string>();
    for (const e of s.entries) closureOf(root, e, set);
    for (const d of data.get(s.id) ?? []) closureOf(root, d, set);
    closures.set(s.id, set);
  }
  return { closures };
}

const isDoc = (f: string): boolean =>
  /\.(md|txt)$/.test(f) ||
  f === 'LICENSE' ||
  f === '.gitignore' ||
  f.startsWith('.github/') ||
  f === 'tools/release.sh' ||
  /^tools\/ai-edit-tasks-[a-f]\.(sha256)$/.test(f);
const isResults = (f: string): boolean => f.startsWith('results/');

type Add = (step: StepId, why: string) => void;

/** Results files a gate step writes. */
export const RESULT_STEP: Readonly<Record<string, StepId>> = {
  'results/verification.json': 'verify',
  'results/equivalence.json': 'equiv',
  'results/hardware.json': 'hw',
  'results/app.json': 'app',
  'results/dotnet.json': 'dotnet',
  'results/gpu.json': 'gpu',
  'results/selfhost.json': 'selfhost',
  'results/selfhost-c.json': 'selfhost-c',
  'results/bootstrap.json': 'bootstrap',
  'results/bootstrap-arm64.json': 'bootstrap',
  'results/bootstrap-macho.json': 'bootstrap',
  'results/tokens.json': 'tokens',
};

function classify(
  file: string,
  map: StepMap,
  add: Add,
  strictResults: boolean,
): 'doc' | 'results' | 'code' {
  if (isResults(file)) {
    const step = RESULT_STEP[file];
    if (strictResults && step) {
      add('lint', `${file} changed`);
      add(
        step,
        `${file} is written by ${step}; strict results re-runs the step that reproduces it`,
      );
      return 'code';
    }
    return 'results';
  }
  if (isDoc(file)) return 'doc';
  if (CONFIG_FILES.includes(file)) {
    for (const s of ALL_STEPS) add(s, `${file} is shared build config`);
    return 'code';
  }
  for (const s of CODE_STEPS) add(s, `${file} is code`);
  if (SHARED_CORE.includes(file)) {
    for (const s of ALL_STEPS) add(s, `${file} is shared emitter/checker/optimizer/toolchain code`);
    return 'code';
  }
  const leaf = LEAF_OVERRIDES[file];
  if (leaf) {
    for (const s of leaf)
      add(s, `${file} is a leaf backend or module mapped to ${leaf.join(', ')}`);
    return 'code';
  }
  if (file.startsWith('tools/dev/')) {
    add('test', `${file} is a dev tool covered by test/dev-tools.test.ts`);
    return 'code';
  }
  if (file.startsWith('test/')) {
    add('test', `${file} is a test`);
    return 'code';
  }
  if (file.startsWith('seed/')) {
    add('test', `${file} is part of the bootstrap seed, checked by test/seed.test.ts`);
    return 'code';
  }
  let hit = false;
  for (const [step, set] of map.closures) {
    if (set.has(file)) {
      add(step, `${file} is in the ${step} closure`);
      hit = true;
    }
  }
  if (hit) return 'code';
  // Unmapped: err on the side of running more.
  if (file.startsWith('src/') || file.startsWith('compiler/') || file.startsWith('examples/')) {
    for (const s of ALL_STEPS) add(s, `${file} is unmapped source, so everything runs`);
  } else if (file.startsWith('tools/') || file.startsWith('site/')) {
    add('test', `${file} is not in any step closure; running unit tests to be safe`);
    if (file.startsWith('site/')) add('site', `${file} is under site/`);
  } else {
    for (const s of ALL_STEPS) add(s, `${file} is unrecognised, so everything runs`);
  }
  return 'code';
}

export function computeScope(
  root: string,
  files: readonly string[],
  opts: { readonly light?: boolean; readonly strictResults?: boolean } = {},
): Scope {
  const map = buildStepMap(root);
  const reasons = new Map<StepId, string[]>();
  const add: Add = (step, why) => {
    const r = reasons.get(step) ?? [];
    if (!r.includes(why) && r.length < 6) r.push(why);
    reasons.set(step, r);
  };
  let code = 0;
  let docResults = 0;
  for (const f of files) {
    if (classify(f, map, add, opts.strictResults === true) === 'code') code += 1;
    else docResults += 1;
  }
  if (files.length > 0 && code === 0) {
    add('lint', `only docs/results changed (${docResults} files): lint only`);
  }
  const ordered = ALL_STEPS.filter((s) => reasons.has(s));
  const chosen: StepReason[] = ordered.map((s) => ({ step: s, reasons: reasons.get(s) ?? [] }));
  const keep = (s: StepReason): boolean =>
    !opts.light || (STEPS.find((x) => x.id === s.step)?.light ?? false);
  const steps = chosen.filter(keep);
  const skipped = chosen.filter((s) => !keep(s));
  const gateSteps = steps.filter((s) => s.step !== 'lint' && s.step !== 'typecheck');
  const cls: Scope['class'] =
    files.length === 0
      ? 'empty'
      : code === 0
        ? 'docs-or-results'
        : chosen.length === ALL_STEPS.length
          ? 'everything'
          : gateSteps.length > 0 && gateSteps.length <= 5 && onlyOneBackend(files)
            ? 'single-backend'
            : 'wide';
  return { files, steps, skipped, light: opts.light === true, class: cls };
}

function onlyOneBackend(files: readonly string[]): boolean {
  const backends = files.filter((f) => f in LEAF_OVERRIDES && f !== 'src/link.ts');
  return backends.length >= 1 &&
    backends.length === files.filter((f) => !isResults(f) && !isDoc(f)).length
    ? backends.length === 1
    : false;
}

/**
 * Adds steps on a caller's say-so (`--add-steps`). The deterministic floor is never reduced: a
 * wrapper, ours or a contributor's own, can only ask for more steps.
 */
export function addSteps(scope: Scope, extra: readonly StepId[], why: string): Scope {
  const add = extra.filter((e) => !scope.steps.some((s) => s.step === e));
  if (add.length === 0) return scope;
  const steps: StepReason[] = [
    ...scope.steps,
    ...add.map((step) => ({ step, reasons: [`added by caller: ${why}`] })),
  ].sort((x, y) => ALL_STEPS.indexOf(x.step) - ALL_STEPS.indexOf(y.step));
  return { ...scope, steps, skipped: scope.skipped.filter((k) => !add.includes(k.step)) };
}

export function parseSteps(list: string | undefined): StepId[] {
  const names = (list ?? '').split(',').filter(Boolean);
  const bad = names.filter((n) => !(ALL_STEPS as readonly string[]).includes(n));
  if (bad.length) throw new Error(`unknown step ${bad.join(', ')}`);
  return names as StepId[];
}

export function renderScope(scope: Scope): string {
  const out: string[] = [];
  out.push(
    `gate-scope: ${scope.files.length} changed files, class ${scope.class}${scope.light ? ', light' : ''}`,
  );
  for (const s of scope.steps) out.push(`  run   ${s.step.padEnd(10)} ${s.reasons.join('; ')}`);
  for (const s of scope.skipped)
    out.push(`  skip  ${s.step.padEnd(10)} (--light; the full gate still needs it)`);
  if (scope.steps.length === 0) out.push('  nothing to run');
  return out.join('\n');
}

function arg(args: readonly string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repo = arg(args, 'repo') ?? defaultRepo();
  const base = arg(args, 'base') ?? defaultBase(repo);
  const filesArg = arg(args, 'files');
  const files = filesArg ? filesArg.split(',').filter(Boolean) : changedFiles(repo, base);
  let scope = computeScope(repo, files, {
    light: args.includes('--light'),
    strictResults: args.includes('--strict-results'),
  });
  scope = addSteps(scope, parseSteps(arg(args, 'add-steps')), '--add-steps');
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ base, ...scope }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`base ${base}\n${renderScope(scope)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
