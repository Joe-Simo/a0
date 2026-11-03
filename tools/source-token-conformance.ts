/** Per-input semantic controls for the exact sources counted by source-token-bench. No timings. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatProgram, parseAndValidate, run, validate } from '../src/core.js';
import { formatSource, parseSource } from '../src/source.js';
import { spawnWithInput, withTempDir } from '../src/toolchain.js';
import { a0TokenText, KERNELS, type Kernel } from './exec-bench-kernels.js';
import { writeReport } from './scrub-results.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const SOURCE_TOKEN_CONTROL_SEED = 0x60b3aa51;

export function sourceTokenControlInputs(arity: number): number[][] {
  assert.ok(Number.isInteger(arity) && arity > 0 && arity <= 16);
  const rows: number[][] = [];
  for (const value of [0, 1, 0x7fffffff, 0xffffffff]) {
    rows.push(Array.from({ length: arity }, (_, i) => (value + i * 2654435761) >>> 0));
    rows.push(Array.from({ length: arity }, () => value));
  }
  let state = SOURCE_TOKEN_CONTROL_SEED;
  for (let row = 0; row < 8; row++) {
    rows.push(
      Array.from({ length: arity }, () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
      }),
    );
  }
  return [...new Map(rows.map((row) => [row.join(','), row])).values()];
}

export function checkTokenControlOutput(
  output: string,
  expected: readonly number[],
  label: string,
): void {
  const normalized = output.replace(/\r\n/g, '\n');
  assert.ok(normalized.endsWith('\n'), `${label}: unterminated output`);
  const lines = normalized.slice(0, -1).split('\n');
  assert.equal(lines.length, expected.length, `${label}: result count`);
  for (const [index, line] of lines.entries()) {
    assert.match(line, /^(0|[1-9][0-9]*)$/, `${label}: malformed result ${index}`);
    const value = Number(line);
    assert.ok(
      Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
      `${label}: non-u32 result ${index}`,
    );
    assert.equal(value, expected[index], `${label}: input ${index}`);
  }
}

function driver(kernel: Kernel, language: 'C' | 'Rust'): string {
  assert.match(kernel.name, /^[a-zA-Z_][a-zA-Z_0-9]*$/);
  const parameters = Array.from({ length: kernel.arity }, (_, i) => `a${i}`);
  if (language === 'C') {
    const format = parameters.map(() => '%" SCNu32 "').join(' ');
    return `#include <stdint.h>\n#include <stdio.h>\n#include <inttypes.h>\n${kernel.c}\nint main(void) {\n${parameters.map((p) => `uint32_t ${p};`).join('\n')}\nfor (;;) { int count = scanf("${format}", ${parameters.map((p) => `&${p}`).join(', ')}); if (count == EOF) return 0; if (count != ${kernel.arity}) return 2; printf("%" PRIu32 "\\n", hw_${kernel.name}(${parameters.join(', ')})); }\n}\n`;
  }
  return `use std::io::BufRead;\n${kernel.rust}\nfn main() { for line in std::io::stdin().lock().lines() { let line = line.unwrap(); let a: Vec<u32> = line.split_whitespace().map(|v| v.parse().unwrap()).collect(); assert_eq!(a.len(), ${kernel.arity}); println!("{}", hw_${kernel.name}(${parameters.map((_, i) => `a[${i}]`).join(', ')})); } }\n`;
}

export async function compiledTokenControl(
  kernel: Kernel,
  language: 'C' | 'Rust',
  compiler: string,
  inputs: readonly (readonly number[])[],
  expected: readonly number[],
  optimization: 0 | 2,
  sanitize = true,
) {
  assert.equal(inputs.length, expected.length);
  assert.ok(inputs.length > 0, 'At least one control input is required');
  for (const row of inputs) {
    assert.equal(row.length, kernel.arity);
    for (const value of row)
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff);
  }
  return withTempDir(async (directory) => {
    const source = driver(kernel, language);
    const sourcePath = join(directory, language === 'C' ? 'control.c' : 'control.rs');
    const executable = join(directory, process.platform === 'win32' ? 'control.exe' : 'control');
    await writeFile(sourcePath, source);
    const flags =
      language === 'C'
        ? [
            '-std=c11',
            `-O${optimization}`,
            ...(sanitize ? ['-fsanitize=undefined', '-fno-sanitize-recover=all'] : []),
          ]
        : ['--edition=2021', '-C', `opt-level=${optimization}`, '-C', 'overflow-checks=yes'];
    const built = spawnSync(compiler, [...flags, sourcePath, '-o', executable], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(
      built.status,
      0,
      `${kernel.name}/${language}: compile failed: ${built.error?.message ?? built.stderr}`,
    );
    const input = inputs.map((row) => row.join(' ')).join('\n') + '\n';
    const result = spawnWithInput(executable, Buffer.from(input), { timeout: 120_000 });
    assert.equal(
      result.status,
      0,
      `${kernel.name}/${language}: execution failed: ${result.error?.message ?? result.stderr.toString()}`,
    );
    assert.equal(result.stderr.length, 0, `${kernel.name}/${language}: runtime diagnostics`);
    checkTokenControlOutput(
      result.stdout.toString(),
      expected,
      `${kernel.name}/${language}/O${optimization}`,
    );
    return {
      driverSHA256: hash(source),
      executableSHA256: hash(await readFile(executable)),
      inputSHA256: hash(input),
      cases: inputs.length,
    };
  });
}

export async function sourceTokenConformance(options: {
  clang: string;
  rustc: string;
  report?: string;
}) {
  const version = (compiler: string) => {
    const result = spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, `required compiler unavailable: ${compiler}`);
    return result.stdout.trim().split(/\r?\n/)[0];
  };
  const toolchains = { C: version(options.clang), Rust: version(options.rustc) };
  const reportBytes = await readFile(options.report ?? 'results/source-tokens.json');
  const counted = JSON.parse(reportBytes.toString()) as {
    rows: { name: string; languages: Record<string, { source: string; sha256: string }> }[];
  };
  assert.deepEqual(
    counted.rows.map((row) => row.name),
    KERNELS.map((kernel) => kernel.name),
  );
  const rows = [];
  for (const [index, kernel] of KERNELS.entries()) {
    const reference = parseAndValidate(a0TokenText(kernel));
    const source = formatSource(reference);
    const candidate = validate(parseSource(source));
    assert.equal(formatProgram(candidate), formatProgram(reference));
    const texts = { A0: source, C: kernel.c, JavaScript: kernel.js, Rust: kernel.rust };
    for (const [language, text] of Object.entries(texts)) {
      assert.equal(
        counted.rows[index]?.languages[language]?.source,
        text,
        `${kernel.name}/${language}: counted source changed`,
      );
      assert.equal(counted.rows[index]?.languages[language]?.sha256, hash(text));
    }
    const fn = candidate.byName.get(kernel.name);
    assert.ok(fn);
    const inputs = sourceTokenControlInputs(kernel.arity);
    const expected = inputs.map((row) => {
      const value = run(fn, [...row]);
      assert.ok(
        typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
      );
      return value;
    });
    const javascript = new Function(
      `${kernel.js.replace(/\bexport\s+/g, '')}; return ${kernel.name}`,
    )() as (...args: number[]) => number;
    assert.deepEqual(
      inputs.map((row) => javascript(...row)),
      expected,
      `${kernel.name}/JavaScript`,
    );
    const compiled = [];
    for (const optimization of [0, 2] as const) {
      for (const language of ['C', 'Rust'] as const) {
        compiled.push({
          language,
          optimization,
          ...(await compiledTokenControl(
            kernel,
            language,
            language === 'C' ? options.clang : options.rustc,
            inputs,
            expected,
            optimization,
          )),
        });
      }
    }
    rows.push({
      name: kernel.name,
      inputs,
      expected,
      sourceSHA256: Object.fromEntries(
        Object.entries(texts).map(([name, text]) => [name, hash(text)]),
      ),
      compiled,
    });
  }
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    seed: SOURCE_TOKEN_CONTROL_SEED,
    scope:
      'Per-input conformance of the unchanged sources in source-tokens.json; no timing, token-score change, native-A0 or AI-cost claim.',
    sourceTokenReportSHA256: hash(reportBytes),
    toolchains,
    host: { platform: process.platform, architecture: process.arch },
    policy:
      'Four prior offset boundary inputs, uniform boundaries and eight fixed xorshift inputs per arity; duplicate vectors removed. C uses UBSan and Rust enables overflow checks at both optimization levels. Every output is compared individually, never only as an XOR checksum.',
    programs: rows.length,
    cases: rows.reduce((sum, row) => sum + row.inputs.length, 0),
    rows,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const option = (name: string) =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const clang = option('clang'),
    rustc = option('rustc'),
    out = option('out');
  assert.ok(
    clang && rustc && out,
    '--clang, --rustc and --out are required; missing tools are not skipped',
  );
  const report = await sourceTokenConformance({ clang, rustc });
  await writeReport(out, report);
  console.log(
    JSON.stringify(
      { programs: report.programs, cases: report.cases, toolchains: report.toolchains },
      null,
      2,
    ),
  );
}
