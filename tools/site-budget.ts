/**
 * Operand and node budget of an emitted page program. The A0 front end, optimizer and wasm
 * emitter hold the operands of one function in a table of 32768 pairs (a text literal is one
 * operand per byte, so a page that keeps its stylesheet in one function stops fitting as the
 * stylesheet grows) and its nodes in a table of 2816 (a chart with a row loop expands to a node
 * per row). The site generator splits the page into section functions; this module counts the
 * operands and nodes of every function of the generated source and says which one is too big.
 */

/** Operand pairs the A0 toolchain accepts in one function. */
export const OPERAND_CAPACITY = 32768;
/** The generator refuses a function above this share of the capacity, so there is room to grow. */
export const OPERAND_LIMIT = Math.floor((OPERAND_CAPACITY * 3) / 4);

/** Nodes the A0 toolchain accepts in one function (2816 rows), less room for the callee bodies the emitter inlines. */
export const NODE_CAPACITY = 2816;
export const NODE_LIMIT = NODE_CAPACITY - 40;

export interface FunctionBudget {
  readonly name: string;
  readonly operands: number;
  readonly nodes: number;
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
  const out: { name: string; operands: number; nodes: number }[] = [];
  let cur: { name: string; operands: number; nodes: number } | undefined;
  for (const line of source.split('\n')) {
    if (line.startsWith('fn ')) {
      cur = { name: line.split(' ')[1] ?? '?', operands: 0, nodes: 0 };
      out.push(cur);
    } else if (cur !== undefined && line !== '' && !line.startsWith('#') && line !== 'end') {
      // `ret X` returns an operand and is not a node; `ret OP ARGS` is one
      if (!(line.startsWith('ret ') && line.trim().split(/\s+/).length === 2)) cur.nodes += 1;
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

/** Throws a clear error when any function of `source` is above OPERAND_LIMIT or NODE_LIMIT. */
export function checkOperandBudget(source: string, label: string): void {
  const budgets = functionBudgets(source);
  const over = budgets.filter((f) => f.operands > OPERAND_LIMIT);
  const many = budgets.filter((f) => f.nodes > NODE_LIMIT);
  if (over.length > 0) {
    const list = over.map((f) => `${f.name} has ${f.operands} operand pairs`).join('; ');
    throw new Error(
      `${label}: ${list}, above ${OPERAND_LIMIT} (75% of the toolchain's ${OPERAND_CAPACITY} per function). Split it into more section functions in the template ({name ... }), for example another \`s WORD ROLE LO HI\` byte range of the stylesheet.`,
    );
  }
  if (many.length > 0) {
    const list = many.map((f) => `${f.name} has ${f.nodes} nodes`).join('; ');
    throw new Error(
      `${label}: ${list}, above ${NODE_LIMIT} (the toolchain's ${NODE_CAPACITY} per function less room for inlined callees). Split it into more section functions in the template ({name ... }).`,
    );
  }
}
