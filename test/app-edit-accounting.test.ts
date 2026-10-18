import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationCost, localTokens, prompt } from '../tools/app-edit-bench.js';
import { APP_TASKS } from '../tools/app-edit-tasks.js';

test('application edit token accounting includes the full visible repair conversation for both tokenizers', () => {
  const p = { system: 'language and workflow', user: 'change request and view Ω😀' };
  const first = 'incorrect response with work';
  const repair = 'Rejected: invalid operation; retry against the original view';
  const second = 'accepted response';
  const costs = conversationCost(p, [{ reply: first, repair }, { reply: second }]);
  for (const encoding of ['o200k_base', 'cl100k_base'] as const) {
    const t = (text: string) => localTokens(text)[encoding];
    assert.deepEqual(costs[encoding], {
      input: 2 * (t(p.system) + t(p.user)) + t(first) + t(repair),
      output: t(first) + t(second),
      total: 2 * (t(p.system) + t(p.user) + t(first)) + t(repair) + t(second),
      calls: [
        { input: t(p.system) + t(p.user), output: t(first) },
        { input: t(p.system) + t(p.user) + t(first) + t(repair), output: t(second) },
      ],
    });
  }
  assert.throws(() => conversationCost(p, [{ reply: first }, { reply: second }]), /no rejection/);
  for (const cost of Object.values(conversationCost(p, [])))
    assert.deepEqual(cost, { input: 0, output: 0, total: 0, calls: [] });
});

test('native application benchmark requires explicit language services, with no historical parser fallback', () => {
  const task = APP_TASKS[0];
  assert.ok(task);
  assert.throws(
    () => prompt('a0', task, { a0: '', ts: '' }, 'guide', 'native'),
    /explicit A0 services/,
  );
});
