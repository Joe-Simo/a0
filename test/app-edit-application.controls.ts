/** Explicit complete application controls. This file never launches a model. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { applicationEditPacket } from '../tools/app-edit-application-packet.js';
import { applicationSHA256 } from '../tools/app-edit-application-sources.js';
import { localTokens, prompt, selfCheck } from '../tools/app-edit-bench.js';
import { committedTree } from '../tools/measurement-checkout.js';
import { writeReport } from '../tools/scrub-results.js';

const directory = process.env.A0_SOURCE_PACKAGE;
const manifestSHA256 = process.env.A0_SOURCE_PACKAGE_SHA256;
assert.ok(
  directory && manifestSHA256,
  'fixed A0_SOURCE_PACKAGE and A0_SOURCE_PACKAGE_SHA256 required',
);

test('four complete application cases have applying reference/wrong controls in all three source arms', {
  timeout: 1_800_000,
}, async () => {
  const implementation = committedTree(process.cwd());
  const owner = await applicationEditPacket({ directory, manifestSHA256 });
  const results: Record<string, unknown>[] = [];
  let passed = true;
  try {
    assert.equal(owner.packet.tasks.length, 4);
    for (const surface of ['canonical', 'dense', 'native'] as const) {
      const guidePath =
        surface === 'native'
          ? 'experiments/primers/MODEL_GUIDE.native.txt'
          : surface === 'dense'
            ? 'MODEL_GUIDE.dense.txt'
            : 'MODEL_GUIDE.min.txt';
      const guide = await readFile(guidePath, 'utf8');
      const prompts = owner.packet.tasks.map((task) => {
        const initial = owner.packet.initial(task, surface);
        const value = prompt(
          'a0',
          task,
          initial.programs,
          guide,
          surface,
          initial.services,
          owner.packet,
        );
        return {
          task: task.id,
          system: value.system,
          user: value.user,
          tokens: { system: localTokens(value.system), user: localTokens(value.user) },
          systemSHA256: applicationSHA256(value.system),
          userSHA256: applicationSHA256(value.user),
        };
      });
      const result = await selfCheck(surface, undefined, 'a0', owner.packet);
      for (const row of result.rows) {
        console.log(
          `${surface}/${row.task}: reference=${row.referencePasses} startFails=${row.startFails} wrongApplies=${row.wrongApplies} witness=${row.wrongBehavioral}`,
        );
        if (!row.referencePasses) console.log(JSON.stringify(row.referenceFailures));
      }
      passed &&= result.ok && result.rows.length === 4;
      results.push({
        surface,
        guide: { path: guidePath, sha256: applicationSHA256(guide) },
        prompts,
        ...result,
      });
    }
    const implementationAfter = committedTree(process.cwd());
    assert.deepEqual(implementationAfter, implementation, 'source changed during controls');
    const report = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      implementation,
      implementationAfter,
      modelCalls: 0,
      status: passed ? 'pass' : 'fail',
      results,
      packet: owner.packet.metadata,
      limits:
        'Fixed generated-JavaScript backend and pinned native source package; correctness/capacity controls, no comparative timing or AI success claim.',
    };
    const output = process.env.A0_APPLICATION_CONTROL_REPORT;
    if (output) {
      await mkdir(dirname(output), { recursive: true });
      await writeReport(output, report);
      for (const task of owner.packet.tasks) {
        const initial = owner.packet.initial(task, 'native');
        await writeFile(`${output}.${task.id}.starter.a0`, initial.programs.a0);
      }
    }
    assert.ok(passed, 'one or more complete application controls failed; see captured rows');
  } finally {
    await owner.close();
  }
  await owner.close();
  const task = owner.packet.tasks[0];
  assert.ok(task);
  assert.throws(() => owner.packet.initial(task, 'native'), /closed/);
});
