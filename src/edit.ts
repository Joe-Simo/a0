/**
 * Content revisions, atomic node replacement, and bounded edit sessions.
 *
 * Two edit paths:
 *  1. Self-contained patch: `patch <fn> <sha256>` + replacement nodes + `end`.
 *  2. Session-bound edit: a session retains the revision and hands out a short
 *     handle (`e0`); the edit text is the handle line followed by replacement nodes. The
 *     handle line may be omitted when exactly one function handle (or, with none, one
 *     program handle) is open.
 *
 * Both paths replace existing nodes only. The full replacement set is validated
 * against the whole function before anything is committed. Successful handles are
 * consumed; unknown, consumed, or mismatched handles are rejected.
 *
 * A handle is a reference, not an authorization credential.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  A0Error,
  type Func,
  formatFunction,
  formatOperand,
  formatProgram,
  formatType,
  freshRetId,
  isRetNodeForm,
  isValidIdentifier,
  LIMITS,
  type Node,
  type Operand,
  type Program,
  parse,
  parseNode,
  parseOperand,
  retOperandError,
  stripComment,
  type TypedFunc,
  type TypedProgram,
  utf8Length,
  validate,
  validateFunction,
} from './core.js';

export const REVISION_LENGTH = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HANDLE = /^e(0|[1-9][0-9]*)$/;
const PROGRAM_HANDLE = /^g(0|[1-9][0-9]*)$/;

/** Content revision of a function: SHA-256 of its canonical source form. */
export function revision(fn: Func): string {
  return bytesToHex(sha256(new TextEncoder().encode(formatFunction(fn))));
}

/** Content revision of a whole program. */
export function programRevision(program: Program): string {
  return bytesToHex(sha256(new TextEncoder().encode(formatProgram(program))));
}

export interface Replacement {
  readonly functionName: string;
  readonly nodes: readonly Node[];
}

/**
 * One line of an edit:
 *   `id op operands…`            replace node `id` if it exists, otherwise insert it before `ret`
 *   `id op operands… @ other`    insert (or move) `id` immediately after node `other`
 *   `-id`                        delete node `id`
 *   `ret operand`                change the function result
 * The whole edit is validated as one function and committed atomically.
 */
export type EditOp =
  | { readonly kind: 'node'; readonly node: Node; readonly after?: string; readonly fresh?: true }
  | { readonly kind: 'delete'; readonly id: string }
  | { readonly kind: 'ret'; readonly operand: Operand };

export function parseEditOps(lines: readonly string[], firstLine: number): EditOp[] {
  if (lines.length === 0) throw new A0Error('edit contains no lines', undefined, { code: 'edit' });
  if (lines.length > LIMITS.maxNodesPerFunction)
    throw new A0Error('edit too large', undefined, { code: 'limit' });
  const seen = new Set<string>();
  const ops: EditOp[] = [];
  let sawRet = false;
  lines.forEach((text, i) => {
    const line = firstLine + i;
    const claim = (id: string): void => {
      if (seen.has(id)) throw new A0Error(`duplicate edit for '${id}'`, line, { code: 'edit' });
      seen.add(id);
    };
    if (text.startsWith('-')) {
      const id = text.slice(1).trim();
      if (!isValidIdentifier(id))
        throw new A0Error(`invalid delete target '${id}'`, line, { code: 'edit' });
      claim(id);
      ops.push({ kind: 'delete', id });
      return;
    }
    if (/^ret\s/.test(text)) {
      if (sawRet) throw new A0Error('duplicate ret in edit', line, { code: 'edit' });
      sawRet = true;
      const parts = text.split(/\s+/);
      if (isRetNodeForm(parts)) {
        // `ret OP ARGS…`: a fresh node plus `ret` of it (same sugar as in source).
        // The id is provisional: replaceNodes picks one that is free in the function.
        const node = parseNode(`retval ${parts.slice(1).join(' ')}`, line);
        ops.push({ kind: 'node', node, fresh: true });
        ops.push({ kind: 'ret', operand: { kind: 'node', id: 'retval' } });
        return;
      }
      if (parts.length !== 2) throw retOperandError(parts, line, 'edit');
      ops.push({ kind: 'ret', operand: parseOperand(parts[1] ?? '', line) });
      return;
    }
    const m = /^(.*?)\s+@\s+([a-z][a-z0-9_]*)$/.exec(text);
    const node = parseNode(m ? (m[1] ?? '') : text, line);
    claim(node.id);
    ops.push(m ? { kind: 'node', node, after: m[2] ?? '' } : { kind: 'node', node });
  });
  return ops;
}

/** Backwards-compatible helper: replacement-only edits as EditOps. */
function parseReplacementNodes(lines: readonly string[], firstLine: number): EditOp[] {
  return parseEditOps(lines, firstLine);
}

