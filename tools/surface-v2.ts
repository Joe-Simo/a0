/** Historical Surface v2 study entry points. Production candidate parsing builds IR directly. */
import {
  A0Error,
  type Func,
  formatProgram,
  parse,
  parseType,
  type TypedFunc,
  validateFunction,
} from '../src/core.js';
import { parseSource } from '../src/source.js';

export {
  formatStudySource as formatV2,
  INFIX,
  normalizeFunction,
  normalizeV2,
  paramName,
  type V2Style,
} from '../src/source.js';

/** Legacy research output only; no compiler frontend consumes this text. */
export function canonicalOfV2(text: string): string {
  return formatProgram(parseSource(text));
}

export function inferResults(
  canonical: string,
  known: ReadonlyMap<string, TypedFunc> = new Map(),
): string {
  const program = parse(canonical);
  const scope = new Map<string, TypedFunc>(known);
  const functions: Func[] = [];
  for (const f of program.functions) {
    let fn = f;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        scope.set(fn.name, validateFunction(fn, scope));
        break;
      } catch (e) {
        if (e instanceof A0Error && e.id === 'A0201' && e.actual !== undefined)
          fn = { ...fn, result: parseType(e.actual) };
        else break;
      }
    }
    functions.push(fn);
  }
  return formatProgram({ ...program, functions });
}
