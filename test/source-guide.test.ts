import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { run, validate } from '../src/core.js';
import { programRevision } from '../src/edit.js';
import { formatSource, parseSource } from '../src/source.js';

test('candidate authoring examples validate, execute contracts and round-trip in one grammar', async () => {
  const guide = await readFile('docs/design/candidate-authoring.md', 'utf8');
  const blocks = [...guide.matchAll(/```a0\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  assert.equal(blocks.length, 3);
  const samples: Record<string, readonly [number, number]> = {
    answer: [7, 14],
    first: [3, 3],
    field: [9, 9],
    half: [8, 4],
  };
  for (const source of blocks) {
    const program = validate(parseSource(source));
    assert.equal(
      programRevision(validate(parseSource(formatSource(program)))),
      programRevision(program),
    );
    for (const fn of program.functions) {
      const sample = samples[fn.name];
      if (sample !== undefined) assert.equal(run(fn, [sample[0]]), sample[1]);
    }
  }
});
