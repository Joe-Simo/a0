/** Native diagnostic provenance through protocol framing and generated contextual source. */
import { A0Error, normalizeLine, stripComment } from './core.js';
import type { Applicability, FixEdit } from './diagnostics.js';
import type { EditSourceLine } from './edit-source.js';
import type { NativeSourceResult } from './source-native.js';
import { NativeSourceError } from './source-native-link.js';

type Failure = Extract<NativeSourceResult, { readonly ok: false }>;

export class NativeEditSourceError extends NativeSourceError {
  constructor(
    result: Failure,
    readonly sourceLines: readonly EditSourceLine[],
  ) {
    super(result);
  }
}

export class NativeEditDiagnostic extends A0Error {
  constructor(
    readonly native: NativeEditSourceError,
    error: A0Error,
  ) {
    super(error.detail, error.line, error.detailOf());
  }
  override withEdits(edits: readonly FixEdit[], applicability?: Applicability): A0Error {
    return new NativeEditDiagnostic(this.native, super.withEdits(edits, applicability));
  }
  override rewrite(message: string, line?: number): A0Error {
    return new NativeEditDiagnostic(this.native, super.rewrite(message, line));
  }
  override reworded(message: string, line: number | undefined, fix: string | undefined): A0Error {
    return new NativeEditDiagnostic(this.native, super.reworded(message, line, fix));
  }
}

/** Executable fixes must target an authentic selected source row, never generated context. */
export function mapNativeEditDiagnostic(error: A0Error, rows: readonly EditSourceLine[]): A0Error {
  const row = error.line === undefined ? undefined : rows[error.line - 1];
  const edits: FixEdit[] = [];
  for (const edit of error.edits) {
    if (edit.op !== 'lines' || edit.line === undefined) continue;
    const target = rows[edit.line - 1],
      origin = target?.origin;
    if (
      target === undefined ||
      origin === undefined ||
      normalizeLine(target.text) !== edit.text ||
      normalizeLine(origin.raw.slice(origin.start, origin.end)) !== normalizeLine(target.text)
    )
      continue;
    const code = stripComment(origin.raw),
      prefix = code.slice(0, origin.start),
      suffix = code.slice(Math.min(origin.end, code.length));
    // A multi-line replacement under N / f:N / signed-spec prefixes requires new protocol rows.
    if (edit.to.includes('\n') && (prefix.trim() !== '' || suffix.trim() !== '')) continue;
    edits.push({
      ...edit,
      text: normalizeLine(origin.raw),
      to: `${prefix}${edit.to}${suffix}`,
      line: origin.line,
    });
  }
  const mapped = error.rewrite(error.detail, row?.origin?.line);
  return mapped.withEdits(
    edits,
    edits.length === error.edits.length ? error.applicability : 'maybe',
  );
}

export function throwNativeEditSource(result: Failure, rows: readonly EditSourceLine[]): never {
  const native = new NativeEditSourceError(result, rows);
  if (native.a0Error === undefined) throw native;
  throw new NativeEditDiagnostic(native, mapNativeEditDiagnostic(native.a0Error, rows));
}
