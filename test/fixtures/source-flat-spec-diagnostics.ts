/** Explicit JSON deltas from native diagnostics adopting the flat source literal spelling. */
import type { Diagnostic } from '../../src/diagnostics.js';

const literalFix = 'a literal is a number, true, false, an array [1 2 3] or a record (1 true)';

/** The rejected word and physical line are explicit inputs, independent of any diagnostic. */
export function flatSpecLiteralError(word: string, line: number, functionName = 'f'): Diagnostic {
  return {
    code: 'structure',
    id: 'A0714',
    message: `line ${line}: spec of ${functionName}: '${word}' is not a literal`,
    line,
    expected: null,
    actual: null,
    fix: literalFix,
    applicability: 'maybe',
    edits: [],
    spec: { function: functionName, ex: null },
  };
}

/** Only named cases whose complete JSON intentionally changes; all other cases keep their oracle. */
export const flatSpecDiagnosticExpectations: Readonly<Record<string, Diagnostic>> = {
  word: flatSpecLiteralError('nope', 2),
  uppercase: flatSpecLiteralError('T', 2),
  boolSuffixArgument: flatSpecLiteralError('X', 2),
  unicodeBmp: flatSpecLiteralError('é', 2),
  unicodeAstral: flatSpecLiteralError('\ud83d', 2),
  grammarPriority: flatSpecLiteralError('nope', 2),
  unicodeCommentLocation: flatSpecLiteralError('nope', 3),
  arrayUnequal: {
    code: 'structure',
    id: 'A0715',
    message: 'f: ex 1 failed: input [1 2], expected [3 4], got [1 2]',
    line: null,
    expected: '[3 4]',
    actual: '[1 2]',
    fix: 'if f is right, change the line to `ex [1 2] -> [1 2]`; if the example is right, fix f; `-ex [1 2] -> [3 4]` removes it',
    applicability: 'maybe',
    edits: [],
    spec: {
      function: 'f',
      ex: 1,
      line: 'ex',
      input: '[1 2]',
      expected: '[3 4]',
      actual: '[1 2]',
    },
  },
  repeatedActual: {
    code: 'structure',
    id: 'A0715',
    message: 'f: ex 1 failed: input [1 2 3], expected [9*3], got [1 2 3]',
    line: null,
    expected: '[9*3]',
    actual: '[1 2 3]',
    fix: 'if f is right, change the line to `ex [1 2 3] -> [1 2 3]`; if the example is right, fix f; `-ex [1 2 3] -> [9*3]` removes it',
    applicability: 'maybe',
    edits: [],
    spec: {
      function: 'f',
      ex: 1,
      line: 'ex',
      input: '[1 2 3]',
      expected: '[9*3]',
      actual: '[1 2 3]',
    },
  },
};

/** The graph's existing /r/main.a0 word case has its example on physical source line 3. */
export const flatSpecGraphWordDiagnostic: Diagnostic = {
  code: 'structure',
  id: 'A0714',
  message: "/r/main.a0:3: spec of f: 'nope' is not a literal",
  line: null,
  expected: null,
  actual: null,
  fix: literalFix,
  applicability: 'maybe',
  edits: [],
  spec: { function: 'f', ex: null },
};
