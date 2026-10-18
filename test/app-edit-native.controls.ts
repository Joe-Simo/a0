/** Explicit packaged runtime controls. No model subjects or build-freshness shortcut. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../src/core.js';
import {
  A0_PROTOCOL,
  checkStart,
  controlReply,
  judge,
  prompt,
  selfCheck,
  startPrograms,
} from '../tools/app-edit-bench.js';
import { nativeAppEditArm } from '../tools/app-edit-native.js';
import { APP_TASKS, START_SHA256 } from '../tools/app-edit-tasks.js';

const directory = process.env.A0_SOURCE_PACKAGE;
const manifestSHA256 = process.env.A0_SOURCE_PACKAGE_SHA256;
assert.ok(directory && manifestSHA256, 'A0_SOURCE_PACKAGE and A0_SOURCE_PACKAGE_SHA256 required');

test('native application arm migrates the sealed starter and passes all 14 independent control triples', {
  timeout: 600_000,
}, async () => {
  const historical = await startPrograms();
  checkStart(historical);
  const arm = await nativeAppEditArm(historical, { directory, manifestSHA256 });
  try {
    assert.equal(arm.metadata.starter.historicalSHA256, START_SHA256.a0);
    assert.equal(arm.metadata.starter.contentRevision, START_SHA256.a0);
    assert.equal(arm.metadata.starter.functions, 106);
    assert.notEqual(arm.programs.a0, historical.a0);
    const result = await selfCheck('native', arm, 'a0');
    assert.equal(result.rows.length, 14);
    for (const row of result.rows)
      assert.ok(
        row.referencePasses && row.startFails && row.wrongFails && row.wrongApplies,
        JSON.stringify(row),
      );
    assert.ok(result.ok);

    const task = APP_TASKS[0];
    assert.ok(task);
    const p = prompt('a0', task, arm.programs, 'actual native guide', 'native', arm.services);
    assert.equal(p.system, `actual native guide\n\n${A0_PROTOCOL}`);
    assert.ok(p.user.startsWith(task.instruction));
    assert.match(p.user, /fn lexstep/);
    assert.match(p.user, / -> /);
    // Raw fenced/CRLF replies follow the real session boundary, not extractBlock's old reader path.
    const reference = controlReply(
      task,
      arm.programs.a0,
      task.reference.a0,
      'native',
      arm.services,
      historical.a0,
    );
    const accepted = await judge(
      'a0',
      task,
      arm.programs,
      `\`\`\`a0\r\n# Ω😀\r\n${reference.replaceAll('\n', '\r\n')}\r\n\`\`\``,
      'native',
      arm.services,
    );
    assert.deepEqual(accepted.failures, []);
  } finally {
    arm.close();
  }
});

test('native guide syntax is accepted by the packaged grammar and historical aggregate spellings refuse', async () => {
  const arm = await nativeAppEditArm(await startPrograms(), { directory, manifestSHA256 });
  try {
    const program = arm.services.parse(`fn next _ _ _ -> _
s add A C
ret s
end
fn more _ _ _ -> bool
c lt B 2
ret c
end
fn sample _ _ -> _
a fold next 3 A B
b loop more next 9 A B
c << a 1
d >> c 1
r (d,)
v at r 0
xs [v*3]
ys [1, 2 3]
z get xs B
q select true z b
ret q
end
fn preserve _ _ -> _
ret A
end
fn echo io -> io
ret A
end
fn add _ _ -> _
x sub A B
ret x
end
fn explicit _ _ -> _
x call add A B
ret x
end
`);
    const sample = program.byName.get('sample');
    assert.ok(sample);
    assert.equal(run(sample, [2, 3]), 11);
    const preserve = arm.services.session(program).open('preserve', { scope: 'deps' });
    assert.match(preserve.text, /fn preserve _ _ -> _/);
    const explicit = program.byName.get('explicit');
    assert.ok(explicit);
    assert.equal(run(explicit, [9, 2]), 7);
    for (const aggregate of ['[1;2]', '(1)', '[1,]', '[1*02]'])
      assert.throws(() => arm.services.parse(`fn invalid\nx ${aggregate}\nret 0\nend\n`));
  } finally {
    arm.close();
  }
});

test('native arm refuses an unsealed starter before invoking a historical reader or package loader', async () => {
  await assert.rejects(
    nativeAppEditArm(
      { a0: 'not historical source', ts: '' },
      { directory: '', manifestSHA256: '' },
    ),
    /only the sealed historical starter/,
  );
});
