/** Candidate grammar binding for the shared editor/MCP machinery; no public mode switch. */

import type { InitReport } from './agents.js';
import { formatType, type Program, stripComment } from './core.js';
import type { EditSyntax } from './edit.js';
import { type LspFrontend, sourceLspFrontend } from './lsp-frontend.js';
import type { MigrationManifest } from './migrate.js';
import { formatSource, parseSource, parseSourceNode, parseSourceOperand } from './source.js';
import { sourceDiagnostic } from './source-diagnostic.js';

export const sourceEditSyntax: EditSyntax = {
  diagnostic: sourceDiagnostic,
  parse: parseSource,
  node: parseSourceNode,
  operand: parseSourceOperand,
  aliases: { '<<': 'shl', '>>': 'shr' },
  specReader: { node: parseSourceNode, compact: true },
  formatSignature(fn) {
    const type = (value: Parameters<typeof formatType>[0]) =>
      formatType(value).replaceAll('u32', '_');
    return `fn ${[fn.name, ...fn.params.map(type)].join(' ')} -> ${type(fn.result)}`;
  },
  formatFunction(fn) {
    const lines = formatSource({ functions: [fn] })
      .split('\n')
      .map((line) => stripComment(line).trimEnd())
      .filter((line) => line.trim() !== '');
    const header = lines.findIndex((line) => line.startsWith('fn '));
    lines[header] = this.formatSignature(fn);
    return lines.join('\n');
  },
};

export interface McpFrontend extends LspFrontend {
  readonly command?: string;
  readonly syntax: EditSyntax;
  print(program: Program): string;
  explain?(id: string): Promise<string | undefined>;
  verifyExplanations?(): Promise<string[]>;
  initializeProject?(root: string): Promise<InitReport>;
  /** Import-only legacy compatibility, producing this frontend’s source grammar. */
  migrateLegacy?(
    entry: string,
    destination: string,
    root?: string,
    dense?: boolean,
  ): Promise<MigrationManifest>;
}
export const sourceMcpFrontend: McpFrontend = {
  ...sourceLspFrontend,
  command: 'node .a0/cli.mjs',
  async explain(id) {
    return (await import('./source-explain.js')).explainSource(id);
  },
  async verifyExplanations() {
    return (await import('./source-explain.js')).verifySourceExamples();
  },
  syntax: sourceEditSyntax,
  print: formatSource,
  async initializeProject(root) {
    return (await import('./source-init.js')).initSourceProject(root);
  },
  async migrateLegacy(entry, destination, root, dense) {
    return (await import('./migrate.js')).migrateSourceProject(entry, destination, root, dense);
  },
};
