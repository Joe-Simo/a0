/** Candidate diagnostic examples use the same parser/editor as candidate projects. */
import { A0Error, parse, stripComment, validate } from './core.js';
import type { Example } from './diagnostics.js';
import { type ExplainFrontend, explain, explainIndex, verifyExamples } from './explain.js';
import { formatSource, parseSource } from './source.js';
import { sourceEditSyntax } from './source-edit.js';

const text = (v: string | (() => string)) => (typeof v === 'function' ? v() : v);
/** Preserve quoted bytes and comments; only parameter/type/operator tokens change spelling. */
function spelling(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const code = stripComment(line);
      const quoted = false;
      return (
        code.replace(
          /"(?:[^"\\]|\\.)*"|\bp(\d+)\b|\bu32(?=x|\b)|\bshl\b|\bshr\b/g,
          (word, index: string | undefined) => {
            if (word.startsWith('"')) return word;
            if (index !== undefined)
              return Number(index) < 26 ? String.fromCharCode(65 + Number(index)) : word;
            return word === 'u32' ? '_' : word === 'shl' ? '<<' : '>>';
          },
        ) + line.slice(code.length)
      );
    })
    .join('\n');
}
// Invalid syntax cannot be formatted as an IR. Keep its structure and only project tokens;
// every resulting rejection is independently checked by verifySourceExamples.
function source(source: string): string {
  try {
    return formatSource(parse(source));
  } catch (e) {
    if (!(e instanceof A0Error)) throw e;
    return spelling(source);
  }
}
export function candidateExample(ex: Example): Example {
  const convert = ex.kind === 'source' || ex.kind === 'run' ? source : spelling;
  return {
    ...ex,
    bad: () => convert(text(ex.bad)),
    good: () => convert(text(ex.good)),
    ...(ex.base === undefined ? {} : { base: source(ex.base) }),
    ...(ex.shown === undefined
      ? {}
      : { shown: { bad: spelling(ex.shown.bad), good: spelling(ex.shown.good) } }),
  };
}
export const sourceExplainFrontend: ExplainFrontend = {
  parse: (text) => validate(parseSource(text)),
  syntax: sourceEditSyntax,
  example: candidateExample,
  describe: spelling,
  command: 'node .a0/cli.mjs',
};
export const explainSource = (id: string) => explain(id, sourceExplainFrontend);
export const verifySourceExamples = () => verifyExamples(sourceExplainFrontend);
export { explainIndex };
