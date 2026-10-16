/** Read-only replay of frozen, historical syntax studies. Never imported by the compiler. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getEncoding } from 'js-tiktoken';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const manifest = JSON.parse(read('./published-files.json'));
for (const [path, hash] of Object.entries(manifest)) assert.equal(sha(read(path)), hash, path);
const encoders = Object.fromEntries(['o200k_base', 'cl100k_base'].map((key) => [key, getEncoding(key)]));
let firsts = 0;
let repairs = 0;
for (const study of ['codex-v1', 'codex-v2']) {
  const { TASKS, selfCheck } = await import(`./${study}/evaluator.mjs`);
  const { judge } = await import(`./${study}/protocol.mjs`);
  const self = selfCheck();
  assert.equal(self.status, 'pass', study);
  const recorded = JSON.parse(read(`../../results/unification-${study}.json`));
  const accepted = new Map();
  for (const row of recorded.rows) {
    const task = TASKS.find((task) => task.id === row.task);
    assert.ok(task);
    const reply = read(`./${study}/trials/${row.id}/reply.a0.txt`);
    assert.equal(sha(reply), row.replySHA256, row.id);
    assert.deepEqual(judge(task, row.arm, reply), row.first, row.id);
    for (const [key, encoder] of Object.entries(encoders)) {
      assert.equal(encoder.encode(reply).length, row.replyTokens[key], `${row.id}/${key}`);
    }
    firsts += 1;
    if (row.repair !== null) {
      const repair = read(`./${study}/trials/${row.id}/repair.a0.txt`);
      assert.equal(sha(repair), row.repair.replySHA256, row.id);
      const { replySHA256: _hash, replyTokens: _reply, promptTokens: _prompt, ...outcome } = row.repair;
      assert.deepEqual(judge(task, row.arm, repair), outcome, `${row.id}/repair`);
      for (const [key, encoder] of Object.entries(encoders)) {
        assert.equal(encoder.encode(repair).length, row.repair.replyTokens[key], `${row.id}/repair/${key}`);
      }
      repairs += 1;
    }
    const ok = row.first.passed || row.repair?.passed === true;
    assert.equal(ok, row.accepted);
    accepted.set(row.arm, (accepted.get(row.arm) ?? 0) + Number(ok));
  }
  for (const [arm, total] of Object.entries(recorded.totals)) {
    assert.equal(accepted.get(arm), total.accepted, `${study}/${arm}`);
  }
  console.log(`${study}: ${recorded.rows.length} first submissions and all recorded repairs reproduced; independent base/reference/wrong controls pass`);
}
console.log(`PASS ${firsts} first submissions, ${repairs} repairs; source hashes and reply token counts verified`);
