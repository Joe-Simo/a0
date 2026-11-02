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
  const spec = error.spec;
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
