/** Private transport adapter for the existing A0 diagnostic renderer; no source interpretation. */
import {
  A0Error,
  DIAGNOSTICS,
  type Diagnostic,
  type FixEdit,
  isDiagId,
  type SpecFault,
} from './diagnostics.js';

export interface NativeDiagnosticPacket {
  /** Renderer status, distinct from the parser/checker status in facts[0]. */
  readonly status: number;
  readonly facts: readonly number[];
  readonly json: Uint8Array;
}
export interface NativeDiagnosticOrigin {
  readonly path: string;
  readonly firstLine: number;
  readonly lineCount: number;
  readonly byteStart: number;
  readonly byteLength: number;
  /** Prefix length in UTF16 units, when retained by the graph loader. */
  readonly utf16Start?: number;
}
export interface NativeDiagnosticLocation {
  /** Physical source location; the public diagnostic may deliberately have no line. */
  readonly line: number | null;
  readonly byteStart: number;
  readonly byteLength: number;
  readonly utf16Start: number;
  readonly utf16Length: number;
  readonly path?: string;
  readonly localLine?: number;
  readonly localByteStart?: number;
  readonly localUtf16Start?: number;
}
export type NativeDiagnosticResult =
  | {
      readonly ok: true;
      readonly error: A0Error;
      readonly location: NativeDiagnosticLocation;
      readonly facts: readonly number[];
    }
  | {
      readonly ok: false;
      readonly reason: 'resource' | 'transport' | 'unsupported' | 'no-diagnostic';
      readonly status: number;
      readonly facts: readonly number[];
    };

/** Arena protocol words are u32; the same maximum marks absent checker context. */
const U32_MAX = 0xffff_ffff;

const requirePacket = (condition: unknown, detail: string): void => {
  if (!condition) throw new Error(`invalid native diagnostic packet: ${detail}`);
};
const word = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= U32_MAX;
const lineNumber = (value: unknown): value is number => word(value) && value > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void => {
  requirePacket(
    required.every((name) => Object.hasOwn(value, name)),
    'missing field',
  );
  requirePacket(
    Object.keys(value).every((name) => required.includes(name) || optional.includes(name)),
    'unknown field',
  );
};
const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function editOf(value: unknown): FixEdit {
  requirePacket(record(value), 'edit object');
  const row = value as Record<string, unknown>;
  if (row.op === 'lines') {
    keys(row, ['op', 'rule', 'text', 'to'], ['line']);
    requirePacket(
      typeof row.rule === 'string' && typeof row.text === 'string' && typeof row.to === 'string',
      'line edit',
    );
    requirePacket(row.line === undefined || lineNumber(row.line), 'line edit location');
    return {
      op: 'lines',
      rule: row.rule as string,
      text: row.text as string,
      to: row.to as string,
      ...(row.line === undefined ? {} : { line: row.line as number }),
    };
  }
  keys(row, ['op', 'rule', 'fn', 'node', 'from', 'to']);
  requirePacket(
    row.op === 'rename' &&
      ['rule', 'fn', 'node', 'from', 'to'].every((name) => typeof row[name] === 'string'),
    'rename edit',
  );
  return {
    op: 'rename',
    rule: row.rule as string,
    fn: row.fn as string,
    node: row.node as string,
    from: row.from as string,
    to: row.to as string,
  };
}
function specOf(value: unknown): SpecFault {
  requirePacket(record(value), 'spec object');
  const row = value as Record<string, unknown>;
  keys(row, ['function', 'ex'], ['line', 'input', 'expected', 'actual']);
  requirePacket(
    typeof row.function === 'string' && (row.ex === null || lineNumber(row.ex)),
    'spec identity',
  );
  requirePacket(
    row.line === undefined || ['ex', 'pre', 'post'].includes(row.line as string),
    'spec line',
  );
  for (const name of ['input', 'expected', 'actual'])
    requirePacket(row[name] === undefined || typeof row[name] === 'string', `spec ${name}`);
  return {
    function: row.function as string,
    ex: row.ex as number | null,
    ...(row.line === undefined ? {} : { line: row.line as 'ex' | 'pre' | 'post' }),
    ...(row.input === undefined ? {} : { input: row.input as string }),
    ...(row.expected === undefined ? {} : { expected: row.expected as string }),
    ...(row.actual === undefined ? {} : { actual: row.actual as string }),
  };
}

