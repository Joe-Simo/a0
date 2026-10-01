/**
 * Operand budget of an emitted page program. The A0 front end, optimizer and wasm emitter hold
 * the operands of one function in a table of 32768 pairs, and a text literal is one operand per
 * byte, so a page that keeps its stylesheet in one function stops fitting as the stylesheet grows.
 * The site generator splits the page into section functions; this module counts the operands of
 * every function of the generated source and says which one is too big.
 */

/** Operand pairs the A0 toolchain accepts in one function. */
export const OPERAND_CAPACITY = 32768;
/** The generator refuses a function above this share of the capacity, so there is room to grow. */
export const OPERAND_LIMIT = Math.floor((OPERAND_CAPACITY * 3) / 4);

export interface FunctionBudget {
  readonly name: string;
  readonly operands: number;
}

/** Bytes of the text literal that starts at `s` (`"...\"..."` with the escapes the generator writes). */
function textBytes(s: string): number {
  let n = 0;
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') break;
    if (c === '\\') i++;
    n += 1 + (c !== undefined && c.charCodeAt(0) > 127 ? utf8Extra(c) : 0);
  }
  return n;
}
function utf8Extra(c: string): number {
  return Buffer.byteLength(c, 'utf8') - 1;
}

/** Operands of every function: arguments of each instruction, one per byte of a text literal. */
export function functionBudgets(source: string): FunctionBudget[] {
  const out: { name: string; operands: number }[] = [];
  let cur: { name: string; operands: number } | undefined;
  for (const line of source.split('\n')) {
    if (line.startsWith('fn ')) {
      cur = { name: line.split(' ')[1] ?? '?', operands: 0 };
      out.push(cur);
    } else if (cur !== undefined && line !== '' && !line.startsWith('#') && line !== 'end') {
      const q = line.indexOf(' text "');
      if (q >= 0) {
        cur.operands += textBytes(line.slice(q + 6));
      } else {
        // `id op arg arg ...`: the id and the op are not operands
        cur.operands += Math.max(0, line.trim().split(/\s+/).length - 2);
      }
    }
  }
  return out;
}

/** Throws a clear error when any function of `source` is above OPERAND_LIMIT. */
export function checkOperandBudget(source: string, label: string): void {
  const over = functionBudgets(source).filter((f) => f.operands > OPERAND_LIMIT);
  if (over.length === 0) return;
  const list = over.map((f) => `${f.name} has ${f.operands} operand pairs`).join('; ');
  throw new Error(
    `${label}: ${list}, above ${OPERAND_LIMIT} (75% of the toolchain's ${OPERAND_CAPACITY} per function). Split it into more section functions in the template ({name ... }), for example another \`s WORD ROLE LO HI\` byte range of the stylesheet.`,
  );
}
