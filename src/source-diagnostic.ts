/** Render example diagnostics in the grammar selected by the caller. */

import { LIMITS } from './core.js';
import { A0Error, diag } from './diagnostics.js';
import { literal } from './source.js';
import { parseExample } from './spec.js';

/** Diagnostic payloads may use the older serialization or the selected source spelling. */
function diagnosticExample(text: string, fn: string): ReturnType<typeof parseExample> | undefined {
  if (text.length > LIMITS.maxSourceBytes) return undefined;
  for (const compact of [false, true]) {
    try {
      return parseExample(text, fn, undefined, undefined, compact);
    } catch (error) {
      if (!(error instanceof A0Error) && !(error instanceof RangeError)) throw error;
    }
  }
  return undefined;
}

/** Decode serialized diagnostic data before inserting it into source text. */
export function sourceExampleResult(value: string): string | undefined {
  const example = diagnosticExample(`-> ${value}`, 'diagnostic');
  if (example === undefined) return undefined;
  try {
    return literal(example.result);
  } catch (error) {
    if (error instanceof A0Error || error instanceof RangeError) return undefined;
    throw error;
  }
}

export function sourceDiagnostic(error: A0Error): A0Error {
  if (error.id === 'A0714' && error.actual !== undefined && error.expected !== undefined) {
    const suffix = ` is ${error.actual}, which is not a ${error.expected}`;
    if (!error.detail.endsWith(suffix)) return error;
    const actual = sourceExampleResult(error.actual);
    if (actual === undefined || actual === error.actual) return error;
    return new A0Error(
      `${error.detail.slice(0, -suffix.length)} is ${actual}, which is not a ${error.expected}`,
      error.line,
      { ...error.detailOf(), actual },
    );
  }
  const spec = error.spec;
  if (
    error.id === 'A0716' &&
    spec?.ex !== null &&
    spec?.input !== undefined &&
    (spec.line === 'pre' || spec.line === 'post')
  ) {
    const example = diagnosticExample(`${spec.input} -> 0`, spec.function);
    if (example === undefined) return error;
    const input = example.args.map(literal).join(' ');
    let originalDetail: string;
    let sourceDetail: string;
    if (spec.line === 'pre') {
      originalDetail = diag('A0716', [
        spec.function,
        spec.ex,
        'pre',
        `the input ${spec.input || '(none)'} does not satisfy pre`,
      ]).detail;
      if (!error.detail.endsWith(originalDetail)) return error;
      sourceDetail = diag('A0716', [
        spec.function,
        spec.ex,
        'pre',
        `the input ${input || '(none)'} does not satisfy pre`,
      ]).detail;
    } else {
      const prefix = diag('A0716', [
        spec.function,
        spec.ex,
        'post',
        `the input ${spec.input || '(none)'} gives `,
      ]).detail;
      const suffix = ', which does not satisfy post';
      const start = error.detail.lastIndexOf(prefix);
      if (start < 0 || !error.detail.endsWith(suffix)) return error;
      const serialized = error.detail.slice(start + prefix.length, -suffix.length);
      const actual = sourceExampleResult(serialized);
      if (actual === undefined) return error;
      originalDetail = prefix + serialized + suffix;
      sourceDetail = diag('A0716', [
        spec.function,
        spec.ex,
        'post',
        `the input ${input || '(none)'} gives ${actual}${suffix}`,
      ]).detail;
    }
    const detail = error.detail.slice(0, -originalDetail.length) + sourceDetail;
    if (detail === error.detail && input === spec.input) return error;
    return new A0Error(detail, error.line, { ...error.detailOf(), spec: { ...spec, input } });
  }
  if (
    error.id !== 'A0715' ||
    error.fix === undefined ||
    spec?.line !== 'ex' ||
    spec.ex === null ||
    spec.input === undefined ||
    spec.expected === undefined ||
    spec.actual === undefined
  )
    return error;
  const expected = diagnosticExample(`${spec.input} -> ${spec.expected}`, spec.function);
  const actual = diagnosticExample(`${spec.input} -> ${spec.actual}`, spec.function);
  // Runtime failures are diagnostic text, not example values. Preserve the original failure.
  if (expected === undefined || actual === undefined) return error;
  const input = expected.args.map(literal).join(' ');
  const wanted = literal(expected.result);
  const got = literal(actual.result);
  const originalDetail = diag('A0715', [
    spec.function,
    spec.ex,
    spec.input,
    spec.expected,
    spec.actual,
  ]).detail;
  const sourceDetail = diag('A0715', [spec.function, spec.ex, input, wanted, got]).detail;
  // The linker may prefix the catalog message with an owning source path. Keep that prefix,
  // and preserve custom messages that are not this catalog template.
  const detail = error.detail.endsWith(originalDetail)
    ? error.detail.slice(0, -originalDetail.length) + sourceDetail
    : error.detail;
  const line = (example: typeof expected) =>
    [...example.args.map(literal), '->', literal(example.result)].join(' ');
  return new A0Error(detail, error.line, {
    ...error.detailOf(),
    expected: wanted,
    actual: got,
    spec: { ...spec, input, expected: wanted, actual: got },
    fix: `if ${spec.function} is right, change the line to \`ex ${line(actual)}\`; if the example is right, fix ${spec.function}; \`-ex ${line(expected)}\` removes it`,
  });
}
