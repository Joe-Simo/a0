/**
 * The edit protocol for dense views: a reply written in dense syntax is translated to the
 * canonical edit lines the session already applies (`fn` blocks, `id op ...` lines, `-id`,
 * `ret ...`), so revisions, atomic commits, validation and diagnostics stay exactly the same.
 *
 *   fn NAME ...            a whole function in dense form (the usual dense edit): replaces or adds
 *   ID EXPR [@ OTHER]      sets the value named ID (a statement the view shows with its id)
 *   ret EXPR               changes the function result
 *   -ID, -fn NAME          deletions, as in the canonical protocol
 *
 * A nested expression becomes several canonical nodes: the sub-nodes get fresh ids
 * (`ID_1`, `ID_2`, ...) placed before it.
 */

import {
  A0Error,
  type Func,
  formatFunction,
  formatNode,
  formatOperand,
  freshRetId,
  isProfileEdit,
  isValidIdentifier,
  type Node,
  type Type,
  type TypedFunc,
  type TypedProgram,
} from './core.js';
import {
  type DenseStyle,
  denseNodeTexts,
  FunctionParser,
  lexDense,
  parseDense,
  parseDenseExpression,
  parseDenseHeader,
} from './dense.js';

/** A one-line `fn NAME types -> T end` naming an existing function: a signature echoed back. */
export function isDenseSignatureEcho(line: string, program: TypedProgram): boolean {
  const t = line.trim();
  if (!/^fn\s/.test(t) || !/\send$/.test(t)) return false;
  try {
    const head = parseDenseHeader(t.slice(2, -3).trim(), 0, true);
    return head.rest === '' && program.byName.has(head.name);
  } catch {
    return false;
  }
}

interface EditCtx {
  readonly program: TypedProgram;
  readonly arities: ReadonlyMap<string, number>;
  readonly fnNames: ReadonlySet<string>;
  readonly target: { readonly nodes: readonly Node[]; readonly params: readonly Type[] };
  /** Ids in use: the function's nodes, the edit's own and every id generated so far. */
  readonly taken: Set<string>;
  /** Ids that edit lines defined (a later line may refer to them). */
  readonly defined: Set<string>;
  /** The reply uses the compact spellings (`parseDense(text, { compact: true })`). */
  readonly compact: boolean;
}

/**
 * The compact spellings an edit view prints when asked (`ViewOptions.compact`): every compact rule of
 * src/dense.ts except `oneLine`, so a reply still writes whole functions as `fn` blocks. Off by default.
 */
export const COMPACT_EDIT_STYLE: DenseStyle = {
  tab: true,
  minmax: true,
  hex: true,
  trailingParams: true,
  fill: true,
  bit: true,
  dot: true,
  inferResult: true,
  negative: true,
  foldN: true,
  ops: true,
};

/** How `denseEditBody` reads a reply. */
export interface DenseEditOptions {
  /** Read the compact spellings (off by default: the reply is plain dense text). */
  readonly compact?: boolean;
}

/** `+ex ...`, `+pre EXPR` and `+post EXPR` (optionally `f:` first): the dense expressions as canonical lines. */
const DENSE_SPEC_SET = /^((?:[a-z][a-z0-9_]*:)?\+)(ex|pre|post)(?:\s+(.*))?$/;

function translateSpecSet(
  m: RegExpExecArray,
  arities: ReadonlyMap<string, number>,
  fnNames: ReadonlySet<string>,
): string {
  // examples are written the same in both spellings
  if (m[2] === 'ex') return m[0];
  const word = m[2] as 'pre' | 'post';
  const node = parseDenseExpression(
    word,
    m[3] ?? '',
    1,
    arities,
    fnNames,
    m[1]?.replace(/[:+]/g, '') || '',
  );
  return `${m[1]}${formatNode(node)}`;
}

function translateEditLine(text: string, ctx: EditCtx): string[] {
  if (text.startsWith('-')) return [text];
  const m = /^(.*?)\s+@\s+([a-z][a-z0-9_]*)$/.exec(text);
  const after = m?.[2];
  const stmt = m?.[1] ?? text;
  const tokens = lexDense(stmt, 1, ctx.compact);
  const fp = new FunctionParser(
    ctx.arities,
    ctx.fnNames,
    new Set([...ctx.target.nodes.map((n) => n.id), ...ctx.defined]),
    ctx.compact
      ? {
          fnName: '',
          lifted: [],
          sigs: new Map(),
          paramTypes: ctx.target.params,
          // an edit line has no inline body, as without the compact spellings
          nested: true,
          fill: true,
          compact: true,
          counter: { n: 0 },
        }
      : undefined,
  );
  fp.paramTypes = ctx.target.params;
  const s = fp.statement(tokens, 1, undefined);
  const root = fp.nodes.length - 1;
  const created = s.value.kind === 'node' && s.value.id.startsWith('\u0000');
  const name = fp.explicit[root];
  if (!s.ret && name === undefined)
    throw new A0Error(`edit line '${text}' names no value`, undefined, {
      code: 'edit',
      fix: 'start the line with the id of the value to set (`x add A 1`), write `ret EXPR`, or send the whole function as `fn NAME ...`',
    });
  if (!created) {
    if (s.ret) return [`ret ${formatOperand(s.value)}`];
    throw new A0Error(
      `edit line '${text}' sets '${name}' to something that is not an operation`,
      undefined,
      {
        code: 'edit',
        fix: `write \`${name} mov ...\` to copy a value`,
      },
    );
  }
  const base = s.ret ? 'retval' : (name as string);
  const rootId = s.ret
    ? freshRetId([...ctx.target.nodes, ...[...ctx.taken].map((id) => ({ id }))])
    : base;
  const ids: string[] = [];
  const used = new Set(ctx.taken);
  used.add(rootId);
  let n = 1;
  for (let k = 0; k < root; k += 1) {
    let id = `${base}_${n}`;
    while (used.has(id) || !isValidIdentifier(id)) {
      n += 1;
      id = `${base}_${n}`;
    }
    n += 1;
    used.add(id);
    ids.push(id);
  }
  ids.push(rootId);
  const { nodes, resolve } = fp.finishWith(ids);
  for (const id of ids) ctx.taken.add(id);
  ctx.defined.add(rootId);
  let prev = after;
  const lines = nodes.map((node) => {
    const line = `${formatNode(node)}${prev === undefined ? '' : ` @ ${prev}`}`;
    prev = node.id;
    return line;
  });
  if (s.ret) lines.push(`ret ${formatOperand(resolve(s.value))}`);
  return lines;
}

