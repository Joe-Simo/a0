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
  reusing,
  formatType,
  freshRetId,
  isProfileEdit,
  isRetNodeForm,
  isValidIdentifier,
  LIMITS,
  type Node,
  normalizeLine,
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
import { formatDenseFunction, formatDenseSignature } from './dense.js';
import { denseEditBody } from './dense-edit.js';
import { diag } from './diagnostics.js';
import { fixAll } from './fix.js';
import { applySpecEdits, type SpecEdit, type SpecWord, withoutSpec, withSpec } from './spec.js';
import { keyLegend } from './wordkey.js';

export const REVISION_LENGTH = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HANDLE = /^e(0|[1-9][0-9]*)$/;
const PROGRAM_HANDLE = /^g(0|[1-9][0-9]*)$/;

/** Content revision of a function: SHA-256 of its canonical source form. */
const revisions = new WeakMap<Func, string>();

export function revision(fn: Func): string {
  if (!reusing()) return bytesToHex(sha256(new TextEncoder().encode(formatFunction(fn))));
  let rev = revisions.get(fn);
  if (rev === undefined) {
    rev = bytesToHex(sha256(new TextEncoder().encode(formatFunction(fn))));
    revisions.set(fn, rev);
  }
  return rev;
}

/** Content revision of a whole program. */
const programRevisions = new WeakMap<Program, string>();

