import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { getEncoding } from 'js-tiktoken';
import { formatProgram, parseAndValidate, validate } from '../src/core.js';
import { formatSource, parseSource } from '../src/source.js';
import { a0TokenText, KERNELS } from '../tools/exec-bench-kernels.js';

test('single A0 token report retains every program, exact counted sources and tokenizer totals', async () => {
  const report = JSON.parse(await readFile('results/source-tokens.json', 'utf8')) as {
    rows: {
      name: string;
      languages: Record<
        string,
        { source: string; bytes: number; sha256: string; tokens: Record<string, number> }
      >;
    }[];
    totals: Record<string, Record<string, number>>;
  };
  assert.deepEqual(
    report.rows.map((row) => row.name),
    KERNELS.map((kernel) => kernel.name),
  );
  const totals: Record<string, Record<string, number>> = {};
  const encodings = ['o200k_base', 'cl100k_base'] as const;
  const tokenizers = encodings.map((name) => [name, getEncoding(name)] as const);
  for (const [index, row] of report.rows.entries()) {
    const kernel = KERNELS[index];
    assert.ok(kernel);
    const program = parseAndValidate(a0TokenText(kernel));
    const a0 = row.languages.A0;
    assert.ok(a0);
    assert.equal(a0.source, formatSource(program));
    assert.equal(formatProgram(validate(parseSource(a0.source))), formatProgram(program));
    assert.deepEqual(Object.keys(row.languages), ['A0', 'C', 'JavaScript', 'Rust']);
    for (const [language, entry] of Object.entries(row.languages)) {
      assert.equal(entry.bytes, Buffer.byteLength(entry.source));
      assert.equal(entry.sha256, createHash('sha256').update(entry.source).digest('hex'));
      const sum = totals[language] ?? {};
      totals[language] = sum;
      for (const [name, tokenizer] of tokenizers) {
        const count = tokenizer.encode(entry.source).length;
        assert.equal(entry.tokens[name], count);
        sum[name] = (sum[name] ?? 0) + count;
      }
    }
    assert.equal(row.languages.C?.source, kernel.c);
    assert.equal(row.languages.JavaScript?.source, kernel.js);
    assert.equal(row.languages.Rust?.source, kernel.rust);
  }
  assert.deepEqual(report.totals, totals);
});
