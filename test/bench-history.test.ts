import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('benchmark template separates unified status from archived syntax scores', async () => {
  const text = await readFile('site/gen/bench.tpl', 'utf8');
  assert.ok(
    text.indexOf('=h2 A0 unified-language status') < text.indexOf('=h2 Archived syntax research'),
  );
  assert.match(text, /No release-qualified unified A0 token or edit-cost score is available/);
  assert.match(text, /=h2 Archived source-token measurements · 9 October 2026/);
  assert.match(text, /=h2 Archived model-edit cost studies/);
  assert.doesNotMatch(text, /with A0 in two forms/);
  assert.match(text, /\$tk_cv\$ tokens/);
  assert.match(text, /A0 \(dense\) takes \$tk_dv\$/);
  assert.match(text, /same ids and node order, takes \$tk_dx\$/);
  assert.match(text, /results\/dense-tokens.json/);
});