/**
 * Translate the body of a dense reply (comment-free, trimmed, non-empty lines after the
 * handle) to canonical edit lines. `handled` is the function the handle edits (absent under a
 * program handle, where only whole `fn` blocks and `-fn` lines are meaningful).
 */
export function denseEditBody(
  lines: readonly string[],
  program: TypedProgram,
  handled: TypedFunc | undefined,
  /** Receives, per function the reply defines or edits, the dense text of its nodes by id. */
  sink?: Map<string, Map<string, string>>,
  options: DenseEditOptions = {},
): string[] {
  const compact = options.compact === true;
  type Item = { kind: 'block'; index: number } | { kind: 'line'; text: string };
  const blocks: string[][] = [];
  const outer: Item[] = [];
  let open = false;
  for (const t of lines) {
    if (/^-fn(\s|$)/.test(t) || isProfileEdit(t)) {
      outer.push({ kind: 'line', text: t });
      open = false;
    } else if (/^fn(\s|$)/.test(t)) {
      if (isDenseSignatureEcho(t, program)) continue;
      const inline = /\send$/.test(t);
      blocks.push([inline ? t.slice(0, -3).trimEnd() : t]);
      outer.push({ kind: 'block', index: blocks.length - 1 });
      open = !inline;
    } else if (t === 'end') {
      open = false;
    } else if (open) {
      (blocks[blocks.length - 1] as string[]).push(t);
    } else {
      outer.push({ kind: 'line', text: t });
    }
  }

  // Parse the blocks in an order where each callee is known: the program's functions (a
  // function a block redefines counts with its new parameter list), then earlier blocks.
  const arities = new Map<string, number>(program.functions.map((f) => [f.name, f.params.length]));
  const names = blocks.map((b) => /^fn\s+(\S+)/.exec(b[0] ?? '')?.[1] ?? '');
  for (const name of names) {
    arities.delete(name);
    // the inline bodies a block writes are lifted to `NAME_1`, ...: they replace the old ones
    for (const key of [...arities.keys()])
      if (new RegExp(`^${name}_[0-9]+$`).test(key)) arities.delete(key);
  }
  const signatures = new Map(
    program.functions.map((f) => [f.name, { params: f.params, result: f.result }] as const),
  );
  const parsed = new Map<number, Func[]>();
  let pending = blocks.map((_, i) => i);
  let firstError: unknown;
  while (pending.length > 0) {
    const stuck: number[] = [];
    firstError = undefined;
    for (const i of pending) {
      try {
        const p = parseDense((blocks[i] as string[]).join('\n'), {
          known: arities,
          names: new Set(names),
          signatures,
          shadowing: true,
          ...(compact ? { compact } : {}),
        });
        parsed.set(i, [...p.functions]);
        for (const f of p.functions) arities.set(f.name, f.params.length);
      } catch (e) {
        if (e instanceof A0Error && /unknown function/.test(e.message)) {
          stuck.push(i);
          firstError ??= e;
        } else throw e;
      }
    }
    if (stuck.length === pending.length) throw firstError;
    pending = stuck;
  }

  if (sink !== undefined) {
    for (const f of [...parsed.values()].flat())
      sink.set(f.name, denseNodeTexts(f, { functions: [f] }, { known: arities }));
    if (handled !== undefined && !sink.has(handled.name))
      sink.set(handled.name, denseNodeTexts(handled, program, {}));
  }
  const target =
    handled === undefined ? undefined : (blockFor(parsed, names, handled.name) ?? handled);
  const ctx: EditCtx | undefined =
    target === undefined
      ? undefined
      : {
          program,
          arities,
          fnNames: new Set([...arities.keys(), ...names]),
          target,
          taken: new Set(target.nodes.map((n) => n.id)),
          defined: new Set(),
          compact,
        };
  const out: string[] = [];
  for (const item of outer) {
    if (item.kind === 'block') {
      for (const f of parsed.get(item.index) ?? []) out.push(...formatFunction(f).split('\n'));
    } else if (DENSE_SPEC_SET.test(item.text))
      out.push(
        translateSpecSet(
          DENSE_SPEC_SET.exec(item.text) as RegExpExecArray,
          arities,
          new Set([...arities.keys(), ...names]),
        ),
      );
    else if (ctx === undefined || item.text.startsWith('-fn') || isProfileEdit(item.text))
      out.push(item.text);
    else out.push(...translateEditLine(item.text, ctx));
  }
  return out;
}

function blockFor(
  parsed: ReadonlyMap<number, readonly Func[]>,
  names: readonly string[],
  name: string,
): Func | undefined {
  const i = names.indexOf(name);
  return i < 0 ? undefined : parsed.get(i)?.find((f) => f.name === name);
}