export function programRevision(program: Program): string {
  const hash = (): string => bytesToHex(sha256(new TextEncoder().encode(formatProgram(program))));
  if (!reusing()) return hash();
  let rev = programRevisions.get(program);
  if (rev === undefined) {
    rev = hash();
    programRevisions.set(program, rev);
  }
  return rev;
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
  | { readonly kind: 'ret'; readonly operand: Operand }
  | ({ readonly kind: 'spec' } & SpecEdit);

/**
 * The error for a second line defining `id` in one reply. When that line reads `id` (`m sub m 1`
 * after `m sub p0 1`: two successive updates of one value) the reply means the sequence, and the
 * first line gets a fresh id that the second reads instead. That rewrite is exact when the first
 * line does not read `id` itself, no line in between reads `id`, neither line has an `@` anchor,
 * and the fresh id is used nowhere in the reply or the function (`taken`, when the caller knows it).
 */
function duplicateEditError(
  id: string,
  lines: readonly string[],
  firstAt: number,
  secondAt: number,
  line: number,
  taken: ReadonlySet<string> | undefined,
): A0Error {
  const reads = (text: string): boolean => text.split(/\s+/).slice(2).includes(id);
  const first = normalizeLine(lines[firstAt] ?? '');
  const second = normalizeLine(lines[secondAt] ?? '');
  const plain = (text: string): boolean => !text.includes('@') && text.split(' ')[0] === id;
  if (!reads(second) || !plain(first) || !plain(second)) {
    return diag('A0503', [id], {
      line,
      fix: `a reply edits each node once: keep the one line for '${id}' you mean, or give the other node its own id and use that id where its value is read`,
    });
  }
  const words = new Set(lines.flatMap((l) => normalizeLine(l).split(' ')));
  const candidate = (n: number): string =>
    isValidIdentifier(`${id}${n}`) ? `${id}${n}` : `${id}_${n}`;
  let n = 1;
  while (words.has(candidate(n)) || taken?.has(candidate(n)) === true) n += 1;
  const fresh = candidate(n);
  const firstTo = [fresh, ...first.split(' ').slice(1)].join(' ');
  const secondTo = second
    .split(' ')
    .map((w, k) => (k >= 2 && w === id ? fresh : w))
    .join(' ');
  const exact =
    taken !== undefined &&
    !reads(first) &&
    lines
      .slice(firstAt + 1, secondAt)
      .every((l) => !normalizeLine(l).split(' ').slice(1).includes(id));
  return diag('A0503', [id], {
    line,
    fix: `a reply edits each node once; for two successive updates give the first its own id: write \`${firstTo}\`, then \`${secondTo}\``,
    ...(exact ? { applicability: 'exact' as const } : {}),
    edits: [
      {
        op: 'lines',
        rule: 'sequence',
        text: first,
        to: firstTo,
        line: line - (secondAt - firstAt),
      },
      { op: 'lines', rule: 'sequence', text: second, to: secondTo, line },
    ],
  });
}

export function parseEditOps(
  lines: readonly string[],
  firstLine: number,
  taken?: ReadonlySet<string>,
): EditOp[] {
  if (lines.length === 0) throw diag('A0501');
  if (lines.length > LIMITS.maxNodesPerFunction) throw diag('A0502');
  const seen = new Map<string, number>();
  const ops: EditOp[] = [];
  const textDeletes = new Map<string, { text: string; line: number }>();
  let sawRet = false;
  lines.forEach((text, i) => {
    const line = firstLine + i;
    const claim = (id: string): void => {
      const at = seen.get(id);
      if (at !== undefined) throw duplicateEditError(id, lines, at, i, line, taken);
      seen.set(id, i);
    };
    const spec = SPEC_EDIT.exec(text);
    if (
      spec !== null &&
      spec[1] === undefined &&
      (spec[2] === '+' || (spec[4] ?? '').trim() !== '')
    ) {
      ops.push({ kind: 'spec', ...specEditOf(spec), line });
      return;
    }
    if (text.startsWith('-')) {
      const rest = text.slice(1).trim();
      const id = rest;
      if (!isValidIdentifier(id)) {
        // `-id` followed by the old node text (`-b ne r 0`) is a delete written with its text: it is accepted only when the same
        // reply adds `id` again (the pair is the replacement it means); otherwise it is the invalid delete target it always was.
        const head = /^([a-z][a-z0-9_]*)\s+\S/.exec(rest)?.[1];
        if (head === undefined || !isValidIdentifier(head)) throw diag('A0504', [id], { line });
        claim(head);
        textDeletes.set(head, { text: rest, line });
        ops.push({ kind: 'delete', id: head });
        return;
      }
      claim(id);
      ops.push({ kind: 'delete', id });
      return;
    }
    if (/^ret\s/.test(text)) {
      if (sawRet) throw diag('A0505', [], { line });
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
    // `-id` followed by `id op args` (no `@`) says "replace this node": the delete is dropped and the line stands as the
    // replacement, which is what the pair means. With `@ other` the pair is a move: unchanged (still a duplicate edit).
    if (m === null) {
      const prior = ops.findIndex((o) => o.kind === 'delete' && o.id === node.id);
      if (prior >= 0) {
        ops.splice(prior, 1);
        seen.delete(node.id);
        textDeletes.delete(node.id);
      }
    }
    claim(node.id);
    ops.push(m ? { kind: 'node', node, after: m[2] ?? '' } : { kind: 'node', node });
  });
  for (const [, d] of textDeletes) throw diag('A0504', [d.text], { line: d.line });
  return ops;
}

/** Backwards-compatible helper: replacement-only edits as EditOps. */
function parseReplacementNodes(
  lines: readonly string[],
  firstLine: number,
  taken?: ReadonlySet<string>,
): EditOp[] {
  return parseEditOps(lines, firstLine, taken);
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
  const specEdits: SpecEdit[] = edits.flatMap((o) => (o.kind === 'spec' ? [o] : []));
  // 1. deletions
  for (const op of edits) {
    if (op.kind !== 'delete') continue;
    const before = nodes.length;
    nodes = nodes.filter((n) => n.id !== op.id);
    if (nodes.length === before) {
      // `-pre` and `-post` remove the contract line when the function has no such node.
      if (
        (op.id === 'pre' && fn.spec?.pre !== undefined) ||
        (op.id === 'post' && fn.spec?.post !== undefined)
      ) {
        specEdits.push({ sign: '-', word: op.id, rest: '' });
        continue;
      }
      throw diag('A0506', [fn.name, op.id]);
    }
  }
  // 2. replacements and insertions
  for (const op of edits) {
    if (op.kind !== 'node') continue;
    const at = nodes.findIndex((n) => n.id === op.node.id);
    if (op.after !== undefined) {
      if (at >= 0) nodes.splice(at, 1);
      const anchor = nodes.findIndex((n) => n.id === op.after);
      if (anchor < 0) throw diag('A0507', [fn.name, op.after]);
      nodes.splice(anchor + 1, 0, op.node);
    } else if (at >= 0) {
      // A replaced line keeps its comments unless the edit line brings its own.
      const kept = (nodes[at] as Node).comments;
      nodes[at] =
        op.node.comments === undefined && kept !== undefined
          ? { ...op.node, comments: kept }
          : op.node;
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
  if (nodes.length > LIMITS.maxNodesPerFunction) throw diag('A0316', [fn.name]);
  const replaced: Func =
    specEdits.length === 0
      ? { ...fn, nodes, ret }
      : withSpec({ ...fn, nodes, ret }, applySpecEdits(fn, specEdits));
  // Legal call targets are exactly the functions defined before this one.
  const scope = new Map<string, TypedFunc>();
  for (const f of program.functions) {
    if (f.name === fn.name) break;
    scope.set(f.name, f);
  }
  const typed = validateFunction(replaced, scope, undefined, program.profile);
  // A node this edit adds that nothing reads is almost always a result the reply forgot to
  // return (`ret` still names the old node). Land nothing silently wrong: reject with the fix.
  const existing = new Set(fn.nodes.map((n) => n.id));
  const used = new Set<string>();
  for (const n of nodes) for (const a of n.args) if (a.kind === 'node') used.add(a.id);
  if (ret.kind === 'node') used.add(ret.id);
  for (const op of edits) {
    if (op.kind !== 'node' || existing.has(op.node.id) || used.has(op.node.id)) continue;
    throw diag('A0508', [fn.name, op.node.id]);
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
  // The profile changes what the function means, so it is part of every key derived from it. Spec
  // lines (examples and contracts) do not change what it computes: the revision of the function
  // without them keeps optimizer, cache and emission keys the same with or without a spec.
  const own = revision(withoutSpec(fn));
  let text = fn.profile === 'strict' ? `profile strict|${own}` : own;
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
  return validate({
    ...profileField(program),
    functions: [...rest.slice(0, k), ...moved, ...rest.slice(k)],
  });
}

/** `{ profile: 'strict' }` for a strict program, nothing for a canonical one (spread into `validate`). */
function profileField(program: { readonly profile?: 'strict' }): { profile?: 'strict' } {
  return program.profile === 'strict' ? { profile: 'strict' } : {};
}

function commit(program: TypedProgram, updated: TypedFunc): TypedProgram {
  const functions = program.functions.map((f) => (f.name === updated.name ? updated : f));
  return validate({ ...profileField(program), functions });
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
  if (utf8Length(text) > LIMITS.maxSourceBytes) throw diag('A0606');
  const lines = text
    .split(/\r?\n/)
    .map((l) => stripComment(l).trim())
    .filter((l) => l.length > 0);
  const head = lines[0]?.split(/\s+/) ?? [];
  if (head[0] !== 'patch' || head.length !== 3) {
    throw diag('A0601', [], { line: 1 });
  }
  const functionName = head[1] ?? '';
  const rev = head[2] ?? '';
  if (!SHA256_HEX.test(rev)) throw diag('A0602', [], { line: 1 });
  if (lines[lines.length - 1] !== 'end') throw diag('A0603');
  const nodes = parseReplacementNodes(lines.slice(1, -1), 2);
  return { functionName, revision: rev, nodes };
}

export function applyPatch(program: TypedProgram, patch: Patch): TypedProgram {
  const fn = program.byName.get(patch.functionName);
  if (fn === undefined) throw diag('A0604', [patch.functionName]);
  const current = revision(fn);
  if (current !== patch.revision) {
    throw diag('A0605', [fn.name, patch.revision.slice(0, 12), current.slice(0, 12)]);
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
   * this function can depend on; bodies of callees are not shown. 'bodies' (dense views only;
   * a canonical view treats it as 'deps'): the function plus the dense text of each direct callee,
   * for edits whose bug may sit in a helper.
   */
  readonly scope?: 'function' | 'deps' | 'bodies';
  /**
   * Number the function's body lines (`1 a add p0 p1` ... `N ret a`) so a reply can address
   * them: `N line` replaces line N, `N-` deletes it, `N+ line` inserts after it (`0+` at the
   * top), and `f:N...` addresses function f. The header and `end` are not numbered.
   */
  readonly numbered?: boolean;
  /**
   * Show the function in the dense form (src/dense.ts) and read the replies written under this
   * handle as dense text (src/dense-edit.ts). Revisions, validation and commits are unchanged.
   */
  readonly dense?: boolean;
  /**
   * 'show' (default): the function's spec lines (`ex`, `pre`, `post`, src/spec.ts) are part of the
   * view. 'hide': the view leaves them out (a numbered view always shows them, since the numbers
   * address them); a whole-function replacement sent under such a handle keeps the function's
   * spec lines unless it carries its own.
   */
  readonly specs?: 'show' | 'hide';
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
export function scopedView(fn: TypedFunc, numbered = false, hideSpecs = false): string {
  const text = numbered ? numberedFunction(fn) : formatFunction(hideSpecs ? withoutSpec(fn) : fn);
  const sigs = [...fn.calls.values()].map((c) => `${formatSignature(c)} end`);
  return sigs.length > 0 ? `${text}\n${sigs.join('\n')}` : text;
}

/**
 * A callee's signature in a dense view: a comment line (`# inc u32 -> u32`), so it can never be
 * mistaken for, or copied as, a function header (models that saw `fn inc u32 -> u32 end` wrote it
 * back as a body-less header followed by a second `fn inc ...` line).
 */
function denseSignatureLine(fn: Func): string {
  return `# ${formatDenseSignature(fn).slice(3)}`;
}

/** The dense view of a function: its dense text, then one dense signature per direct callee. */
export function scopedViewDense(
  fn: TypedFunc,
  program: TypedProgram,
  scope: 'function' | 'deps' | 'bodies',
  hideSpecs = false,
): string {
  const shown = (f: TypedFunc): TypedFunc => (hideSpecs ? withoutSpec(f) : f);
  const text = formatDenseFunction(shown(fn), program);
  if (scope === 'function') return text;
  const sigs = [...fn.calls.values()].map((c) =>
    scope === 'bodies' ? formatDenseFunction(shown(c), program) : denseSignatureLine(c),
  );
  return sigs.length > 0 ? `${text}\n${sigs.join('\n')}` : text;
}

/**
 * Spec edits: `+ex ARGS -> RESULT` adds an example, `-ex ARGS -> RESULT` removes the one written
 * so, `+pre EXPR` and `+post EXPR` set the contract line (replacing the one there), `-pre` and
 * `-post` remove it; each optionally prefixed with `f:` (a function name), as the line edits are.
 * Bare `-ex` is the deletion of a node named `ex`, and bare `-pre`/`-post` is a spec removal only
 * when the function has that line (otherwise the deletion of a node of that id).
 */
const SPEC_EDIT = /^(?:([a-z][a-z0-9_]*):)?([+-])(ex|pre|post)(?:\s+(.*))?$/;

/** A spec edit that names its function (`f:+ex ...`): the form a program handle takes. */
function isSpecEdit(t: string, named: boolean): boolean {
  const m = SPEC_EDIT.exec(t);
  if (m === null) return false;
  if (m[1] !== undefined) return true;
  return !named && (m[2] === '+' || (m[4] ?? '').trim() !== '');
}

function specEditOf(m: RegExpExecArray): SpecEdit {
  return { sign: m[2] as '+' | '-', word: m[3] as SpecWord, rest: (m[4] ?? '').trim() };
}

/** `N line`, `N-`, `N+ line`, each optionally prefixed with `f:` (a function name). */
const LINE_EDIT = /^(?:([a-z][a-z0-9_]*):)?(0|[1-9][0-9]*)([+-]?)(?:\s+(.*))?$/;

/**
 * Separate line-addressed edits from the rest of a reply. Only lines outside `fn` blocks are
 * line edits; inside a block (up to `end`, the next `fn`/`-fn` line, or the end of the reply) a
 * leading view number (`1 a add p0 p1`) is the numbered view copied back and is dropped.
 * Unambiguous: instruction ids start with a letter.
 */
function splitLineEdits(
  lines: readonly string[],
  isSpec: (line: string) => boolean,
): { edits: string[]; rest: string[] } {
  const edits: string[] = [];
  const rest: string[] = [];
  let open = false;
  for (const raw of lines) {
    const t = stripComment(raw).trim();
    if (/^-?fn\s/.test(t) || isProfileEdit(t)) {
      open = t.startsWith('fn') && !/\send$/.test(t);
      rest.push(raw);
    } else if (open) {
      if (t === 'end') open = false;
      rest.push(t.replace(/^(0|[1-9][0-9]*)\s+(?=[a-z])/, ''));
    } else if (LINE_EDIT.test(t) || isSpec(t)) edits.push(t);
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
  const specByFn = new Map<string, SpecEdit[]>();
  const expanded: string[] = [];
  for (const raw of lines) {
    const t = stripComment(raw).trim();
    const sm = SPEC_EDIT.exec(t);
    if (sm === null) {
      expanded.push(raw);
      continue;
    }
    const name = sm[1] ?? defaultFn;
    if (name === undefined) throw diag('A0510', [t]);
    if (!program.byName.has(name)) throw diag('A0511', [t, name]);
    specByFn.set(name, [...(specByFn.get(name) ?? []), specEditOf(sm)]);
  }
  for (const raw of expanded) {
    const t = stripComment(raw).trim();
    const m = LINE_EDIT.exec(t);
    if (m === null) throw diag('A0509', [t]);
    const name = m[1] ?? defaultFn;
    if (name === undefined) throw diag('A0510', [t]);
    const fn = program.byName.get(name);
    if (fn === undefined) throw diag('A0511', [t, name]);
    const size = formatFunction(fn).split('\n').length - 2;
    const n = Number(m[2]);
    const mode = m[3] ?? '';
    const text = (m[4] ?? '').trim();
    const entry = byFn.get(name) ?? { at: new Map(), after: new Map() };
    byFn.set(name, entry);
    if (mode === '+') {
      if (n > size || text === '') throw diag('A0512', [t, size]);
      entry.after.set(n, [...(entry.after.get(n) ?? []), text]);
      continue;
    }
    if (n < 1 || n > size) throw diag('A0513', [t, name, size]);
    if (entry.at.has(n)) throw diag('A0514', [t, n]);
    if (mode === '' && text === '') throw diag('A0515', [t, n]);
    entry.at.set(n, mode === '-' ? null : text);
  }
  const block = (name: string): string => {
    const edit = byFn.get(name);
    const fn = program.byName.get(name) as TypedFunc;
    const src = formatFunction(fn).split('\n');
    let text = src.join('\n');
    if (edit !== undefined) {
      const body = src.slice(1, -1);
      const out: string[] = [...(edit.after.get(0) ?? [])];
      body.forEach((line, i) => {
        const edited = edit.at.has(i + 1) ? edit.at.get(i + 1) : line;
        if (edited !== null && edited !== undefined) out.push(edited);
        out.push(...(edit.after.get(i + 1) ?? []));
      });
      text = [src[0] ?? '', ...out, 'end'].join('\n');
    }
    const specEdits = specByFn.get(name);
    if (specEdits === undefined) return text;
    // Spec edits apply to the function the line edits produced, by what the lines say.
    const edited = parse(text).functions[0] as Func;
    return formatFunction(withSpec(edited, applySpecEdits(edited, specEdits)));
  };
  return [...new Set([...byFn.keys(), ...specByFn.keys()])].map(block);
}

/**
 * Deletion-based minimal failing subset: drop items one at a time, keeping each drop after
 * which `fails` still holds, and repeat passes until one pass drops nothing (the result is
 * then 1-minimal: removing any single item makes `fails` false). `fails(items)` is assumed
 * true. At most `budget` calls to `fails`; when the budget runs out first, `minimal` is false
 * and `core` is the smallest failing subset found so far.
 */
export function minimalFailingSubset<T>(
  items: readonly T[],
  fails: (subset: readonly T[]) => boolean,
  budget: number,
): { core: T[]; minimal: boolean; checks: number } {
  let core = [...items];
  let checks = 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < core.length; ) {
      if (checks >= budget) return { core, minimal: false, checks };
      const candidate = [...core.slice(0, i), ...core.slice(i + 1)];
      checks += 1;
      if (fails(candidate)) {
        core = candidate;
        changed = true;
      } else i += 1;
    }
  }
  return { core, minimal: true, checks };
}

/** Default number of validations a rejection diagnosis may run. */
export const DIAGNOSE_BUDGET = 64;

export interface RejectedLine {
  /** 1-based line number in the reply as sent. */
  readonly line: number;
  readonly text: string;
}

/** Why a reply was rejected, narrowed to the lines that cause the failure. */
export interface Rejection {
  readonly error: A0Error;
  /** The smallest set of reply lines found that still fails with the same diagnostic. */
  readonly lines: readonly RejectedLine[];
  /** Candidate lines in the reply (non-blank, not handle lines). */
  readonly of: number;
  /** True when the set is 1-minimal (the budget sufficed). */
  readonly minimal: boolean;
  /** True when the reply without these lines is accepted. */
  readonly restValid: boolean;
  /** Validations run. */
  readonly checks: number;
}

const LINE_PREFIX = /^line [0-9]+: /;

/**
 * Same failure: code, message and fix, ignoring the line prefix (line numbers move as lines
 * drop). The fix names the offending operands, so a second line with the same kind of error
 * does not stand in for the first.
 */
function failureKey(e: A0Error): string {
  return `${e.code} ${e.message.replace(LINE_PREFIX, '')} ${e.fix ?? ''}`;
}

/** A rejection narrowed to its lines, each with the diagnostic's fix, as sent back to a model. */
export function formatRejection(r: Rejection): string {
  const e = r.error;
  const hint = e.fix ?? e.message.replace(LINE_PREFIX, '');
  const head =
    r.lines.length === 1
      ? `This line of ${r.of} causes the rejection`
      : `These ${r.lines.length} of ${r.of} lines are the smallest part of the reply that still fails this way`;
  const rest = r.restValid
    ? 'the rest of the reply is valid on its own; keep it'
    : 'no other line is involved in this error';
  const budget = r.minimal ? '' : ' (check budget reached; the set may not be minimal)';
  const listed = r.lines.map((l) => `line ${l.line}: ${l.text}`).join('\n');
  // A spec failure is not a malformed line: the reply parses and types, and then breaks the
  // example or contract the function carries (src/spec.ts).
  if (e.id === 'A0715' || e.id === 'A0716' || e.id === 'A0719')
    return `${head}; it is well formed but breaks a spec line the function carries, so nothing was applied (${rest}):\n${listed}\nfix: ${hint}`;
  return `${head}; ${rest}${budget}:\n${listed}\nfix: ${hint}`;
}

interface OpenHandle {
  /** Function name, or '*' for a program-level handle. */
  readonly functionName: string;
  readonly revision: string;
  readonly scope: ViewOptions['scope'];
  /** Dense view: the view is dense text and replies under this handle are dense text. */
  readonly dense?: boolean;
  /** Program handles opened with `scope: 'deps'`: the function the view is centred on. */
  readonly target?: string;
  readonly numbered?: boolean;
  /** The view hides spec lines (`specs: 'hide'`). */
  readonly hideSpecs?: boolean;
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
  /** Dense signature lines, and dense replies under this handle. */
  readonly dense?: boolean;
}

/** Program-level view: one signature line per function, in definition order. */
export function programView(program: TypedProgram, dense = false): string {
  return [
    ...profileLine(program),
    ...program.functions.map((f) => (dense ? denseSignatureLine(f) : `${formatSignature(f)} end`)),
  ].join('\n');
}

/** The view's first line for a strict program (nothing for a canonical one: views are unchanged). */
function profileLine(program: { readonly profile?: 'strict' }): string[] {
  return program.profile === 'strict' ? ['profile strict'] : [];
}

/**
 * The functions a dependency-scoped program view lists for `target`: the target, every
 * function it reaches through calls, folds, and loops (transitively), and every function
 * that calls it directly; in definition order.
 */
export function programNeighbourhood(program: TypedProgram, target: string): TypedFunc[] {
  const fn = program.byName.get(target);
  if (fn === undefined) throw diag('A0610', [target]);
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
export function scopedProgramView(program: TypedProgram, target: string, dense = false): string {
  const shown = programNeighbourhood(program, target);
  const head = `# ${program.functions.length} functions; shown: ${target}, its callees, its callers`;
  return [
    head,
    ...profileLine(program),
    ...shown.map((f) => (dense ? denseSignatureLine(f) : `${formatSignature(f)} end`)),
  ].join('\n');
}

/**
 * Apply a program-level edit: `fn … end` blocks replace a function of the same name in
 * place or append a new function at the end (where it may call every existing function);
 * `-fn name` removes a function (with a `fn name` block in the same edit, the pair replaces it
 * in place). The whole program is re-validated; callers of a removed or
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
    if (/^-?fn\s/.test(t) || isProfileEdit(t)) {
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

export function editProgram(
  program: TypedProgram,
  text: string,
  /** A replaced function written without spec lines keeps the ones it had (a view that hid them). */
  keepSpecs = false,
): TypedProgram {
  const lines = closeBlocks(text.split(/\r?\n/));
  const removals = new Set<string>();
  const kept: string[] = [];
  let profile: 'strict' | undefined = program.profile;
  for (const raw of lines) {
    const line = stripComment(raw).trim();
    if (isProfileEdit(line)) {
      profile = line === '-profile' ? undefined : 'strict';
      continue;
    }
    // `-fn name`, optionally followed by the function's current signature as the view shows it.
    const m = /^-fn\s+([a-z][a-z0-9_]*)(?:\s+(.*))?$/.exec(line);
    if (m) {
      const name = m[1] ?? '';
      const shown = program.byName.get(name);
      if (
        m[2] !== undefined &&
        shown !== undefined &&
        `fn ${name} ${m[2]}`.split(/\s+/).join(' ') !== formatSignature(shown)
      )
        throw diag('A0516', [line, formatSignature(shown), name], {
          applicability: 'exact',
          edits: [{ op: 'lines', rule: 'signature', text: normalizeLine(line), to: `-fn ${name}` }],
        });
      removals.add(name);
    } else if (isSignatureEcho(line, program)) continue;
    else kept.push(raw);
  }
  const incoming = orderFunctionsByCalls(parse(kept.join('\n')).functions);
  const byName = new Map(incoming.map((f) => [f.name, f] as const));
  for (const name of removals) {
    if (!program.byName.has(name)) throw diag('A0517', [name]);
    // `-fn f` with a new `fn f` block in the same reply is a replacement, in place.
    if (byName.has(name)) removals.delete(name);
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
    const written = byName.get(f.name);
    if (written !== undefined) functions.push(...(before.get(f.name) ?? []));
    const replacement =
      keepSpecs && written !== undefined && written.spec === undefined && f.spec !== undefined
        ? { ...written, spec: f.spec }
        : written;
    functions.push(replacement ?? f);
  }
  functions.push(...pending);
  if (functions.length === 0) throw diag('A0518');
  return validate({ ...(profile === undefined ? {} : { profile }), functions });
}

export interface SessionOptions {
  readonly maxOpenHandles?: number;
}

/**
 * A bounded, in-memory edit session. Not a network service; no authentication or
 * multi-principal isolation exists in v0.1.
 */
/**
 * A diagnostic for a dense reply that names the dense text, not canonical ids: `sumsq.a` becomes
 * ``sumsq (`fold addel 4 0 A`)`` and `isdiv.ret` becomes `isdiv's result`, using the node texts of the
 * functions the reply defined (the dense text never shows an unnamed node's id).
 */
function denseDiagnostic(
  e: A0Error,
  names: ReadonlyMap<string, ReadonlyMap<string, string>>,
): A0Error {
  if (names.size === 0) return e;
  const swap = (text: string): string =>
    text.replace(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/g, (m, f: string, id: string) => {
      const nodes = names.get(f);
      if (nodes === undefined) return m;
      if (id === 'ret') return `${f}'s result`;
      const t = nodes.get(id);
      return t === undefined ? m : `${f} (\`${t}\`)`;
    });
  const message = swap(e.detail);
  const fix = e.fix === undefined ? undefined : swap(e.fix);
  if (message === e.detail && fix === e.fix) return e;
  return e.reworded(message, e.line, fix);
}

/**
 * A parameter out of range in the function a reply edits, where another function of the program
 * has that parameter: the reply most likely wrote that other function's lines (a callee the view
 * shows only as a signature) as bare lines, which always belong to the function the view opened.
 * Say so, with the block that rewrites the other function.
 */
function stubHint(e: A0Error, program: TypedProgram): A0Error {
  if (e.id !== 'A0105') return e;
  const m = /^([a-z][a-z0-9_]*)\.\S+: parameter p(\d+) out of range/.exec(e.detail);
  if (m === null) return e;
  const others = program.functions.filter((f) => f.name !== m[1] && f.params.length > Number(m[2]));
  if (others.length === 0) return e;
  const blocks = others.map((f) => `\`${formatSignature(f)}\``).join(' or ');
  const hint = `; bare lines edit ${m[1]} only: to write the lines of another function, reply a block ${blocks} followed by its lines`;
  return e.reworded(e.detail, e.line, `${e.fix ?? ''}${hint}`);
}

export class EditSession {
  #program: TypedProgram;
  readonly #handles = new Map<string, OpenHandle>();
  readonly #maxOpen: number;
  #nextFn = 0;
  #nextProgram = 0;
  /** The last reply this session rejected, for `fix all`. */
  #rejected: string | undefined;

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
   * The handle a reply without a handle line edited: the one open function handle, or with none the
   * one open program handle (the rule `#apply` follows); undefined when there is no single one.
   */
  get impliedHandle(): string | undefined {
    const open = [...this.#handles.keys()];
    const fnHandles = open.filter((h) => HANDLE.test(h));
    const implied = fnHandles.length > 0 ? fnHandles : open;
    return implied.length === 1 ? implied[0] : undefined;
  }

  /**
   * Open a program-level view bound to the whole program's revision: all signatures, or
   * with `scope: 'deps'` only those around `target` (the handle still edits any function).
   */
  openProgram(options: ProgramViewOptions = {}): View {
    const target = options.scope === 'deps' ? options.target : undefined;
    if (options.scope === 'deps' && (target === undefined || !this.#program.byName.has(target)))
      throw diag('A0610', [target ?? ''], {
        fix: "openProgram({ scope: 'deps', target }) needs the name of an existing function",
      });
    if (this.#handles.size >= this.#maxOpen) {
      throw diag('A0520', [this.#maxOpen]);
    }
    const handle = `g${this.#nextProgram}`;
    this.#nextProgram += 1;
    const rev = programRevision(this.#program);
    const dense = options.dense === true;
    this.#handles.set(handle, {
      functionName: '*',
      revision: rev,
      scope: undefined,
      ...(target === undefined ? {} : { target }),
      ...(dense ? { dense } : {}),
    });
    return {
      handle,
      functionName: '*',
      revision: rev,
      text: `${handle}\n${this.#programText(target, dense)}`,
    };
  }

  /** A scoped program view whose target was removed falls back to the full listing. */
  #programText(target: string | undefined, dense = false): string {
    return target !== undefined && this.#program.byName.has(target)
      ? scopedProgramView(this.#program, target, dense)
      : programView(this.#program, dense);
  }

  /** Open a view of one function and return a short handle bound to its current revision. */
  open(functionName: string, options: ViewOptions = {}): View {
    const fn = this.#program.byName.get(functionName);
    if (fn === undefined) throw diag('A0610', [functionName]);
    if (this.#handles.size >= this.#maxOpen) {
      throw diag('A0520', [this.#maxOpen]);
    }
    const handle = `e${this.#nextFn}`;
    this.#nextFn += 1;
    const rev = revision(fn);
    const numbered = options.numbered === true;
    const dense = options.dense === true;
    const hideSpecs = options.specs === 'hide' && !numbered && fn.spec !== undefined;
    this.#handles.set(handle, {
      functionName,
      revision: rev,
      scope: options.scope,
      ...(numbered ? { numbered } : {}),
      ...(dense ? { dense } : {}),
      ...(options.specs === 'hide' && !numbered ? { hideSpecs: true } : {}),
    });
    const body = this.#functionText(fn, options.scope, numbered, dense, hideSpecs);
    return { handle, functionName, revision: rev, text: `${handle}\n${body}` };
  }

  /** The current view under an open handle (handles are stable for the session). */
  view(handle: string): string {
    const bound = this.#handles.get(handle);
    if (bound === undefined) throw diag('A0611', [handle], { line: 1 });
    if (bound.functionName === '*')
      return `${handle}\n${this.#programText(bound.target, bound.dense === true)}`;
    const fn = this.#program.byName.get(bound.functionName);
    if (fn === undefined) throw diag('A0613', [handle], { line: 1 });
    return `${handle}\n${this.#functionText(fn, bound.scope, bound.numbered === true, bound.dense === true, bound.hideSpecs === true)}`;
  }

  #functionText(
    fn: TypedFunc,
    scope: ViewOptions['scope'],
    numbered: boolean,
    dense = false,
    hideSpecs = false,
  ): string {
    const text = this.#plainFunctionText(fn, scope, numbered, dense, hideSpecs);
    const shown = dense && scope === 'bodies' ? [fn, ...fn.calls.values()] : [fn];
    const legend = process.env.A0_KEY_LEGEND === 'off' ? '' : keyLegend(shown);
    return legend === '' ? text : `${text}\n${legend}`;
  }

  #plainFunctionText(
    fn: TypedFunc,
    scope: ViewOptions['scope'],
    numbered: boolean,
    dense: boolean,
    hideSpecs: boolean,
  ): string {
    if (dense) return scopedViewDense(fn, this.#program, scope ?? 'function', hideSpecs);
    if (scope === 'deps' || scope === 'bodies') return scopedView(fn, numbered, hideSpecs);
    return numbered ? numberedFunction(fn) : formatFunction(hideSpecs ? withoutSpec(fn) : fn);
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

  /**
   * Validate `text` exactly as `apply` would, without committing: the rejection, or
   * undefined when the reply would be accepted.
   */
  #attempt(text: string): A0Error | undefined {
    const savedProgram = this.#program;
    const savedHandles = new Map(this.#handles);
    try {
      this.apply(text);
      return undefined;
    } catch (e) {
      if (e instanceof A0Error) return e;
      throw e;
    } finally {
      this.#program = savedProgram;
      this.#handles.clear();
      for (const [h, b] of savedHandles) this.#handles.set(h, b);
    }
  }

  /**
   * Explain a rejected reply: the minimal subset of its lines (handle lines stay as context)
   * that still fails with the same diagnostic, found by deletion within `budget` validations.
   * Nothing is committed. Undefined when the reply would be accepted.
   */
  diagnose(text: string, budget = DIAGNOSE_BUDGET): Rejection | undefined {
    const error = this.#attempt(text);
    if (error === undefined) return undefined;
    const lines = text.split(/\r?\n/);
    const items = lines
      .map((l, i) => [stripComment(l).trim(), i] as const)
      .filter(([t]) => t !== '' && !HANDLE.test(t) && !PROGRAM_HANDLE.test(t))
      .map(([, i]) => i);
    const itemSet = new Set(items);
    const keep = (subset: readonly number[]): string => {
      const chosen = new Set(subset);
      return lines.filter((_, i) => !itemSet.has(i) || chosen.has(i)).join('\n');
    };
    const key = failureKey(error);
    const { core, minimal, checks } = minimalFailingSubset(
      items,
      (subset) => {
        const e = this.#attempt(keep(subset));
        return e !== undefined && failureKey(e) === key;
      },
      budget,
    );
    const inCore = new Set(core);
    const rest = items.filter((i) => !inCore.has(i));
    // Only a rest that still carries an edit (not just a closing `end`) counts as valid work.
    const carries = rest.some((i) => stripComment(lines[i] ?? '').trim() !== 'end');
    const restValid = carries && this.#attempt(keep(rest)) === undefined;
    return {
      error,
      lines: core.map((i) => ({ line: i + 1, text: (lines[i] ?? '').trim() })),
      of: items.length,
      minimal,
      restValid,
      checks: checks + (carries ? 2 : 1),
    };
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
    this.#denseNames = new Map();
    try {
      return this.#applyOrFix(text);
    } catch (e) {
      throw e instanceof A0Error
        ? denseDiagnostic(stubHint(e, this.#program), this.#denseNames)
        : e;
    }
  }

  /** Dense text of the nodes of the functions the current dense reply names (see `denseDiagnostic`). */
  #denseNames: Map<string, Map<string, string>> = new Map();

  #applyOrFix(text: string): TypedProgram {
    if (this.#isFixAll(text)) return this.#fixAll();
    try {
      const next = this.#apply(text);
      this.#rejected = undefined;
      return next;
    } catch (e) {
      if (e instanceof A0Error) this.#rejected = text;
      throw e;
    }
  }

  /** `fix all`, alone or under a handle line. */
  #isFixAll(text: string): boolean {
    const lines = text
      .split(/\r?\n/)
      .map((l) => stripComment(l).trim())
      .filter((l) => l.length > 0);
    if (lines.length === 2 && (HANDLE.test(lines[0] ?? '') || PROGRAM_HANDLE.test(lines[0] ?? '')))
      lines.shift();
    return lines.length === 1 && lines[0] === 'fix all';
  }

  /**
   * `fix all`: replay the last rejected reply with every `exact` fix of its diagnostics applied.
   * The edited reply goes through the ordinary path, so it is parsed and the whole program
   * validated before anything is committed; if a diagnostic with no exact fix remains, nothing is
   * committed and that diagnostic is the reply's rejection.
   */
  #fixAll(): TypedProgram {
    const rejected = this.#rejected;
    if (rejected === undefined) throw diag('A0521');
    const out = fixAll(rejected, (t) => {
      this.#apply(t);
    });
    if (out.error !== undefined) {
      this.#rejected = out.text;
      throw out.error;
    }
    this.#rejected = undefined;
    return this.#program;
  }

  #apply(text: string): TypedProgram {
    if (utf8Length(text) > LIMITS.maxSourceBytes) throw diag('A0502');
    const rawLines = text.split(/\r?\n/);
    // The handle line may be left out when it is implied: the reply then edits the one open
    // function handle (which also takes whole `fn` blocks and `-fn` lines), or, with no
    // function handle open, the one open program handle.
    const firstLine = rawLines.map((l) => stripComment(l).trim()).find((l) => l.length > 0) ?? '';
    if (!HANDLE.test(firstLine) && !PROGRAM_HANDLE.test(firstLine)) {
      const open = [...this.#handles.keys()];
      const fnHandles = open.filter((h) => HANDLE.test(h));
      const implied = fnHandles.length > 0 ? fnHandles : open;
      if (implied.length !== 1) throw diag('A0612', [firstLine], { line: 1 });
      return this.#apply(`${implied[0] as string}\n${text}`);
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
          this.#apply(section.join('\n'));
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
      throw diag('A0612', [handle], { line: 1 });
    }
    const bound = this.#handles.get(handle);
    if (bound === undefined) throw diag('A0611', [handle], { line: 1 });
    if (bound.functionName === '*') {
      if (programRevision(this.#program) !== bound.revision) {
        throw diag('A0614', [handle]);
      }
      let rawBody = text
        .split(/\r?\n/)
        .slice(text.split(/\r?\n/).findIndex((l) => stripComment(l).trim() === handle) + 1);
      if (bound.dense === true)
        rawBody = denseEditBody(
          rawBody.map((l) => stripComment(l).trim()).filter((l) => l.length > 0),
          this.#program,
          undefined,
          this.#denseNames,
        );
      const { edits, rest } = splitLineEdits(rawBody, (t) => isSpecEdit(t, false));
      const blocks = lineEditBlocks(this.#program, edits, undefined);
      this.#program = editProgram(this.#program, [...closeBlocks(rest), ...blocks].join('\n'));
      this.#rebind();
      return this.#program;
    }
    const fn = this.#program.byName.get(bound.functionName);
    if (fn === undefined) throw diag('A0613', [handle]);
    if (revision(fn) !== bound.revision) {
      throw diag('A0615', [handle, fn.name]);
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
    while (body.length > 0 && stripComment(body[body.length - 1] ?? '').trim() === 'end')
      body = body.slice(0, -1);
    while (body.length > 0 && stripComment(body[body.length - 1] ?? '').trim() === '')
      body = body.slice(0, -1);
    if (bound.dense === true) body = denseEditBody(body, this.#program, fn, this.#denseNames);
    // Whole `fn ... end` blocks are program-level edits wherever they appear: the handled
    // function sent back whole replaces itself, and any other function is added or replaced
    // exactly as under a program handle. Edit lines before the first block apply to the
    // handled function after the blocks, so a callee changed in the same reply type-checks.
    // `-fn name` lines before the first block are program-level too, and so are edit lines
    // after a block's explicit `end` (outside every block they can only edit the handled
    // function; a block without `end` still takes the lines up to the next `fn`).
    // Line-addressed edits (`N line`, `N-`, `N+ line`, `f:N ...`) refer to the numbered view
    // before this reply; each edited function becomes a whole block, validated with the rest.
    // Spec edits of the handled function (`+ex ...`, `-pre`) go with its node edits, validated as
    // one change; only a line that names another function (`g:+ex ...`) is a block of its own.
    const split = splitLineEdits(body, (t) => isSpecEdit(t, true));
    const lineBlocks = lineEditBlocks(this.#program, split.edits, fn.name);
    body = split.rest;
    const blockAt = body.findIndex((l) => /^fn\s/.test(stripComment(l).trim()));
    const head = blockAt < 0 ? body : body.slice(0, blockAt);
    const isRemoval = (l: string): boolean => {
      const t = stripComment(l).trim();
      return /^-fn\s/.test(t) || isProfileEdit(t);
    };
    // An `end` before the first block closes the handled function's lines, as in the view.
    const editLines = head.filter((l) => !isRemoval(l) && stripComment(l).trim() !== 'end');
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
      program = editProgram(
        program,
        [...closeBlocks(programLines), ...lineBlocks].join('\n'),
        bound.hideSpecs === true,
      );
    }
    if (editLines.length > 0) {
      const target = program.byName.get(fn.name);
      if (target === undefined) throw diag('A0519', [handle, fn.name]);
      const nodes = parseReplacementNodes(editLines, 2, new Set(target.nodes.map((n) => n.id)));
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