/**
 * Apply node replacements to one function. Each replacement must name an existing
 * node; the node keeps its position, so dependency order is preserved and forward
 * references remain impossible. The whole result is re-validated before returning.
 */
function orderByDependencies(nodes: readonly Node[]): Node[] {
  const out = [...nodes];
  for (let round = 0; round < out.length * out.length + 1; round += 1) {
    const index = new Map(out.map((n, i) => [n.id, i] as const));
    let moved = false;
    for (let i = 0; i < out.length; i += 1) {
      const n = out[i] as Node;
      let last = -1;
      for (const a of n.args) {
        if (a.kind !== 'node') continue;
        const j = index.get(a.id);
        if (j !== undefined && j > last) last = j;
      }
      if (last > i) {
        out.splice(i, 1);
        out.splice(last, 0, n);
        moved = true;
        break;
      }
    }
    if (!moved) return out;
  }
  return [...nodes];
}

export function replaceNodes(
  program: TypedProgram,
  fn: TypedFunc,
  ops: readonly (EditOp | Node)[],
): TypedFunc {
  let edits: EditOp[] = ops.map((o) => ('kind' in o ? o : { kind: 'node', node: o }));
  // A `ret OP …` node gets an id that is free in the function and in the edit.
  const freshOp = edits.find((o) => o.kind === 'node' && o.fresh === true);
  if (freshOp !== undefined && freshOp.kind === 'node') {
    const id = freshRetId([
      ...fn.nodes,
      ...edits.flatMap((o) => (o.kind === 'node' && o.fresh !== true ? [o.node] : [])),
    ]);
    edits = edits.map((o) => {
      if (o.kind === 'node' && o.fresh === true) return { kind: 'node', node: { ...o.node, id } };
      if (o.kind === 'ret' && o.operand.kind === 'node' && o.operand.id === 'retval')
        return { kind: 'ret', operand: { kind: 'node', id } };
      return o;
    });
  }
  let nodes: Node[] = [...fn.nodes];
  let ret = fn.ret;
  // 1. deletions
  for (const op of edits) {
    if (op.kind !== 'delete') continue;
    const before = nodes.length;
    nodes = nodes.filter((n) => n.id !== op.id);
    if (nodes.length === before)
      throw new A0Error(`${fn.name}: cannot delete unknown node '${op.id}'`, undefined, {
        code: 'edit',
      });
  }
  // 2. replacements and insertions
  for (const op of edits) {
    if (op.kind !== 'node') continue;
    const at = nodes.findIndex((n) => n.id === op.node.id);
    if (op.after !== undefined) {
      if (at >= 0) nodes.splice(at, 1);
      const anchor = nodes.findIndex((n) => n.id === op.after);
      if (anchor < 0)
        throw new A0Error(`${fn.name}: cannot insert after unknown node '${op.after}'`, undefined, {
          code: 'edit',
        });
      nodes.splice(anchor + 1, 0, op.node);
    } else if (at >= 0) {
      nodes[at] = op.node;
    } else {
      nodes.push(op.node);
    }
  }
  // 3. result
  for (const op of edits) if (op.kind === 'ret') ret = op.operand;
  // Edits may list nodes in any order that has a valid dependency order: move each node
  // that references a later node to just after its last reference. A true cycle is left
  // for the validator to report.
  nodes = orderByDependencies(nodes);
  if (nodes.length > LIMITS.maxNodesPerFunction)
    throw new A0Error(`${fn.name}: too many nodes`, undefined, { code: 'limit' });
  const replaced: Func = { ...fn, nodes, ret };
  // Legal call targets are exactly the functions defined before this one.
  const scope = new Map<string, TypedFunc>();
  for (const f of program.functions) {
    if (f.name === fn.name) break;
    scope.set(f.name, f);
  }
  const typed = validateFunction(replaced, scope);
  // A node this edit adds that nothing reads is almost always a result the reply forgot to
  // return (`ret` still names the old node). Land nothing silently wrong: reject with the fix.
  const existing = new Set(fn.nodes.map((n) => n.id));
  const used = new Set<string>();
  for (const n of nodes) for (const a of n.args) if (a.kind === 'node') used.add(a.id);
  if (ret.kind === 'node') used.add(ret.id);
  for (const op of edits) {
    if (op.kind !== 'node' || existing.has(op.node.id) || used.has(op.node.id)) continue;
    throw new A0Error(
      `${fn.name}: new node '${op.node.id}' is not used by any node or by ret`,
      undefined,
      {
        code: 'edit',
        fix: `add 'ret ${op.node.id}' if it is the new result, or use it in another node`,
      },
    );
  }
  return typed;
}

