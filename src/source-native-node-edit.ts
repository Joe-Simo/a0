/** Staged node edits: existing protocol/transaction kernels, contextual A0 source parsing only. */
import {
  A0Error,
  type Func,
  LIMITS,
  normalizeLine,
  stripComment,
  type TypedFunc,
  type TypedProgram,
  utf8Length,
} from './core.js';
import { type Applicability, diag, type FixEdit } from './diagnostics.js';
import {
  type EditOp,
  parseEditOpsWithLanguage,
  replaceNodesWithLanguage,
  validateOrderedWith,
} from './edit.js';
import { type EditSourceLine, editSourceSlice } from './edit-source.js';
import type { NativeUnitResult, nativeSource } from './source-native.js';
import { nativeEditLanguage } from './source-native-edit.js';
import { nativeEditContext } from './source-native-edit-context.js';
import { throwNativeEditSource } from './source-native-edit-source.js';
import { NativeSourceError } from './source-native-link.js';
import { losslessSourceString } from './source-utf8.js';
import type { Spec, SpecEdit } from './spec.js';

type Frontend = ReturnType<typeof nativeSource>;

/** Refused protocol routes stay on their existing implementation until separately migrated. */
export class NativeNodeEditRefusal extends Error {
  constructor(readonly reason: 'signed-spec' | 'source-spec' | 'instruction-shape') {
    super(`native node edit capability unavailable: ${reason}`);
    this.name = 'NativeNodeEditRefusal';
  }
}

export interface NativeNodeEditOrigin {
  readonly replyLine: number;
  readonly replyByteStart: number;
  readonly replyUtf16Start: number;
  readonly payload: string;
  readonly generatedSource: string;
  readonly generatedFirstLine: number;
  readonly generatedByteStart: number;
  readonly generatedUtf16Start: number;
}

/** The complete raw native error remains available even when a rendered reply diagnostic exists. */
export class NativeNodeEditSourceError extends NativeSourceError {
  constructor(
    result: Extract<NativeUnitResult, { readonly ok: false }>,
    readonly origin: NativeNodeEditOrigin,
  ) {
    super(result);
  }
}

/** A mapped real renderer diagnostic, retaining its original facts and generated-source provenance. */
export class NativeNodeEditDiagnostic extends A0Error {
  constructor(
    readonly native: NativeNodeEditSourceError,
    error: A0Error,
  ) {
    super(error.detail, error.line, error.detailOf());
  }
  override withEdits(edits: readonly FixEdit[], applicability?: Applicability): A0Error {
    return new NativeNodeEditDiagnostic(this.native, super.withEdits(edits, applicability));
  }
}

interface ReplyLine {
  readonly code: string;
  readonly raw: string;
  readonly leading: string;
  readonly line: number;
  readonly byteStart: number;
  readonly utf16Start: number;
}

/** The existing edit protocol inspects framing; complete raw payloads still reach A0. */
function replyLines(text: string): ReplyLine[] {
  const entries: ReplyLine[] = [];
  let byteStart = 0,
    utf16Start = 0,
    leading = '';
  for (const [index, physical] of text.split('\n').entries()) {
    const raw = physical.endsWith('\r') ? physical.slice(0, -1) : physical;
    const code = stripComment(raw).trim();
    if (code.length === 0) leading += `${physical}\n`;
    else {
      entries.push({ code, raw, leading, line: index + 1, byteStart, utf16Start });
      leading = '';
    }
    byteStart += utf8Length(physical) + 1;
    utf16Start += physical.length + 1;
  }
  return entries;
}

