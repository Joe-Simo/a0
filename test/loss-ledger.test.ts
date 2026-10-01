import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { withTempDir } from '../src/toolchain.js';
import {
  compare,
  isLoss,
  type Ledger,
  LOAD_LIMIT,
  nextLedger,
  type Observation,
  observations,
  readLedger,
} from '../tools/loss-ledger.js';

const obs = (over: Partial<Observation>): Observation => ({
  id: 'exec-benchmark|affine|ns-per-call|rust',
  source: 'exec-benchmark',
  kernel: 'affine',
  axis: 'ns-per-call',
  competitor: 'rust',
  a0: 5,
  other: 4,
  gap: 0.25,
  noise: 0.08,
  load: 3,
  ...over,
});

test('loss ledger: the checked-in ledger holds against the checked-in results', () => {
  const ledger = readLedger();
  const result = compare(ledger.entries, observations());
  assert.deepEqual(
    [...result.added, ...result.worsened.map((w) => w.now)].map((e) => e.id),
    [],
  );
  assert.ok(result.ok);
  // Every change carries its reason; one that grew the ledger carries a real one.
  assert.ok(ledger.history.length > 0 && ledger.history.every((h) => h.reason.length > 0));
  assert.ok(ledger.history.every((h) => h.added + h.worsened === 0 || h.reason.length >= 20));
});

test('loss ledger: every results source is read, and losses are recorded per kernel and axis', () => {
  const all = observations();
  for (const source of ['exec-benchmark', 'wasm-benchmark', 'lang-axes'])
    assert.ok(
      all.some((o) => o.source === source),
      `${source} gave observations`,
    );
  assert.ok(
    all.some((o) => o.source.startsWith('ai-edit:')),
    'ai-edit gave observations',
  );
  const kernels = new Set(all.filter((o) => o.source === 'exec-benchmark').map((o) => o.kernel));
  assert.ok(kernels.size >= 10, `exec-benchmark kernels: ${kernels.size}`);
  const ledger = readLedger();
  assert.ok(ledger.entries.every((e) => e.kernel.length > 0 && e.axis.length > 0 && isLoss(e)));
});

test('loss ledger: timing recorded above load 10, or with no load, is flagged unverified', () => {
  for (const o of observations()) {
    const timing = o.load !== null || o.unverified !== undefined;
    if (!timing) continue;
    const expected = o.load === null || o.load > LOAD_LIMIT;
    assert.equal(o.unverified !== undefined, expected, `${o.id} load ${o.load}`);
  }
  const all = observations();
  // The wasm file has no load, so its timings are never verified.
  assert.ok(all.filter((o) => o.axis === 'ns-per-trip').every((o) => o.unverified !== undefined));
  // Token counts are deterministic: no load involved, never unverified.
  assert.ok(all.filter((o) => o.axis === 'tokens-kernel').every((o) => o.unverified === undefined));
});

test('loss ledger: a new loss fails, a worsened one fails, noise and ties pass', () => {
  const recorded = obs({});
  // The same loss within the recorded noise: fine.
  assert.ok(compare([recorded], [obs({ gap: 0.3 })]).ok);
  // Worse by more than the noise: fails and says which.
  const worse = compare([recorded], [obs({ gap: 0.5 })]);
  assert.equal(worse.ok, false);
  assert.equal(worse.worsened[0]?.now.id, recorded.id);
  // A loss that was never recorded: fails.
  const fresh = compare([], [recorded]);
  assert.equal(fresh.ok, false);
  assert.equal(fresh.added.length, 1);
  // A gap inside the tie band is a tie, not a loss.
  assert.ok(compare([], [obs({ gap: 0.05 })]).ok);
  // A recorded loss that went away is reported so the ledger can shrink, and is not a failure.
  const gone = compare([recorded], [obs({ gap: -0.2 })]);
  assert.ok(gone.ok);
  assert.equal(gone.improved.length, 1);
});

