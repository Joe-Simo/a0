import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_OPS } from '../src/core.js';
import { auditSourceCoverage } from '../tools/source-coverage.js';

test('candidate source covers repository graphs and real static feature programs without semantic/output loss', async (t) => {
  const result = await auditSourceCoverage();
  assert.ok(result.graphs.length >= 184);
  assert.ok(result.legacyLiterals >= 485);
  assert.ok(result.candidateLiterals >= 546);
  assert.ok(result.nestedLegacyLiterals > 0);
  assert.ok(result.nestedCandidateLiterals > 0);
  assert.ok(result.literalFiles.includes('test/fixtures/owned-programs.ts'));
  assert.ok(result.generatedPrograms.length >= 17);
  for (const name of [
    'checked-operations',
    'native-ports',
    'parallel-extras/0',
    'parallel-extras/128',
    'parallel-extras/n',
  ])
    assert.ok(
      result.generatedPrograms.some((row) => row.name === name),
      name,
    );
  assert.ok(result.generatedPrograms.every((row) => row.functions > 0));
  assert.deepEqual(result.operations, ALL_OPS);
  assert.deepEqual(result.missingOperations, []);
  assert.deepEqual(result.types, ['arr', 'bool', 'io', 'rec', 'u32']);
  assert.ok(result.rejects.length >= 19);
  assert.ok(result.syntaxRejectCases.length >= 19);
  assert.equal(result.syntaxRejectCases.length, result.syntaxRejects);
  for (const row of result.syntaxRejectCases) assert.equal(row.id, row.legacyId, row.path);
  for (const count of Object.values(result.features)) assert.ok(count > 0);
  assert.equal(result.mismatches, 0);
  assert.ok(
    result.transportRejects.some((row) => row.path === 'test/source-native-edit.controls.ts'),
  );
  for (const row of result.transportRejects) assert.equal(row.reason, 'unpaired UTF-16 surrogate');
  t.diagnostic(JSON.stringify(result));
});