function parsedFailure(
  result: Extract<NativeUnitResult, { readonly ok: false }>,
  origin: NativeNodeEditOrigin,
  anchored: boolean,
): never {
  const native = new NativeNodeEditSourceError(result, origin),
    error = native.a0Error;
  if (error === undefined) throw native;
  const payloadLines = origin.payload.split('\n'),
    last = origin.generatedFirstLine + payloadLines.length - 1;
  const mappedLine = (line: number | undefined): number | undefined =>
    line !== undefined && line >= origin.generatedFirstLine && line <= last
      ? origin.replyLine + line - origin.generatedFirstLine
      : undefined;
  const line = mappedLine(error.line);
  if (line === undefined)
    throw new NativeNodeEditDiagnostic(native, error.reworded(error.detail, undefined, undefined));
  const edits: FixEdit[] = [];
  if (!anchored)
    for (const edit of error.edits) {
      if (edit.op !== 'lines') continue;
      const target = mappedLine(edit.line);
      if (target === undefined || edit.line === undefined) continue;
      const actual = payloadLines[edit.line - origin.generatedFirstLine];
      if (actual === undefined || normalizeLine(actual) !== edit.text) continue;
      edits.push({ ...edit, line: target });
    }
  // Every original edit must belong to the real payload before exact applicability survives.
  const applicability = edits.length === error.edits.length ? error.applicability : 'maybe';
  throw new NativeNodeEditDiagnostic(
    native,
    error.rewrite(error.detail, line).withEdits(edits, applicability),
  );
}

/** No spec source is parsed here: only the existing structural -pre/-post policy is supported. */
function removeContracts(fn: Func, edits: readonly SpecEdit[]): Spec | undefined {
  if (fn.spec === undefined) return undefined;
  const next = { ...fn.spec };
  for (const edit of edits) {
    if (edit.sign !== '-' || edit.rest !== '' || (edit.word !== 'pre' && edit.word !== 'post'))
      throw new NativeNodeEditRefusal('signed-spec');
    delete next[edit.word];
  }
  return next.pre === undefined && next.post === undefined && !next.examples?.length
    ? undefined
    : next;
}

/**
 * Native parsing occurs on demand in the shared protocol loop, preserving refusal order.
 * Each payload is a complete contextual function with the original declared signature.
 * This costs one parseUnit invocation per node/return payload; no latency claim is made.
 */
