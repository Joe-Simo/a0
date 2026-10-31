/** One frontend boundary for all LSP checks and formatting during staged migration. */
import { formatSource as formatLegacy, type Op, parse } from './core.js';
import { formatDense } from './dense.js';
import { A0Error } from './diagnostics.js';
import { isDensePath, link, parseFile } from './link.js';
import type { Linked, ProjectLinkOptions, ReadSource } from './linker.js';
import { sourceDiagnostic, sourceExampleResult } from './source-diagnostic.js';

export interface LspFrontend {
  exampleResult?(serialized: string): string | undefined;
  diagnostic?(error: A0Error): A0Error;
  readonly operationCompletions?: Partial<
    Record<Op, { label: string; detail: string; insertText: string; snippet: string }>
  >;
  documentation?(text: string): string;
  readonly aliases: Readonly<Record<string, Op>>;
  link(entry: string, read: ReadSource, options: ProjectLinkOptions): Promise<Linked>;
  format(path: string, text: string, read: ReadSource): Promise<string>;
}

/** Compatibility default; the shipped CLI stays on its existing readers until cutover. */
export const legacyLspFrontend: LspFrontend = {
  aliases: {},
  link,
  async format(path, text, read) {
    if (!isDensePath(path)) return formatLegacy(parse(text));
    const { program, known } = await parseFile(path, read);
    return formatDense(program, { known, comments: true });
  },
};

/** Internal integration target, not a new CLI mode or a declaration of cutover readiness. */
export const sourceLspFrontend: LspFrontend = {
  exampleResult: sourceExampleResult,
  diagnostic: sourceDiagnostic,
  aliases: { '<<': 'shl', '>>': 'shr' },
  operationCompletions: {
    shl: {
      label: '<<',
      detail: '<< a n: left shift a by n&31 bits',
      insertText: '<<',
      snippet: '<< ${1:A} ${2:1}',
    },
    shr: {
      label: '>>',
      detail: '>> a n: unsigned right shift a by n&31 bits',
      insertText: '>>',
      snippet: '>> ${1:A} ${2:1}',
    },
    arr: {
      label: '[]',
      detail: '[a,b]: construct an immutable array',
      insertText: '[0]',
      snippet: '[${1:0}]',
    },
    rec: {
      label: '()',
      detail: '(a,b): construct an immutable record',
      insertText: '(0,)',
      snippet: '(${1:0},)',
    },
  },
  documentation(text) {
    return text.replace(/\bu32\b/g, '_').replaceAll('p0..pN', 'A..Z, then p26..');
  },
  async link(entry, read, options) {
    try {
      return await (await import('./source-link.js')).linkSource(entry, read, options);
    } catch (error) {
      throw error instanceof A0Error ? sourceDiagnostic(error) : error;
    }
  },
  async format(_path, text) {
    const { formatSource, parseSource } = await import('./source.js');
    return formatSource(parseSource(text));
  },
};