function errorOf(value: unknown, diagnostic: number): A0Error {
  requirePacket(record(value), 'diagnostic object');
  const row = value as Record<string, unknown>;
  keys(
    row,
    ['code', 'id', 'message', 'line', 'expected', 'actual', 'fix', 'applicability', 'edits'],
    ['spec'],
  );
  requirePacket(typeof row.id === 'string' && isDiagId(row.id), 'catalog ID');
  const id = row.id as Diagnostic['id'];
  requirePacket(
    id !== null && id === `A${String(diagnostic).padStart(4, '0')}`,
    'fact/catalog ID mismatch',
  );
  requirePacket(id !== null && isDiagId(id) && row.code === DIAGNOSTICS[id].cls, 'catalog class');
  requirePacket(
    typeof row.message === 'string' && (row.line === null || lineNumber(row.line)),
    'message/line',
  );
  for (const name of ['expected', 'actual', 'fix']) requirePacket(nullableString(row[name]), name);
  requirePacket(
    row.applicability === null || row.applicability === 'exact' || row.applicability === 'maybe',
    'applicability',
  );
  requirePacket(Array.isArray(row.edits), 'edits');
  const edits = (row.edits as unknown[]).map(editOf);
  requirePacket(
    row.applicability === null || row.fix !== null || edits.length > 0,
    'applicability without repair',
  );
  const line = row.line as number | null,
    message = row.message as string,
    prefix = line === null ? '' : `line ${line}: `;
  requirePacket(message.startsWith(prefix), 'message line prefix');
  return new A0Error(message.slice(prefix.length), line ?? undefined, {
    code: row.code as Diagnostic['code'],
    id: id as string,
    ...(row.expected === null ? {} : { expected: row.expected as string }),
    ...(row.actual === null ? {} : { actual: row.actual as string }),
    ...(row.fix === null ? {} : { fix: row.fix as string }),
    ...(row.applicability === null
      ? {}
      : { applicability: row.applicability as 'exact' | 'maybe' }),
    edits,
    ...(row.spec === undefined ? {} : { spec: specOf(row.spec) }),
  });
}

/**
 * Hydrate complete renderer output, preserving catalog wording and repairs verbatim. Refusal
 * never invokes a host parser, validator, formatter or suggestion algorithm. The renderer must
 * run against the same live native arena state before that parse/check session is replaced.
 */
export function nativeDiagnostic(
  packet: NativeDiagnosticPacket,
  origins: readonly NativeDiagnosticOrigin[] = [],
): NativeDiagnosticResult {
  requirePacket(word(packet.status), 'renderer status');
  const facts = Array.from(packet.facts);
  requirePacket(facts.length === 128 && facts.every(word), '128-word facts');
  if (packet.status !== 0) {
    requirePacket(packet.json.length === 0, 'partial JSON after refusal');
    requirePacket(packet.status <= 5 || packet.status === 7, 'unknown renderer refusal');
    return {
      ok: false,
      reason:
        packet.status === 4
          ? 'resource'
          : packet.status <= 5
            ? 'transport'
            : facts[1] === 0
              ? 'no-diagnostic'
              : 'unsupported',
      status: packet.status,
      facts,
    };
  }
  requirePacket(
    (facts[0] === 6 || facts[0] === 8) && (facts[1] ?? 0) !== 0,
    'unsupported source failure status',
  );
  requirePacket(((facts[20] ?? 0) & 15) === 15, 'incomplete renderer facts');
  const decoded: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(packet.json),
  );
  let error = errorOf(decoded, facts[1] as number);
  const line = facts[2] || null,
    location: NativeDiagnosticLocation = {
      line,
      byteStart: facts[3] as number,
      byteLength: facts[4] as number,
      utf16Start: facts[12] as number,
      utf16Length: facts[13] as number,
    };
  const sourceBytes = facts[11] as number;
  requirePacket(
    location.byteStart <= sourceBytes && location.byteLength <= sourceBytes - location.byteStart,
    'span outside source',
  );
  requirePacket(
    location.utf16Start <= location.byteStart &&
      location.utf16Length <= location.byteLength &&
      location.utf16Start + location.utf16Length <= sourceBytes,
    'UTF16 span outside source',
  );
  for (const origin of origins)
    requirePacket(
      typeof origin.path === 'string' &&
        lineNumber(origin.firstLine) &&
        word(origin.lineCount) &&
        word(origin.byteStart) &&
        word(origin.byteLength) &&
        (origin.utf16Start === undefined || word(origin.utf16Start)) &&
        origin.firstLine + origin.lineCount <= 0x100000000 &&
        origin.byteStart + origin.byteLength <= sourceBytes &&
        (origin.utf16Start === undefined || origin.utf16Start <= origin.byteStart),
      'origin',
    );
  const owners =
    line === null
      ? []
      : origins.filter(
          (origin) => line >= origin.firstLine && line < origin.firstLine + origin.lineCount,
        );
  requirePacket(owners.length <= 1, 'ambiguous origin');
  const origin = owners[0];
  if (origin !== undefined && line !== null) {
    const localLine = line - origin.firstLine + 1;
    requirePacket(
      location.byteStart >= origin.byteStart &&
        location.byteStart + location.byteLength <= origin.byteStart + origin.byteLength,
      'span outside origin',
    );
    requirePacket(
      origin.utf16Start === undefined || location.utf16Start >= origin.utf16Start,
      'UTF16 span outside origin',
    );
    // The ordinary linker also embeds the local location in the message and clears line.
    if (error.line !== undefined || facts[7] !== U32_MAX)
      error = error.rewrite(`${origin.path}:${localLine}: ${error.detail}`);
    return {
      ok: true,
      error,
      facts,
      location: {
        ...location,
        path: origin.path,
        localLine,
        localByteStart: location.byteStart - origin.byteStart,
        ...(origin.utf16Start === undefined
          ? {}
          : { localUtf16Start: location.utf16Start - origin.utf16Start }),
      },
    };
  }
  return { ok: true, error, facts, location };
}
