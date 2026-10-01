import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkFile, loadsIn } from '../tools/dev/claim-check.js';
import { BUILD, COMMANDS, plan, pushDecision, resultLine, runGate } from '../tools/dev/dev-gate.js';
import { drive } from '../tools/dev/drive.js';
import { noteCovers, writeNote } from '../tools/dev/gate-note.js';
import {
  ALL_STEPS,
  addSteps,
  computeScope,
  parseSteps,
  type StepId,
} from '../tools/dev/gate-scope.js';
import { decideFailure, type HistoryRow, signature } from '../tools/dev/history.js';
import {
  benchValidity,
  detectStuck,
  launchGate,
  rankTasks,
  verifyReport,
} from '../tools/dev/loop-checks.js';
import { type LoopLog, summarize } from '../tools/dev/loop-log.js';
import {
  type BranchInfo,
  buildPair,
  loadBranch,
  type Pair,
  planBatches,
} from '../tools/dev/merge-plan.js';
import { orderIds, sentinels } from '../tools/dev/order.js';
import { reviewDiff } from '../tools/dev/prereview.js';
import { buildQueue } from '../tools/dev/queue.js';
import { classifyByRules } from '../tools/dev/reply-classify.js';

// dist/test/dev-tools.test.js -> repo root is two levels up.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ids = (files: string[], light = false): StepId[] =>
  computeScope(REPO, files, { light }).steps.map((s) => s.step);

// --- gate-scope ------------------------------------------------------------------------------

test('gate-scope: docs-only and results-only changes run lint only', () => {
  assert.deepEqual(ids(['STATUS.md', 'README.md']), ['lint']);
  assert.deepEqual(ids(['results/app.json', 'results/verification.json']), ['lint']);
  assert.deepEqual(ids(['STATUS.md', 'results/gpu.json']), ['lint']);
});

test('gate-scope: one leaf backend runs its verify path and the core tests, not everything', () => {
  const s = ids(['src/riscv64.ts']);
  assert.ok(s.includes('verify') && s.includes('test'));
  assert.ok(!s.includes('app') && !s.includes('gpu') && !s.includes('bootstrap'));
  assert.ok(ids(['src/hw.ts']).includes('hw'));
  assert.ok(!ids(['src/hw.ts']).includes('verify'));
  assert.ok(ids(['src/arm64.ts']).includes('bootstrap'));
});

test('gate-scope: shared emitter, checker, optimizer and config run everything', () => {
  for (const f of ['src/optimize.ts', 'src/core.ts', 'src/backends.ts', 'package.json']) {
    assert.deepEqual(ids([f]), [...ALL_STEPS], f);
  }
});

test('gate-scope: self-hosted compiler and site files map through their closures', () => {
  const lex = ids(['compiler/lex.a0']);
  assert.ok(lex.includes('app') && lex.includes('bootstrap') && lex.includes('selfhost-c'));
  assert.ok(!lex.includes('gpu'));
  const tpl = ids(['site/gen/page.tpl']);
  assert.ok(tpl.includes('site') && tpl.includes('test'));
});

test('gate-scope: unknown source runs everything; --light keeps only the cheap steps', () => {
  assert.deepEqual(ids(['src/brand-new-backend.ts']), [...ALL_STEPS]);
  assert.deepEqual(ids(['src/optimize.ts'], true), ['lint', 'typecheck', 'test', 'site']);
  const light = computeScope(REPO, ['src/optimize.ts'], { light: true });
  assert.ok(light.skipped.some((s) => s.step === 'verify'));
});

test('gate-scope: every chosen step carries a reason; callers can only add steps', () => {
  const s = computeScope(REPO, ['src/riscv64.ts']);
  for (const step of s.steps) assert.ok(step.reasons.length > 0);
  const more = addSteps(s, ['gpu', 'verify'], 'test');
  assert.ok(more.steps.some((x) => x.step === 'gpu'));
  assert.equal(more.steps.length, s.steps.length + 1);
  assert.throws(() => parseSteps('verify,nonsense'));
});

