import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const retired =
  /A0 unified-language status|Archived source-token measurements|Archived model-edit cost studies|with A0 in two forms|A0 \((?:canonical|dense)\)/;
async function totals(): Promise<Record<string, Record<string, number>>> {
  return JSON.parse(await readFile('results/source-tokens.json', 'utf8')).totals;
}

test('benchmark template shows one measured A0 source score and keeps retired comparisons off the page', async () => {
  const text = await readFile('site/gen/bench.tpl', 'utf8');
  const section = text.match(/\{sec_source_tokens\n([\s\S]*?)\n}\n/)?.[1];
  assert.ok(section, 'source-token section is missing');
  assert.doesNotMatch(text, retired);
  assert.equal((section.match(/^=td A0$/gm) ?? []).length, 1);
  assert.match(section, /Source token counts/);
  assert.match(section, /lower is better/);
  assert.match(section, /linear scale from zero to ten thousand/);
  assert.equal((section.match(/^\.div brow(?: me)?$/gm) ?? []).length, 4);
  assert.equal((section.match(/^\.div brow me$/gm) ?? []).length, 1);
  for (const [language, row] of Object.entries(await totals())) {
    assert.ok(
      section.includes(
        `=td ${language}\n.td mono\n"${row.o200k_base}\n>\n.td mono\n"${row.cl100k_base}\n`,
      ),
      language,
    );
    assert.ok(
      section.includes(`"${row.o200k_base?.toLocaleString('en-US')}\n`),
      `${language} chart count`,
    );
  }
  assert.match(section, /results\/source-tokens.json/);
  assert.match(section, /tools\/source-token-bench.ts/);
  assert.match(section, /not an AI editing-cost or accuracy result/);
  // Historical evidence remains available without becoming a second current A0 score.
  assert.ok(JSON.parse(await readFile('results/dense-tokens.json', 'utf8')));
});

test('checked-in benchmark deployment carries the same measured source totals without retired notices', async () => {
  const expected = await totals();
  for (const path of [
    'deploy/benchmarks/index.html',
    'deploy/benchmarks.txt',
    'deploy/llms-full.txt',
  ]) {
    const text = await readFile(path, 'utf8');
    assert.doesNotMatch(text, retired, path);
    const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    assert.match(plain, /Source token counts/);
    assert.match(plain, /not an AI editing-cost or accuracy result/);
    for (const [language, row] of Object.entries(expected)) {
      const separator = path.endsWith('.html') ? ' ' : ' — ';
      assert.ok(
        plain.includes(`${language}${separator}${row.o200k_base}${separator}${row.cl100k_base}`),
        `${path}: ${language} totals`,
      );
    }
    assert.match(text, /results\/source-tokens.json/);
  }
});