/**
 * Semantic revision: the function's own content revision folded with the semantic
 * revisions of every callee, transitively. Any change in a dependency changes it,
 * so it is the correct cache key for derived artifacts (unlike `revision`, which
 * is the editing identity of one function's text).
 */
export function semanticRevision(fn: TypedFunc): string {
  let text = revision(fn);
  for (const name of [...fn.calls.keys()].sort()) {
    const callee = fn.calls.get(name);
    if (callee !== undefined) text += `|${name}=${semanticRevision(callee)}`;
  }
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

/**
 * Functions a reply adds (absent from `before`) that its edit lines for `target` call are moved
 * to just before `target`, in their order, so the handled function may call a function added in
 * the same reply (callees precede callers). Other functions keep their places.
 */
function placeNewCallees(
  before: TypedProgram,
  program: TypedProgram,
  target: string,
  edits: readonly EditOp[],
): TypedProgram {
  const called = new Set(
    edits.flatMap((e) =>
      e.kind === 'node' ? [e.node.callee, e.node.pred].filter((c) => c !== undefined) : [],
    ),
  );
  const at = program.functions.findIndex((f) => f.name === target);
  const moved = program.functions.filter(
    (f, i) => i > at && called.has(f.name) && !before.byName.has(f.name),
  );
  if (moved.length === 0) return program;
  const rest = program.functions.filter((f) => !moved.includes(f));
  const k = rest.findIndex((f) => f.name === target);
  return validate({ functions: [...rest.slice(0, k), ...moved, ...rest.slice(k)] });
}

function commit(program: TypedProgram, updated: TypedFunc): TypedProgram {
  const functions = program.functions.map((f) => (f.name === updated.name ? updated : f));
  return validate({ functions });
}

// ---------------------------------------------------------------------------
// Self-contained patch
// ---------------------------------------------------------------------------

export interface Patch {
  readonly functionName: string;
  readonly revision: string;
  readonly nodes: readonly EditOp[];
}

export function formatPatch(fn: Func, nodes: readonly Node[]): string {
  const body = nodes.map((n) => `${n.id} ${n.op} ${n.args.map(formatOperand).join(' ')}`);
  return `patch ${fn.name} ${revision(fn)}\n${body.join('\n')}\nend`;
}

export function parsePatch(text: string): Patch {
  if (utf8Length(text) > LIMITS.maxSourceBytes)
    throw new A0Error('patch too large', undefined, { code: 'limit' });
  const lines = text
    .split(/\r?\n/)
    .map((l) => stripComment(l).trim())
    .filter((l) => l.length > 0);
  const head = lines[0]?.split(/\s+/) ?? [];
  if (head[0] !== 'patch' || head.length !== 3) {
    throw new A0Error("expected 'patch <function> <revision>'", 1, { code: 'patch' });
  }
  const functionName = head[1] ?? '';
  const rev = head[2] ?? '';
  if (!SHA256_HEX.test(rev))
    throw new A0Error('revision must be 64 lowercase hex characters', 1, { code: 'patch' });
  if (lines[lines.length - 1] !== 'end')
    throw new A0Error("patch must end with 'end'", undefined, { code: 'patch' });
  const nodes = parseReplacementNodes(lines.slice(1, -1), 2);
  return { functionName, revision: rev, nodes };
}

export function applyPatch(program: TypedProgram, patch: Patch): TypedProgram {
  const fn = program.byName.get(patch.functionName);
  if (fn === undefined)
    throw new A0Error(`unknown function '${patch.functionName}'`, undefined, { code: 'patch' });
  const current = revision(fn);
  if (current !== patch.revision) {
    throw new A0Error(
      `revision mismatch for '${fn.name}': patch targets ${patch.revision.slice(0, 12)}…, current is ${current.slice(0, 12)}…`,
      undefined,
      {
        code: 'revision',
        fix: `re-read '${fn.name}' to obtain its current revision and re-issue the patch`,
      },
    );
  }
  return commit(program, replaceNodes(program, fn, patch.nodes));
}

// ---------------------------------------------------------------------------
// Session-bound edits
// ---------------------------------------------------------------------------

export interface View {
  readonly handle: string;
  readonly functionName: string;
  readonly revision: string;
  /** Text shown to the model: handle line, the function source, then (scoped views) callee signatures. */
  readonly text: string;
}

export interface ViewOptions {
  /**
   * 'function' (default): the function only. 'deps': the function plus one signature line
   * (`fn name types -> type`) per direct callee, which is everything a type-correct edit of
   * this function can depend on; bodies of callees are not shown.
   */
  readonly scope?: 'function' | 'deps';
  /**
   * Number the function's body lines (`1 a add p0 p1` ... `N ret a`) so a reply can address
   * them: `N line` replaces line N, `N-` deletes it, `N+ line` inserts after it (`0+` at the
   * top), and `f:N...` addresses function f. The header and `end` are not numbered.
   */
  readonly numbered?: boolean;
}

export function formatSignature(fn: Func): string {
  const sig = fn.params.length > 0 ? ` ${fn.params.map(formatType).join(' ')}` : '';
  return `fn ${fn.name}${sig} -> ${formatType(fn.result)}`;
}

/** A function's source with its body lines (instructions and `ret`) numbered from 1. */
export function numberedFunction(fn: Func): string {
  const lines = formatFunction(fn).split('\n');
  const body = lines.slice(1, -1).map((l, i) => `${i + 1} ${l}`);
  return [lines[0] ?? '', ...body, 'end'].join('\n');
}

/** The dependency-scoped view text of a function (without a handle line). */
export function scopedView(fn: TypedFunc, numbered = false): string {
  const text = numbered ? numberedFunction(fn) : formatFunction(fn);
  const sigs = [...fn.calls.values()].map((c) => `${formatSignature(c)} end`);
  return sigs.length > 0 ? `${text}\n${sigs.join('\n')}` : text;
}

/** `N line`, `N-`, `N+ line`, each optionally prefixed with `f:` (a function name). */
const LINE_EDIT = /^(?:([a-z][a-z0-9_]*):)?(0|[1-9][0-9]*)([+-]?)(?:\s+(.*))?$/;

/**
 * Separate line-addressed edits from the rest of a reply. Only lines outside `fn` blocks are
 * line edits; inside a block (up to `end`, the next `fn`/`-fn` line, or the end of the reply) a
 * leading view number (`1 a add p0 p1`) is the numbered view copied back and is dropped.
 * Unambiguous: instruction ids start with a letter.
 */
function splitLineEdits(lines: readonly string[]): { edits: string[]; rest: string[] } {
  const edits: string[] = [];
  const rest: string[] = [];
  let open = false;
  for (const raw of lines) {
    const t = stripComment(raw).trim();
    if (/^-?fn\s/.test(t)) {
      open = t.startsWith('fn') && !/\send$/.test(t);
      rest.push(raw);
    } else if (open) {
      if (t === 'end') open = false;
      rest.push(t.replace(/^(0|[1-9][0-9]*)\s+(?=[a-z])/, ''));
    } else if (LINE_EDIT.test(t)) edits.push(t);
    else rest.push(raw);
  }
  return { edits, rest };
}

/**
 * Turn line-addressed edits into whole `fn ... end` blocks. Line numbers refer to the numbered
 * view of the function in `program` (body lines, `ret` last); a bare number addresses
 * `defaultFn`. Several inserts after one line keep their order. Each number is replaced or
 * deleted at most once. The blocks then go through the ordinary whole-function path, so the
 * result is parsed and the whole program validated before anything is committed.
 */
export function lineEditBlocks(
  program: TypedProgram,
  lines: readonly string[],
  defaultFn: string | undefined,
): string[] {
  const byFn = new Map<string, { at: Map<number, string | null>; after: Map<number, string[]> }>();
  for (const raw of lines) {
    const t = stripComment(raw).trim();
    const m = LINE_EDIT.exec(t);
    if (m === null) throw new A0Error(`bad line edit '${t}'`, undefined, { code: 'edit' });
    const name = m[1] ?? defaultFn;
    if (name === undefined)
      throw new A0Error(`line edit '${t}' names no function`, undefined, {
        code: 'edit',
        fix: 'write `f:N line` with the function name',
      });
    const fn = program.byName.get(name);
    if (fn === undefined)
      throw new A0Error(`line edit '${t}': unknown function '${name}'`, undefined, {
        code: 'edit',
      });
    const size = formatFunction(fn).split('\n').length - 2;
    const n = Number(m[2]);
    const mode = m[3] ?? '';
    const text = (m[4] ?? '').trim();
    const entry = byFn.get(name) ?? { at: new Map(), after: new Map() };
    byFn.set(name, entry);
    if (mode === '+') {
      if (n > size || text === '')
        throw new A0Error(`line edit '${t}': insert after line 0..${size} with text`, undefined, {
          code: 'edit',
        });
      entry.after.set(n, [...(entry.after.get(n) ?? []), text]);
      continue;
    }
    if (n < 1 || n > size)
      throw new A0Error(`line edit '${t}': ${name} has lines 1..${size}`, undefined, {
        code: 'edit',
        fix: 'use the line numbers shown in the view',
      });
    if (entry.at.has(n))
      throw new A0Error(`line edit '${t}': line ${n} edited twice`, undefined, { code: 'edit' });
    if (mode === '' && text === '')
      throw new A0Error(`line edit '${t}' has no text`, undefined, {
        code: 'edit',
        fix: `write '${n}-' to delete the line`,
      });
    entry.at.set(n, mode === '-' ? null : text);
  }
  return [...byFn].map(([name, { at, after }]) => {
    const src = formatFunction(program.byName.get(name) as TypedFunc).split('\n');
    const body = src.slice(1, -1);
    const out: string[] = [...(after.get(0) ?? [])];
    body.forEach((line, i) => {
      const edited = at.has(i + 1) ? at.get(i + 1) : line;
      if (edited !== null && edited !== undefined) out.push(edited);
      out.push(...(after.get(i + 1) ?? []));
    });
    return [src[0] ?? '', ...out, 'end'].join('\n');
  });
}

interface OpenHandle {
  /** Function name, or '*' for a program-level handle. */
  readonly functionName: string;
  readonly revision: string;
  readonly scope: ViewOptions['scope'];
  /** Program handles opened with `scope: 'deps'`: the function the view is centred on. */
  readonly target?: string;
  readonly numbered?: boolean;
}

export interface ProgramViewOptions {
  /**
   * 'all' (default): one signature line per function. 'deps': only the signatures of
   * `target`, its transitive callees, and its direct callers, after a comment line giving
   * the program's size. The handle still edits the whole program; only the listing shrinks.
   */
  readonly scope?: 'all' | 'deps';
  /** Required with `scope: 'deps'`. */
  readonly target?: string;
}

/** Program-level view: one signature line per function, in definition order. */
export function programView(program: TypedProgram): string {
  return program.functions.map((f) => `${formatSignature(f)} end`).join('\n');
}

/**
 * The functions a dependency-scoped program view lists for `target`: the target, every
 * function it reaches through calls, folds, and loops (transitively), and every function
 * that calls it directly; in definition order.
 */
export function programNeighbourhood(program: TypedProgram, target: string): TypedFunc[] {
  const fn = program.byName.get(target);
  if (fn === undefined)
    throw new A0Error(`unknown function '${target}'`, undefined, { code: 'handle' });
  const keep = new Set<string>([target]);
  const stack: TypedFunc[] = [fn];
  while (stack.length > 0) {
    const f = stack.pop() as TypedFunc;
    for (const c of f.calls.values())
      if (!keep.has(c.name)) {
        keep.add(c.name);
        stack.push(c);
      }
  }
  for (const f of program.functions) if (f.calls.has(target)) keep.add(f.name);
  return program.functions.filter((f) => keep.has(f.name));
}

/** Dependency-scoped program view (without a handle line); see `ProgramViewOptions`. */
export function scopedProgramView(program: TypedProgram, target: string): string {
  const shown = programNeighbourhood(program, target);
  const head = `# ${program.functions.length} functions; shown: ${target}, its callees, its callers`;
  return [head, ...shown.map((f) => `${formatSignature(f)} end`)].join('\n');
}

/**
 * Apply a program-level edit: `fn … end` blocks replace a function of the same name in
 * place or append a new function at the end (where it may call every existing function);
 * `-fn name` removes a function. The whole program is re-validated; callers of a removed or
 * re-typed function fail the edit atomically.
 */
/**
 * Close every `fn` block of an edit that the reply left open: a block ends at the next `fn` or
 * `-fn` line or at the end of the reply, so its trailing `end` is optional. Unambiguous because
 * `fn` and `end` are reserved and never start an instruction line.
 */
function closeBlocks(lines: readonly string[]): string[] {
  const out: string[] = [];
  let open = false;
  for (const raw of lines) {
    const t = stripComment(raw).trim();
    if (/^-?fn\s/.test(t)) {
      if (open) out.push('end');
      open = t.startsWith('fn') && !/\send$/.test(t);
    } else if (t === 'end') open = false;
    out.push(raw);
  }
  if (open) out.push('end');
  return out;
}

/** A one-line `fn NAME types -> T end` naming an existing function: the view's signature line echoed back, carrying no change. */
function isSignatureEcho(line: string, program: TypedProgram): boolean {
  const m = /^fn\s+([a-z][a-z0-9_]*)\b.*\send$/.exec(line);
  return m !== null && program.byName.has(m[1] ?? '');
}

/** Stable topological order of functions by the calls among them (a cycle keeps the given order). */
function orderFunctionsByCalls(fns: readonly Func[]): Func[] {
  const names = new Set(fns.map((f) => f.name));
  const callees = (f: Func): string[] =>
    f.nodes.flatMap((n) => {
      const c: string[] = [];
      if (n.callee !== undefined && names.has(n.callee)) c.push(n.callee);
      if (n.pred !== undefined && names.has(n.pred)) c.push(n.pred);
      return c;
    });
  const out: Func[] = [];
  const done = new Set<string>();
  const pending = [...fns];
  while (pending.length > 0) {
    const i = pending.findIndex((f) => callees(f).every((c) => done.has(c) || c === f.name));
    if (i < 0) return [...out, ...pending];
    const [f] = pending.splice(i, 1);
    out.push(f as Func);
    done.add((f as Func).name);
  }
  return out;
}

export function editProgram(program: TypedProgram, text: string): TypedProgram {
  const lines = closeBlocks(text.split(/\r?\n/));
  const removals = new Set<string>();
  const kept: string[] = [];
  for (const raw of lines) {
    const line = stripComment(raw).trim();
    const m = /^-fn\s+([a-z][a-z0-9_]*)$/.exec(line);
    if (m) removals.add(m[1] ?? '');
    else if (isSignatureEcho(line, program)) continue;
    else kept.push(raw);
  }
  const incoming = orderFunctionsByCalls(parse(kept.join('\n')).functions);
  const byName = new Map(incoming.map((f) => [f.name, f] as const));
  for (const name of removals) {
    if (!program.byName.has(name))
      throw new A0Error(`cannot remove unknown function '${name}'`, undefined, { code: 'edit' });
    if (byName.has(name))
      throw new A0Error(`function '${name}' is both removed and defined`, undefined, {
        code: 'edit',
      });
  }
  // New functions are placed where the reply put them relative to replaced ones: everything
  // written above a replaced function is inserted just before it (so a new callee written
  // above its caller is defined earlier); trailing new functions are appended.
  const before = new Map<string, Func[]>();
  let pending: Func[] = [];
  for (const f of incoming) {
    if (program.byName.has(f.name)) {
      before.set(f.name, pending);
      pending = [];
    } else pending.push(f);
  }
  const functions: Func[] = [];
  for (const f of program.functions) {
    if (removals.has(f.name)) continue;
    const replacement = byName.get(f.name);
    if (replacement !== undefined) functions.push(...(before.get(f.name) ?? []));
    functions.push(replacement ?? f);
  }
  functions.push(...pending);
  if (functions.length === 0)
    throw new A0Error('edit would leave the program with no functions', undefined, {
      code: 'edit',
    });
  return validate({ functions });
}

export interface SessionOptions {
  readonly maxOpenHandles?: number;
}

/**
 * A bounded, in-memory edit session. Not a network service; no authentication or
 * multi-principal isolation exists in v0.1.
 */
export class EditSession {
  #program: TypedProgram;
  readonly #handles = new Map<string, OpenHandle>();
  readonly #maxOpen: number;
  #nextFn = 0;
  #nextProgram = 0;

  constructor(program: TypedProgram, options: SessionOptions = {}) {
    this.#program = program;
    this.#maxOpen = options.maxOpenHandles ?? 64;
  }

  get program(): TypedProgram {
    return this.#program;
  }

  get openHandles(): number {
    return this.#handles.size;
  }

  /**
   * Open a program-level view bound to the whole program's revision: all signatures, or
   * with `scope: 'deps'` only those around `target` (the handle still edits any function).
   */
  openProgram(options: ProgramViewOptions = {}): View {
    const target = options.scope === 'deps' ? options.target : undefined;
    if (options.scope === 'deps' && (target === undefined || !this.#program.byName.has(target)))
      throw new A0Error(`unknown function '${target ?? ''}'`, undefined, {
        code: 'handle',
        fix: "openProgram({ scope: 'deps', target }) needs the name of an existing function",
      });
    if (this.#handles.size >= this.#maxOpen) {
      throw new A0Error(
        `session handle limit (${this.#maxOpen}) reached; close handles first`,
        undefined,
        {
          code: 'limit',
        },
      );
    }
    const handle = `g${this.#nextProgram}`;
    this.#nextProgram += 1;
    const rev = programRevision(this.#program);
    this.#handles.set(handle, {
      functionName: '*',
      revision: rev,
      scope: undefined,
      ...(target === undefined ? {} : { target }),
    });
    return {
      handle,
      functionName: '*',
      revision: rev,
      text: `${handle}\n${this.#programText(target)}`,
    };
  }

  /** A scoped program view whose target was removed falls back to the full listing. */
  #programText(target: string | undefined): string {
    return target !== undefined && this.#program.byName.has(target)
      ? scopedProgramView(this.#program, target)
      : programView(this.#program);
  }

  /** Open a view of one function and return a short handle bound to its current revision. */
  open(functionName: string, options: ViewOptions = {}): View {
    const fn = this.#program.byName.get(functionName);
    if (fn === undefined)
      throw new A0Error(`unknown function '${functionName}'`, undefined, { code: 'handle' });
    if (this.#handles.size >= this.#maxOpen) {
      throw new A0Error(
        `session handle limit (${this.#maxOpen}) reached; close handles first`,
        undefined,
        {
          code: 'limit',
        },
      );
    }
    const handle = `e${this.#nextFn}`;
    this.#nextFn += 1;
    const rev = revision(fn);
    const numbered = options.numbered === true;
    this.#handles.set(handle, {
      functionName,
      revision: rev,
      scope: options.scope,
      ...(numbered ? { numbered } : {}),
    });
    const body = this.#functionText(fn, options.scope, numbered);
    return { handle, functionName, revision: rev, text: `${handle}\n${body}` };
  }

  /** The current view under an open handle (handles are stable for the session). */
  view(handle: string): string {
    const bound = this.#handles.get(handle);
    if (bound === undefined) throw new A0Error(`unknown handle '${handle}'`, 1, { code: 'handle' });
    if (bound.functionName === '*') return `${handle}\n${this.#programText(bound.target)}`;
    const fn = this.#program.byName.get(bound.functionName);
    if (fn === undefined)
      throw new A0Error(`handle '${handle}' refers to a removed function`, 1, { code: 'handle' });
    return `${handle}\n${this.#functionText(fn, bound.scope, bound.numbered === true)}`;
  }

  #functionText(fn: TypedFunc, scope: ViewOptions['scope'], numbered: boolean): string {
    if (scope === 'deps') return scopedView(fn, numbered);
    return numbered ? numberedFunction(fn) : formatFunction(fn);
  }

  /**
   * After a successful edit every open handle follows the program: a session has one
   * editor, so its handles stay valid and keep their names; a handle whose function was
   * removed is closed. The revision check still rejects any edit written against text
   * that is no longer current.
   */
  #rebind(): void {
    const progRev = programRevision(this.#program);
    for (const [handle, bound] of this.#handles) {
      if (bound.functionName === '*') {
        this.#handles.set(handle, { ...bound, revision: progRev });
        continue;
      }
      const fn = this.#program.byName.get(bound.functionName);
      if (fn === undefined) this.#handles.delete(handle);
      else this.#handles.set(handle, { ...bound, revision: revision(fn) });
    }
  }

  close(handle: string): boolean {
    return this.#handles.delete(handle);
  }

  /**
   * Apply a session edit: first line is the handle, remaining lines are replacement
   * nodes. The handle must be open and bound to the function's current revision.
   * On success the new program is committed atomically and every open handle is rebound
   * to the new revision (handles are stable names for the session).
   */
  apply(text: string): TypedProgram {
    if (utf8Length(text) > LIMITS.maxSourceBytes)
      throw new A0Error('edit too large', undefined, { code: 'limit' });
    const rawLines = text.split(/\r?\n/);
    // The handle line may be left out when it is implied: the reply then edits the one open
    // function handle (which also takes whole `fn` blocks and `-fn` lines), or, with no
    // function handle open, the one open program handle.
    const firstLine = rawLines.map((l) => stripComment(l).trim()).find((l) => l.length > 0) ?? '';
    if (!HANDLE.test(firstLine) && !PROGRAM_HANDLE.test(firstLine)) {
      const open = [...this.#handles.keys()];
      const fnHandles = open.filter((h) => HANDLE.test(h));
      const implied = fnHandles.length > 0 ? fnHandles : open;
      if (implied.length !== 1)
        throw new A0Error(`invalid handle '${firstLine}'`, 1, {
          code: 'handle',
          fix: 'start the reply with one of the handle lines shown in the view',
        });
      return this.apply(`${implied[0] as string}\n${text}`);
    }
    // A reply may carry several sections, each headed by an open handle; they apply in
    // order as one atomic edit (all or nothing).
    const heads = rawLines
      .map((l, i) => [stripComment(l).trim(), i] as const)
      .filter(([l]) => /^[eg][0-9]+$/.test(l) && this.#handles.has(l));
    if (heads.length > 1) {
      const savedProgram = this.#program;
      const savedHandles = new Map(this.#handles);
      try {
        for (let k = 0; k < heads.length; k += 1) {
          const start = heads[k]?.[1] as number;
          const end = k + 1 < heads.length ? (heads[k + 1]?.[1] as number) : rawLines.length;
          const section = rawLines.slice(start, end);
          // A section that only echoes signatures (or is empty) carries no change.
          const body = section
            .slice(1)
            .map((l) => stripComment(l).trim())
            .filter((l) => l.length > 0);
          if (body.every((l) => l === 'end' || isSignatureEcho(l, this.#program))) continue;
          this.apply(section.join('\n'));
        }
      } catch (e) {
        this.#program = savedProgram;
        this.#handles.clear();
        for (const [h, b] of savedHandles) this.#handles.set(h, b);
        throw e;
      }
      return this.#program;
    }
    const lines = rawLines.map((l) => stripComment(l).trim()).filter((l) => l.length > 0);
    const handle = lines[0] ?? '';
    if (!HANDLE.test(handle) && !PROGRAM_HANDLE.test(handle)) {
      throw new A0Error(`invalid handle '${handle}'`, 1, { code: 'handle' });
    }
    const bound = this.#handles.get(handle);
    if (bound === undefined)
      throw new A0Error(`unknown handle '${handle}'`, 1, {
        code: 'handle',
        fix: 'reply with the handle line exactly as shown at the top of the view',
      });
    if (bound.functionName === '*') {
      if (programRevision(this.#program) !== bound.revision) {
        throw new A0Error(
          `handle '${handle}' is stale: the program changed since the view was opened`,
          undefined,
          { code: 'handle' },
        );
      }
      const rawBody = text
        .split(/\r?\n/)
        .slice(text.split(/\r?\n/).findIndex((l) => stripComment(l).trim() === handle) + 1);
      const { edits, rest } = splitLineEdits(rawBody);
      const blocks = lineEditBlocks(this.#program, edits, undefined);
      this.#program = editProgram(this.#program, [...closeBlocks(rest), ...blocks].join('\n'));
      this.#rebind();
      return this.#program;
    }
    const fn = this.#program.byName.get(bound.functionName);
    if (fn === undefined)
      throw new A0Error(`handle '${handle}' refers to a removed function`, undefined, {
        code: 'handle',
      });
    if (revision(fn) !== bound.revision) {
      throw new A0Error(
        `handle '${handle}' is stale: '${fn.name}' changed since the view was opened`,
        undefined,
        { code: 'handle' },
      );
    }
    let body = lines.slice(1);
    // The rest of the view echoed back (another handle line followed only by signature
    // lines) carries no change: drop it.
    const echoAt = body.findIndex((l) => /^[eg][0-9]+$/.test(stripComment(l).trim()));
    if (
      echoAt >= 0 &&
      body.slice(echoAt + 1).every((l) => {
        const t = stripComment(l).trim();
        return t === '' || isSignatureEcho(t, this.#program);
      })
    )
      body = body.slice(0, echoAt);
    // A trailing `end` mirrors the view and carries no information: accept it.
    let strippedEnd = false;
    while (body.length > 0 && stripComment(body[body.length - 1] ?? '').trim() === 'end') {
      body = body.slice(0, -1);
      strippedEnd = true;
    }
    while (body.length > 0 && stripComment(body[body.length - 1] ?? '').trim() === '')
      body = body.slice(0, -1);
    // Whole `fn ... end` blocks are program-level edits wherever they appear: the handled
    // function sent back whole replaces itself, and any other function is added or replaced
    // exactly as under a program handle. Edit lines before the first block apply to the
    // handled function after the blocks, so a callee changed in the same reply type-checks.
    // `-fn name` lines before the first block are program-level too, and so are edit lines
    // after a block's explicit `end` (outside every block they can only edit the handled
    // function; a block without `end` still takes the lines up to the next `fn`).
    // Line-addressed edits (`N line`, `N-`, `N+ line`, `f:N ...`) refer to the numbered view
    // before this reply; each edited function becomes a whole block, validated with the rest.
    const split = splitLineEdits(body);
    const lineBlocks = lineEditBlocks(this.#program, split.edits, fn.name);
    body = split.rest;
    const blockAt = body.findIndex((l) => /^fn\s/.test(stripComment(l).trim()));
    const head = blockAt < 0 ? body : body.slice(0, blockAt);
    const isRemoval = (l: string): boolean => /^-fn\s/.test(stripComment(l).trim());
    const editLines = head.filter((l) => !isRemoval(l));
    const programLines = head.filter(isRemoval);
    let open = false;
    for (const l of blockAt < 0 ? [] : body.slice(blockAt)) {
      const t = stripComment(l).trim();
      if (/^fn\s/.test(t)) open = !/\send$/.test(t);
      else if (t === 'end' || isRemoval(l)) open = false;
      else if (!open && t !== '') {
        editLines.push(l);
        continue;
      }
      programLines.push(l);
    }
    let program = this.#program;
    if (programLines.length > 0 || lineBlocks.length > 0) {
      const blocks = closeBlocks(strippedEnd && open ? [...programLines, 'end'] : programLines);
      program = editProgram(program, [...blocks, ...lineBlocks].join('\n'));
    }
    if (editLines.length > 0) {
      const target = program.byName.get(fn.name);
      if (target === undefined)
        throw new A0Error(
          `handle '${handle}' edits '${fn.name}', which this reply removes`,
          undefined,
          { code: 'edit', fix: `keep '${fn.name}' or send only whole function blocks` },
        );
      const nodes = parseReplacementNodes(editLines, 2);
      program = placeNewCallees(this.#program, program, fn.name, nodes);
      program = commit(
        program,
        replaceNodes(program, program.byName.get(fn.name) ?? target, nodes),
      );
    }
    this.#program = program;
    this.#rebind();
    return this.#program;
  }
}