test('gate-scope: strict results re-runs the step that writes a changed results file', () => {
  const strict = computeScope(REPO, ['results/app.json', 'results/exec-benchmark.json'], {
    strictResults: true,
  });
  assert.deepEqual(
    strict.steps.map((s) => s.step),
    ['lint', 'app'],
  );
  assert.deepEqual(ids(['results/app.json']), ['lint']);
});

// --- claim-check -----------------------------------------------------------------------------

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'a0-dev-test-'));
}

test('claim-check: claims need a nearby results reference; load above 10 flags speed claims', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'results'));
    writeFileSync(join(root, 'results', 'x.json'), '{"ratio": 3.2}\n');
    const md = [
      '## Supported',
      'A0 is 3.2x faster than C on this kernel (results/x.json).',
      '',
      '## Unsupported',
      'A0 is 9x faster than everything.',
      '',
      '## Loaded',
      'A0 is 2x faster, see results/x.json; load average 14 while measuring.',
      '',
      '## Missing file',
      'A0 uses 40% fewer tokens (results/nope.json).',
      '',
      '## Waived',
      'A0 is 5x smaller. claim-ok: counted by hand in the diff',
    ].join('\n');
    const f = checkFile(root, 'STATUS.md', md);
    const by = (needle: string) => f.find((x) => x.text.includes(needle));
    assert.deepEqual(by('3.2x')?.problems, []);
    assert.match(by('9x')?.problems[0] ?? '', /unsupported/);
    assert.match(by('is 2x faster')?.problems.join(' ') ?? '', /load 14/);
    assert.match(by('40%')?.problems.join(' ') ?? '', /missing results file/);
    assert.deepEqual(by('5x smaller')?.problems, []);
    assert.deepEqual(loadsIn('load average 10-23'), [10, 23]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('claim-check: template numbers from placeholders pass, hard-coded ones are flagged', () => {
  const root = scratch();
  try {
    const tpl = ['"$js_geomean$x faster than JavaScript', '=strong 7.3x fewer tokens read'].join(
      '\n',
    );
    const f = checkFile(root, 'site/gen/page.tpl', tpl);
    assert.deepEqual(f[0]?.problems, []);
    assert.match(f[1]?.problems[0] ?? '', /unsupported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- git-backed tools (merge-plan, notes, drive) ---------------------------------------------

function sh(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tempRepo(): string {
  const repo = scratch();
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 'T');
  mkdirSync(join(repo, 'src'));
  for (const f of ['riscv64', 'avr', 'core'])
    writeFileSync(join(repo, 'src', `${f}.ts`), 'a\nb\nc\nd\ne\n');
  writeFileSync(join(repo, 'STATUS.md'), 'status\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

function branch(repo: string, name: string, file: string, content: string): void {
  sh(repo, 'checkout', '-q', '-b', name, 'main');
  writeFileSync(join(repo, file), content);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', `edit ${file}`);
  sh(repo, 'checkout', '-q', 'main');
}

test('merge-plan: independent branches batch together, coupled ones split with the riskiest first', () => {
  const repo = tempRepo();
  try {
    branch(repo, 'rv', 'src/riscv64.ts', 'a\nB\nc\nd\ne\n');
    branch(repo, 'avr', 'src/avr.ts', 'a\nb\nc\nD\ne\n');
    branch(repo, 'core1', 'src/core.ts', 'A\nb\nc\nd\ne\n');
    branch(repo, 'core2', 'src/core.ts', 'Z\nb\nc\nd\ne\n');
    const infos = ['rv', 'avr', 'core1', 'core2'].map((n) => loadBranch(repo, 'main', n));
    const pairs: ReturnType<typeof buildPair>[] = [];
    for (let i = 0; i < infos.length; i += 1) {
      for (let j = i + 1; j < infos.length; j += 1) {
        pairs.push(buildPair(repo, infos[i] as BranchInfo, infos[j] as BranchInfo));
      }
    }
    const pair = (a: string, b: string) => pairs.find((p) => p.a === a && p.b === b) as Pair;
    assert.equal(pair('rv', 'avr').hard, false);
    assert.deepEqual([...pair('rv', 'avr').sharedSteps].sort(), ['test', 'verify']);
    assert.equal(pair('core1', 'core2').hard, true);
    assert.deepEqual(pair('core1', 'core2').conflicts, ['src/core.ts']);
    const batches = planBatches(infos, pairs);
    // two shared-core branches cannot share a batch; the leaf backends can
    assert.equal(batches.length, 2);
    assert.ok(batches[0]?.branches.some((b) => b.startsWith('core')));
    const together = batches.find((b) => b.branches.includes('rv'));
    assert.ok(
      together?.branches.includes('avr') || batches.some((b) => b.branches.includes('avr')),
    );
    for (const b of batches) assert.ok(b.steps.length > 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gate-note: a passing note is bound to the tree and does not survive a content change', () => {
  const repo = tempRepo();
  try {
    assert.equal(noteCovers(repo, 'HEAD', ['lint']).ok, false);
    writeNote(repo, 'HEAD', { steps: ['lint', 'typecheck', 'test'], light: true, result: 'pass' });
    assert.equal(noteCovers(repo, 'HEAD', ['lint', 'test']).ok, true);
    assert.match(noteCovers(repo, 'HEAD', ['verify']).why, /does not cover verify/);
    // amend the commit with different content: same message, new tree
    const before = sh(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'src', 'core.ts'), 'changed\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '--amend', '-m', 'base');
    assert.notEqual(sh(repo, 'rev-parse', 'HEAD').trim(), before);
    assert.equal(noteCovers(repo, 'HEAD', ['lint']).ok, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

const OK = (id: string) => ({ id, cmd: 'true', timeoutMs: 10_000 });

test('drive: refuses branches without a note, merges the rest, reverts only the culprit', async () => {
  const repo = tempRepo();
  const out = scratch();
  try {
    branch(repo, 'good', 'src/avr.ts', 'a\nb\nc\nD\ne\n');
    branch(repo, 'bad', 'src/riscv64.ts', 'a\nB\nc\nd\ne\n');
    branch(repo, 'unnoted', 'src/core.ts', 'A\nb\nc\nd\ne\n');
    // a branch's gate note is on its tip; `bad` carries a marker file only after its merge fails
    const note = { steps: ['lint', 'typecheck', 'test'], light: true, result: 'pass' as const };
    writeNote(repo, 'good', note);
    writeNote(repo, 'bad', note);
    sh(repo, 'checkout', '-q', 'bad');
    writeFileSync(join(repo, 'src', 'riscv64.ts'), 'a\nBAD\nc\nd\ne\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'adds the breaking marker');
    sh(repo, 'checkout', '-q', 'main');
    writeNote(repo, 'bad', note);
    const commands = {
      lint: OK('lint'),
      typecheck: OK('typecheck'),
      build: OK('build'),
      verify: OK('verify'),
      test: { id: 'test', cmd: '! grep -q BAD src/riscv64.ts', timeoutMs: 10_000 },
    };
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    // plan only
    const dry = await drive({
      repo,
      base: 'main',
      branches: ['good', 'bad', 'unnoted'],
      merge: false,
      scratch: out,
      commands,
      log,
    });
    assert.deepEqual(
      dry.refused.map((r) => r.branch),
      ['unnoted'],
    );
    assert.match(dry.refused[0]?.why ?? '', /no gate note/);
    assert.deepEqual(dry.merged, []);
    // merge
    const r = await drive({
      repo,
      base: 'main',
      branches: ['good', 'bad', 'unnoted'],
      merge: true,
      scratch: out,
      commands,
      log,
    });
    assert.deepEqual(
      r.reverted.map((x) => x.branch),
      ['bad'],
    );
    assert.ok(r.merged.includes('good'));
    assert.ok(
      !readFileSync(join(repo, 'src', 'riscv64.ts'), 'utf8').includes('BAD'),
      'the culprit was reverted',
    );
    assert.equal(readFileSync(join(repo, 'src', 'avr.ts'), 'utf8'), 'a\nb\nc\nD\ne\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

// --- dev-gate --------------------------------------------------------------------------------

test('dev-gate: runs steps one at a time with logs, a clear final line, timeouts and a push refusal', async () => {
  const repo = tempRepo();
  const out = scratch();
  try {
    const lines: string[] = [];
    const runs = [
      { id: 'lint', cmd: 'echo linting', timeoutMs: 10_000 },
      { id: 'test', cmd: 'echo failing; exit 3', timeoutMs: 10_000 },
      { id: 'verify', cmd: 'true', timeoutMs: 10_000 },
    ];
    const r = await runGate({
      repo,
      runs,
      required: ['lint', 'test', 'verify'],
      light: false,
      keepGoing: false,
      scratch: out,
      log: (l) => lines.push(l),
    });
    assert.equal(r.pass, false);
    assert.equal(r.line, 'GATE RESULT: fail lint=0 test=3 verify=not-run');
    assert.equal(lines.at(-1), r.line);
    assert.match(readFileSync(r.results[0]?.log ?? '', 'utf8'), /linting/);
    assert.ok(r.dir.startsWith(out));
    // a timeout is a failure with rc 124
    const t = await runGate({
      repo,
      runs: [{ id: 'verify', cmd: 'sleep 5', timeoutMs: 300 }],
      required: ['verify'],
      light: false,
      keepGoing: false,
      scratch: out,
      log: () => undefined,
    });
    assert.equal(t.results[0]?.outcome, 'timeout');
    assert.equal(t.line, 'GATE RESULT: fail verify=124');
    // a pass of a clean commit writes the gate note
    const p = await runGate({
      repo,
      runs: [OK('lint')],
      required: ['lint'],
      light: true,
      keepGoing: false,
      scratch: out,
      log: () => undefined,
    });
    assert.equal(p.noted, true);
    assert.equal(noteCovers(repo, 'HEAD', ['lint']).ok, true);
    // push refusal: a missing, skipped or light run
    const results = [{ id: 'lint', outcome: 'pass' as const, rc: 0, ms: 1, log: null }];
    assert.equal(pushDecision(['lint'], results, false).allowed, true);
    assert.match(
      pushDecision(['lint', 'verify'], results, false).why.join(' '),
      /verify is missing/,
    );
    assert.match(pushDecision(['lint'], results, true).why.join(' '), /light/);
    assert.equal(resultLine(results, true), 'GATE RESULT: pass lint=0');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('dev-gate: plans lint and typecheck before the build, then the dist steps', () => {
  const order = plan(['verify', 'lint', 'test'], { ...COMMANDS, build: BUILD }).map((r) => r.id);
  assert.deepEqual(order, ['lint', 'build', 'verify', 'test']);
});

// --- history, ordering, decisions ------------------------------------------------------------

const row = (o: Partial<HistoryRow>): HistoryRow => ({
  tree: 'T',
  step: 'verify',
  rc: 1,
  sig: 's1',
  run: 'r1',
  at: '',
  base: false,
  ...o,
});

test('regress: flake needs two distinct runs, one failure is unexplained, base evidence decides', () => {
  assert.equal(decideFailure([row({})], 'verify', 'T', 'B').verdict, 'unexplained');
  const flake = decideFailure([row({}), row({ rc: 0, sig: '', run: 'r2' })], 'verify', 'T', 'B');
  assert.equal(flake.verdict, 'flake');
  assert.equal(flake.quarantine, true);
  const real = decideFailure(
    [row({}), row({ run: 'r2' }), row({ tree: 'B', rc: 0, sig: '', run: 'rb' })],
    'verify',
    'T',
    'B',
  );
  assert.equal(real.verdict, 'real-regression');
  const old = decideFailure([row({}), row({ tree: 'B', run: 'rb' })], 'verify', 'T', 'B');
  assert.equal(old.verdict, 'pre-existing');
  assert.match(decideFailure([row({})], 'verify', 'T', 'B').next, /second distinct run/);
  assert.equal(signature('error at /a/b/c 12 ms\nboom'), signature('error at /x/y 99 ms\nboom'));
});

test('order: cheap steps first, then riskiest per cost; sentinels are the first three after the build', () => {
  const all = ['site', 'verify', 'lint', 'test', 'build', 'typecheck', 'gpu'];
  const o = orderIds(all, []);
  assert.deepEqual(o.slice(0, 3), ['lint', 'typecheck', 'build']);
  assert.equal(o[3], 'test');
  assert.equal(sentinels(all, []).length, 3);
  // a step that keeps failing moves up
  const hist = Array.from({ length: 6 }, (_, i) => row({ step: 'gpu', run: `r${i}` }));
  assert.equal(orderIds(all, hist)[3], 'gpu');
});

// --- prereview, queue, replies ---------------------------------------------------------------

test('prereview: flags swallowed errors, fabricated constants and core special cases, passes clean diffs', () => {
  const diff = [
    '+++ b/test/x.test.ts',
    '@@ -0,0 +1,2 @@',
    '+assert.equal(f(7), 6464647);',
    '+++ b/src/core.ts',
    '@@ -10,0 +11,3 @@',
    '+  try { run(); } catch (e) {}',
    '+  if (kernel === "avgfloor") return 6464647;',
    '+  const ok = 1;',
  ].join('\n');
  const r = reviewDiff(diff);
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(kinds.includes('hidden-fallback'));
  assert.ok(kinds.includes('fabricated-const'));
  assert.ok(kinds.includes('framework-branch'));
  assert.equal(r.verdict, 'rework');
  const clean = reviewDiff('+++ b/src/avr.ts\n@@ -1,0 +2,1 @@\n+  const x = a + b;');
  assert.equal(clean.verdict, 'ok');
});

test('queue: failed groups rank by rows and generality, environment-blocked groups last', () => {
  const q = buildQueue({
    'results/a.json': {
      targets: {
        x: { status: 'failed', cases: 100, failures: ['mismatch in avgfloor'] },
        y: { status: 'failed', cases: 50, failures: ['mismatch in avgfloor'] },
        z: { status: 'blocked', cases: 5000, detail: 'qemu missing' },
        ok: { status: 'passed', cases: 9 },
      },
    },
  });
  assert.equal(q.length, 2);
  assert.equal(q[0]?.rows, 150);
  assert.equal(q[1]?.blocked, true);
});

test('classify: rules separate truncation, format slips, protocol ambiguity and model errors', () => {
  const c = (failures: string[], extra: object = {}) => classifyByRules({ failures, ...extra }).cls;
  assert.equal(c(['x'], { stopReason: 'max_tokens' }), 'truncation');
  assert.equal(c(['x'], { reply: 'text\n```ts\nconst a = 1;' }), 'truncation');
  assert.equal(c(["expected handle f1, got 'f2'"]), 'format-slip');
  assert.equal(c(['line 9 out of range (file has 4 lines)']), 'protocol-ambiguity');
  assert.equal(c(['avgfloor(1,2) = 0, expected 3']), 'model-error');
  assert.equal(c(['???']), 'unknown');
});

// --- loop checks -----------------------------------------------------------------------------

test('loop checks: stuck, benchmark validity, launch gate, ranking, report verification', () => {
  const base = {
    outAgeSec: 30,
    logAgeSec: 900,
    load1: 2,
    cpus: 8,
    finishedMarker: false,
    processAlive: true,
  };
  assert.equal(detectStuck(base).state, 'progressing');
  assert.equal(detectStuck({ ...base, outAgeSec: 900 }).state, 'stuck');
  assert.equal(detectStuck({ ...base, outAgeSec: 900, load1: 25 }).state, 'slow-from-load');
  assert.equal(
    detectStuck({ ...base, outAgeSec: 900, finishedMarker: true, processAlive: false }).state,
    'finished-waiting',
  );
  assert.equal(
    benchValidity({ loads: [3, 12], samples: 9, interleaved: true, cpus: 8 }).state,
    'loaded-discard',
  );
  assert.equal(
    benchValidity({ loads: [], samples: 9, interleaved: true, cpus: 8 }).state,
    'needs-rerun',
  );
  assert.equal(
    benchValidity({ loads: [2, 3], samples: 3, interleaved: true, cpus: 8 }).state,
    'needs-rerun',
  );
  assert.equal(
    benchValidity({ loads: [2, 3], samples: 7, interleaved: true, cpus: 8 }).state,
    'publishable',
  );
  assert.equal(launchGate({ load1: 12, cpus: 8, heavyRunning: 0 }).safe, false);
  assert.equal(launchGate({ load1: 1, cpus: 12, heavyRunning: 1 }).safe, true);
  assert.deepEqual(
    rankTasks([
      { name: 'a', gain: 1, effort: 2 },
      { name: 'b', gain: 3, effort: 1 },
    ]).map((t) => t.name),
    ['b', 'a'],
  );
  const root = scratch();
  try {
    mkdirSync(join(root, 'results'));
    writeFileSync(join(root, 'results', 'v.json'), '{"cases": 5603}\n');
    const claims = verifyReport(
      root,
      [
        'Verify passed 5603 cases (results/v.json).',
        'Verify passed 9999 cases (results/v.json).',
        'This should fix the slow path in most cases.',
        'The optimizer is 4x faster than before.',
        'Hello there.',
      ].join('\n'),
    );
    assert.deepEqual(
      claims.map((c) => c.cls),
      ['supported-by-evidence', 'contradicted', 'inference', 'from-memory'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loop log: speedup needs three quiet runs per mode; loaded runs are excluded', () => {
  const e = (mode: 'baseline' | 'assisted', ms: number, load1 = 1) => ({
    step: 'gate',
    mode,
    ms,
    load1,
    at: '',
  });
  const log: LoopLog = {
    meaning: '',
    entries: [
      e('baseline', 100),
      e('baseline', 120),
      e('baseline', 110),
      e('baseline', 9, 30),
      e('assisted', 50),
      e('assisted', 60),
      e('assisted', 55),
    ],
  };
  const s = summarize(log)[0];
  assert.equal(s?.baselineMs, 110);
  assert.equal(s?.speedup, 2);
  assert.equal(s?.excludedLoaded, 1);
  assert.equal(summarize({ meaning: '', entries: log.entries.slice(0, 5) })[0]?.speedup, null);
});

// --- no assistant vendor names in the public tree ---------------------------------------------

test('public tree: no tracked file names a decision-service vendor, model or key variable', () => {
  const names = ['je' + 'v', 'type' + 'safe', 'TYPE' + 'SAFE_API_KEY'];
  const rx = new RegExp(names.join('|'), 'i');
  const tracked = sh(REPO, 'ls-files', '-z').split('\0').filter(Boolean);
  const hits: string[] = [];
  for (const f of tracked) {
    if (/\.(png|jpg|ico|wasm|woff2?|zip|gz)$/.test(f)) continue;
    let text: string;
    try {
      text = readFileSync(join(REPO, f), 'utf8');
    } catch {
      continue;
    }
    if (rx.test(text) || rx.test(f)) hits.push(f);
  }
  assert.deepEqual(hits, []);
});
