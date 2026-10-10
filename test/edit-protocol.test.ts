import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAndValidate } from '../src/core.js';
import { EditSession, typedTargetView } from '../src/edit.js';
import {
  billed,
  cachedWeights,
  systemWeights,
  verdict,
  wilson,
} from '../tools/edit-protocol-summary.js';

const SRC =
  'fn fits u32 u32 -> bool\nret lt p0 p1\nend\nfn other u32 -> u32\nret p0\nend\nfn caller u32 u32 -> bool\nr call fits p0 p1\nret r\nend\n';

test('typedTargetView: full typed target header, unshown neighbours listed', () => {
  const program = parseAndValidate(SRC);
  const s = new EditSession(program);
  const text = s.open('fits', { scope: 'bodies', dense: true }).text;
  const view = typedTargetView(text.slice(text.indexOf('\n') + 1), program, 'fits');
  assert.equal(view.split('\n')[0], 'fn fits u32 u32 -> bool ret lt A B');
  assert.ok(view.includes('# caller u32 u32 -> bool'));
  assert.ok(!view.includes('other'));
});

test('cache rule: a system text below the minimum bills weight 1 on every call', () => {
  assert.deepEqual(systemWeights(200, 'haiku', 'unbounded'), [1, 1]);
  assert.deepEqual(systemWeights(600, 'sonnet', 'cold'), [1.25, 0.1]);
  const t = {
    accepted: true,
    acceptedOneShot: false,
    modelCalls: 2,
    tokenBucketsLocal: { languagePrimer: 200, workflowPrimer: 0, toolContext: 50, output: 10 },
  };
  assert.equal(billed(t, 'haiku', 'unbounded'), 260);
});

test('cache weights: per-model read, write paid once per horizon', () => {
  const close = (x: readonly [number, number], y: [number, number]) =>
    assert.ok(Math.abs(x[0] - y[0]) < 1e-12 && Math.abs(x[1] - y[1]) < 1e-12, `${x} vs ${y}`);
  close(cachedWeights('haiku', 'cold'), [1.25, 0.1]);
  close(cachedWeights('sonnet', 'session10'), [(1.25 + 9 * 0.1) / 10, 0.1]);
  close(cachedWeights('haiku', 'session50'), [(1.25 + 49 * 0.1) / 50, 0.1]);
  close(cachedWeights('sonnet', 'unbounded'), [0.1, 0.1]);
  close(cachedWeights('opus', 'session10'), [(1.25 + 9 * 0.05) / 10, 0.05]);
  assert.throws(() => cachedWeights('unknown', 'cold'));
});

test('wilson interval and the pre-registered verdict', () => {
  const [lo, hi] = wilson(5, 10);
  assert.ok(lo < 0.5 && hi > 0.5);
  const cell = (acc: number, cost: number) => ({
    n: 10,
    oneShot: acc,
    accepted: acc,
    perAccepted: { cold: cost, session10: cost, session50: cost, unbounded: cost },
  });
  assert.equal(verdict(cell(10, 90), cell(10, 100)).pass, true);
  assert.ok(
    verdict(cell(10, 99.5), cell(10, 100)).losses.includes('tokens per accepted edit (cold)'),
  );
  assert.ok(verdict(cell(9, 90), cell(10, 100)).losses.includes('after-repair acceptance'));
});
