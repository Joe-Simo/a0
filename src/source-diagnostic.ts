/** Render actionable example repairs in the grammar selected by the caller. */

import { LIMITS } from './core.js';
import { A0Error } from './diagnostics.js';
import { literal } from './source.js';
import { parseExample } from './spec.js';

/** Decode serialized diagnostic data before inserting it into source text. */
export function sourceExampleResult(value: string): string | undefined {
  if (value.length > LIMITS.maxSourceBytes) return undefined;
  try {
    return literal(parseExample(`-> ${value}`, 'diagnostic').result);
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
    spec.input === undefined ||
    spec.expected === undefined ||
    spec.actual === undefined
  )
    return error;
  let expected: ReturnType<typeof parseExample>;
  let actual: ReturnType<typeof parseExample>;
  try {
    expected = parseExample(`${spec.input} -> ${spec.expected}`, spec.function);
    actual = parseExample(`${spec.input} -> ${spec.actual}`, spec.function);
  } catch (cause) {
    // A runtime failure is diagnostic text, not an example result to paste into source.
    // Formatting must preserve the original failure and its source ownership.
    if (cause instanceof A0Error || cause instanceof RangeError) return error;
    throw cause;
  }
  const line = (example: typeof expected) =>
    [...example.args.map(literal), '->', literal(example.result)].join(' ');
  return new A0Error(error.detail, error.line, {
    ...error.detailOf(),
    fix: `if ${spec.function} is right, change the line to \`ex ${line(actual)}\`; if the example is right, fix ${spec.function}; \`-ex ${line(expected)}\` removes it`,
  });
}
