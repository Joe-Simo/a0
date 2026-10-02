import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  type BehaviorReport,
  buildReport,
  deriveTable,
  runTarget,
  SKIPS,
  select,
  TARGETS,
  tableSha256,
  validateLedger,
} from '../tools/behavior.js';
import { BEHAVIOR_SPEC } from '../tools/behavior-spec.js';
import { BEHAVIOR_TABLE } from '../tools/behavior-table.js';

test('behavior: the table is the interpreter and the BigInt oracle, row for row', () => {
  // Re-derived from the spec: no inline expected value can have been typed or edited by hand.
  assert.deepEqual(
    JSON.parse(JSON.stringify(BEHAVIOR_TABLE)),
    JSON.parse(JSON.stringify(deriveTable())),
  );
  assert.ok(Object.values(BEHAVIOR_TABLE).every((rows) => rows.length > 0));
});

test('behavior: the skip ledger names real targets, programs and functions, each with a reason', () => {
  assert.deepEqual(validateLedger(), []);
  // Every skip is in force: the program it names is really absent from the target's selection.
  for (const s of SKIPS) {
    if (s.program === '*') continue;
    const sel = select(s.target);
    assert.notEqual(sel.coverage[s.program], 'full', `${s.target}/${s.program} is skipped`);
    for (const c of sel.cases) if (s.fn !== undefined) assert.notEqual(c.functionName, s.fn);
  }
  // The selection a target gets is the table minus exactly its ledger entries.
  const total = Object.values(BEHAVIOR_TABLE).reduce((n, r) => n + r.length, 0);
  assert.equal(select('js').cases.length, total);
  const ioRows = (BEHAVIOR_TABLE.io ?? []).length;
  // The strict and checked-op programs run on the interpreter, the optimizer, js, the C paths,
  // Java, .NET, both wasm paths and the direct arm64, x86_64, riscv64, arm32 and avr backends
  // (minus the programs that read input, which they cannot run).
  const strictRows = BEHAVIOR_SPEC.filter((p) => p.profile === 'strict' || p.checkedOps === true)
    .map((p) => (BEHAVIOR_TABLE[p.name] ?? []).length)
    .reduce((n, r) => n + r, 0);
  assert.ok(strictRows > 0);
  for (const id of ['arm64', 'x86_64', 'riscv64', 'arm32', 'avr'])
    assert.equal(select(id).cases.length, total - ioRows, id);
  assert.equal(select('c-clang').cases.length, total);
  for (const id of ['java', 'dotnet', 'wasm-c', 'wasm-direct'])
    assert.equal(select(id).cases.length, total, id);
});

test('behavior: a wrong expected value fails on a backend (the check is not vacuous)', async () => {
  const group = select('js').groups[0];
  assert.ok(group !== undefined);
  const first = group.cases[0];
  assert.ok(first !== undefined && typeof first.expected === 'number');
  const wrong = { ...first, expected: (first.expected + 1) >>> 0 };
  const js = TARGETS.find((t) => t.id === 'js');
  assert.ok(js);
  const r = await js.run(group.program, [wrong, ...group.cases.slice(1)]);
  assert.equal(r.status, 'failed');
  assert.match(r.failures?.[0] ?? '', /expected/);
  // A trap row is not vacuous either: a wrong trap line fails.
  const strict = select('js').groups.find((g) => g.profile === 'strict');
  const trapRow = strict?.cases.find((c) => c.expectedTrap !== undefined);
  assert.ok(strict !== undefined && trapRow !== undefined);
  const bent = {
    ...trapRow,
    expectedTrap: String(trapRow.expectedTrap).replace('bounds', 'divzero'),
  };
  const t = await js.run(strict.program, [bent, ...strict.cases.filter((c) => c !== trapRow)]);
  assert.equal(t.status, 'failed');
});

test('behavior: every program passes on every target or sits in the ledger', async () => {
  const results = [];
  for (const def of TARGETS) results.push(await runTarget(def)); // one target at a time
  const failed = results.filter((r) => r.status === 'failed');
  assert.deepEqual(
    failed.map((r) => `${r.id}: ${r.detail} ${(r.failures ?? []).slice(0, 2).join(' | ')}`),
    [],
  );
  for (const r of results) {
    for (const [program, status] of Object.entries(r.programs)) {
      if (status === 'skipped' || status === 'partial')
        assert.ok(
          SKIPS.some((s) => s.target === r.id && (s.program === '*' || s.program === program)),
          `${r.id}/${program} is ${status} without a ledger entry`,
        );
    }
  }
  // The backends the table exists for must have run (blocked only when the tool is missing here).
  const required = [
    'interpreter',
    'js',
    'c-clang',
    'java',
    'dotnet',
    'wasm-c',
    'wasm-direct',
    'arm64',
    'x86_64',
    'riscv64',
    'avr',
    'arm32',
    'metal',
    'selfhost-c',
    'selfhost-arm64',
  ];
  for (const id of required) {
    const r = results.find((x) => x.id === id);
    assert.ok(r, `${id} is in the target list`);
    assert.ok(r.status === 'passed' || r.status === 'blocked', `${id}: ${r.status}`);
    if (r.status === 'blocked') assert.match(r.detail, /not found|needs|no /i, r.detail);
  }
  // The same report is what `bun run behavior` writes.
  const report = buildReport(results);
  assert.equal(report.summary.failed, 0);
});

test('behavior: results/behavior.json shows the same ledger and table as the code', async () => {
  const recorded = JSON.parse(await readFile('results/behavior.json', 'utf8')) as BehaviorReport;
  assert.deepEqual(recorded.skipLedger, [...SKIPS]);
  assert.equal(recorded.table.sha256, tableSha256());
  assert.equal(recorded.table.programs, BEHAVIOR_SPEC.length);
  assert.deepEqual(
    recorded.targets.map((t) => t.id),
    TARGETS.map((t) => t.id),
  );
  assert.equal(recorded.summary.failed, 0);
  // The recorded coverage matrix shows each ledger entry as a non-pass for that program.
  for (const s of SKIPS) {
    if (s.program === '*') continue;
    const cell = recorded.coverage[s.target]?.[s.program];
    assert.ok(cell === 'skipped' || cell === 'partial', `${s.target}/${s.program}: ${cell}`);
  }
});