export function parseNativeNodeEditOps(
  fn: TypedFunc,
  raw: string,
  frontend: Frontend,
  sourceRows?: readonly EditSourceLine[],
  spec?: (match: RegExpExecArray, line: number, index: number, source?: EditSourceLine) => SpecEdit,
): EditOp[] {
  const text = losslessSourceString(raw, 'native node edit reply');
  if (utf8Length(text) > LIMITS.maxSourceBytes) throw diag('A0502');
  const entries = replyLines(text);
  const payloads = new Map<number, EditSourceLine>();
  let context: { header: string; ret: string } | undefined;
  const originalContext = (): { header: string; ret: string } => {
    if (context !== undefined) return context;
    context = nativeEditContext(frontend, fn);
    return context;
  };
  const parsePayload = (index: number, code: string, isReturn: boolean): Func => {
    const entry = entries[index];
    if (entry === undefined) throw new Error('missing native node edit payload');
    const original = originalContext(),
      anchored = code !== entry.code;
    let source = entry.raw;
    const originalRow = sourceRows?.[entry.line - 1];
    if (originalRow !== undefined) {
      const start = originalRow.text.indexOf(code);
      if (start < 0) throw new Error('native node payload lost its physical source');
      payloads.set(
        index,
        anchored ? editSourceSlice(originalRow, start, start + code.length) : originalRow,
      );
    }
    if (anchored) {
      const start = source.indexOf(entry.code);
      if (start < 0 || !entry.code.startsWith(code))
        throw new Error('invalid native node edit anchor framing');
      source = source.slice(0, start + code.length) + source.slice(start + entry.code.length);
    }
    const payload = entry.leading + source,
      generatedSource = `${original.header}${payload}\n${isReturn ? '' : `${original.ret.trimEnd()}\n`}end\n`,
      firstLine = 1 + original.header.split('\n').length - 1,
      prefixLines = entry.leading.split('\n').length - 1,
      origin: NativeNodeEditOrigin = {
        replyLine: entry.line - prefixLines,
        replyByteStart: entry.byteStart - utf8Length(entry.leading),
        replyUtf16Start: entry.utf16Start - entry.leading.length,
        payload,
        generatedSource,
        generatedFirstLine: firstLine,
        generatedByteStart: utf8Length(original.header),
        generatedUtf16Start: original.header.length,
      };
    const unit = frontend.parseUnit(generatedSource);
    if (!unit.ok) {
      if (sourceRows !== undefined) {
        const payloadRows = sourceRows.slice(entry.line - prefixLines - 1, entry.line);
        const last = payloadRows[payloadRows.length - 1];
        if (last === undefined) throw new Error('missing mapped native node payload');
        payloadRows[payloadRows.length - 1] = { ...last, text: source };
        throwNativeEditSource(unit, [
          ...original.header
            .trimEnd()
            .split('\n')
            .map((text) => ({ text })),
          ...payloadRows,
          ...(isReturn ? [] : [{ text: original.ret.trimEnd() }]),
          { text: 'end' },
        ]);
      }
      parsedFailure(unit, origin, anchored);
    }
    const parsed = unit.program.functions[0];
    if (unit.program.functions.length !== 1 || parsed === undefined || parsed.name !== fn.name)
      throw new NativeNodeEditRefusal('instruction-shape');
    if (parsed.spec !== undefined) throw new NativeNodeEditRefusal('source-spec');
    return parsed;
  };
  return parseEditOpsWithLanguage(
    entries.map((entry) => entry.code),
    1,
    {
      source: (index) =>
        payloads.get(index) ?? sourceRows?.[(entries[index]?.line ?? index + 1) - 1],
      line: (index) =>
        sourceRows?.[(entries[index]?.line ?? index + 1) - 1]?.origin?.line ??
        entries[index]?.line ??
        index + 1,
      spec(match, line, index) {
        if (spec === undefined) throw new NativeNodeEditRefusal('signed-spec');
        return spec(match, line, index, sourceRows?.[(entries[index]?.line ?? index + 1) - 1]);
      },
      node(code, _line, index) {
        const parsed = parsePayload(index, code, false);
        if (parsed.nodes.length !== 1) throw new NativeNodeEditRefusal('instruction-shape');
        return parsed.nodes[0] as NonNullable<(typeof parsed.nodes)[number]>;
      },
      ret(code, _line, index) {
        const parsed = parsePayload(index, code, true);
        if (parsed.nodes.length > 1) throw new NativeNodeEditRefusal('instruction-shape');
        const ops: EditOp[] = [];
        if (parsed.nodes.length === 1) {
          const node = parsed.nodes[0];
          if (node === undefined || parsed.ret.kind !== 'node' || parsed.ret.id !== node.id)
            throw new NativeNodeEditRefusal('instruction-shape');
          ops.push({ kind: 'node', node: { ...node, id: 'retval' }, fresh: true });
        }
        ops.push({
          kind: 'ret',
          operand: parsed.nodes.length ? { kind: 'node', id: 'retval' } : parsed.ret,
          ...(parsed.retComments === undefined ? {} : { comments: parsed.retComments }),
        });
        return ops;
      },
    },
    new Set(fn.nodes.map((node) => node.id)),
  );
}

/** Existing bounded raw node adapter; sessions inject their complete signed-spec services separately. */
export function editNativeNodes(
  program: TypedProgram,
  fn: TypedFunc,
  raw: string,
  frontend: Frontend,
): TypedProgram {
  if (program.byName.get(fn.name) !== fn)
    throw new Error('native node edit target must belong to the supplied program');
  const language = nativeEditLanguage(frontend);
  const edits = parseNativeNodeEditOps(fn, raw, frontend);
  return replaceNodesWithLanguage(fn, edits, {
    specs: removeContracts,
    check(replaced) {
      return validateOrderedWith(
        {
          ...program,
          functions: program.functions.map((candidate) =>
            candidate === fn ? replaced : candidate,
          ),
        },
        language.check,
        language.failure,
      );
    },
  });
}