test('loss ledger: an unverified change is reported, never trusted as a pass or a failure', () => {
  const noisy = obs({ gap: 0.9, load: 40, unverified: 'recorded at load 40.0, above 10' });
  const r = compare([], [noisy]);
  assert.ok(r.ok);
  assert.equal(r.added.length, 0);
  assert.match(r.unverifiedChanges[0] ?? '', /^new loss .*load 40/);
  const held = compare([{ ...noisy, gap: 0.3 }], [noisy]);
  assert.ok(held.ok);
  assert.match(held.unverifiedChanges[0] ?? '', /^worse /);
  assert.equal(held.unverifiedHeld, 1);
});

test('loss ledger: growing it needs a reason; shrinking it does not', () => {
  const base: Ledger = {
    version: 1,
    meaning: 'm',
    loadLimit: LOAD_LIMIT,
    history: [
      { at: 'x', reason: 'initial ledger from results', added: 1, worsened: 0, removed: 0 },
    ],
    entries: [obs({})],
  };
  assert.throws(
    () => nextLedger(base, [obs({}), obs({ id: 'b', competitor: 'zig' })], undefined),
    /pass --reason/,
  );
  assert.throws(() => nextLedger(base, [obs({ gap: 0.9 })], 'too short'), /pass --reason/);
  const grown = nextLedger(
    base,
    [obs({ gap: 0.9 })],
    'the kernel was rewritten for the new calling convention',
  );
  assert.equal(grown.worsened, 1);
  assert.match(grown.ledger.history.at(-1)?.reason ?? '', /calling convention/);
  const shrunk = nextLedger(base, [obs({ gap: -0.1 })], undefined);
  assert.equal(shrunk.ledger.entries.length, 0);
  assert.equal(shrunk.removed, 1);
  assert.equal(shrunk.ledger.history.at(-1)?.reason, 'shrink only');
});

test('loss ledger: slowing a kernel in the recorded results is caught end to end', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'results'));
    for (const f of ['exec-benchmark.json', 'wasm-benchmark.json', 'lang-axes.json'])
      await cp(join('results', f), join(dir, 'results', f));
    const path = join(dir, 'results', 'exec-benchmark.json');
    const doc = JSON.parse(await readFile(path, 'utf8')) as {
      kernels: Record<string, { c: { emitted: { medianNsPerCall: number } } }>;
    };
    const kernel = Object.keys(doc.kernels)[0] as string;
    const before = compare(
      readLedger().entries,
      observations(dir).filter((o) => o.source !== 'ai-edit'),
    );
    assert.deepEqual(before.added, []);
    // A0's emitted C becomes 40% slower on one kernel: it now loses to C, Rust and the rest.
    (
      doc.kernels[kernel] as { c: { emitted: { medianNsPerCall: number } } }
    ).c.emitted.medianNsPerCall *= 1.4;
    await writeFile(path, JSON.stringify(doc), 'utf8');
    const after = compare(
      readLedger().entries,
      observations(dir).filter((o) => o.source !== 'ai-edit'),
    );
    assert.equal(after.ok, false);
    assert.ok(after.added.some((e) => e.kernel === kernel && e.axis === 'ns-per-call'));
  });
});

test('loss ledger: canonical A0 and dense A0 are separate subjects on the tokens axes', () => {
  const all = observations().filter((o) => o.axis === 'tokens-kernel');
  const canonical = all.filter((o) => o.subject === undefined && isLoss(o));
  const dense = all.filter((o) => o.subject === 'a0-dense' && isLoss(o));
  // The canonical losses stay recorded: many kernels, many competitors.
  assert.ok(canonical.length > 300, `canonical token losses: ${canonical.length}`);
  // Dense is recorded on its own rows, never merged into the canonical ones.
  assert.ok(dense.length > 0 && dense.every((o) => o.id.startsWith('lang-axes-dense|')));
  assert.ok(new Set(all.map((o) => o.id)).size === all.length, 'ids are unique');
  // The one kernel dense still loses is noop (the benchmark kernel is `add 0`, `mul 1`, `xor 0`).
  assert.deepEqual([...new Set(dense.map((o) => o.kernel))], ['noop']);
  const ledger = readLedger();
  assert.ok(ledger.entries.some((e) => e.subject === 'a0-dense' && e.kernel === 'noop'));
  assert.ok(ledger.entries.some((e) => e.axis === 'tokens-kernel' && e.subject === undefined));
});
