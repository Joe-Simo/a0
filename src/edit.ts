/**
 * Content revisions, atomic node replacement, and bounded edit sessions.
 *
 * Two edit paths:
 *  1. Self-contained patch: `patch <fn> <sha256>` + replacement nodes + `end`.
 *  2. Session-bound edit: a session retains the revision and hands out a short
 *     handle (`e0`); the edit text is the handle line followed by replacement nodes.
 *
 * Both paths replace existing nodes only. The full replacement set is validated
 * against the whole function before anything is committed. Successful handles are
 * consumed; unknown, consumed, or mismatched handles are rejected.
 *
 * A handle is a reference, not an authorization credential.
 */

import { createHash } from 'node:crypto';
import {
  A0Error,
  type Func,
  formatFunction,
  formatOperand,
  formatProgram,
  formatType,
  isValidIdentifier,
  LIMITS,
  type Node,
  type Operand,
  type Program,
  parseNode,
  parseOperand,
  stripComment,
  type TypedFunc,
  type TypedProgram,
  validate,
  validateFunction,
} from './core.js';

export const REVISION_LENGTH = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HANDLE = /^e(0|[1-9][0-9]*)$/;

/** Content revision of a function: SHA-256 of its canonical source form. */
export function revision(fn: Func): string {
  return createHash('sha256').update(formatFunction(fn), 'utf8').digest('hex');
}

/** Content revision of a whole program. */
export function programRevision(program: Program): string {
  return createHash('sha256').update(formatProgram(program), 'utf8').digest('hex');
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
  | { readonly kind: 'node'; readonly node: Node; readonly after?: string }
  | { readonly kind: 'delete'; readonly id: string }
  | { readonly kind: 'ret'; readonly operand: Operand };

export function parseEditOps(lines: readonly string[], firstLine: number): EditOp[] {
  if (lines.length === 0) throw new A0Error('edit contains no lines');
  if (lines.length > LIMITS.maxNodesPerFunction) throw new A0Error('edit too large');
  const seen = new Set<string>();
  const ops: EditOp[] = [];
  let sawRet = false;
  lines.forEach((text, i) => {
    const line = firstLine + i;
    const claim = (id: string): void => {
      if (seen.has(id)) throw new A0Error(`duplicate edit for '${id}'`, line);
      seen.add(id);
    };
    if (text.startsWith('-')) {
      const id = text.slice(1).trim();
      if (!isValidIdentifier(id)) throw new A0Error(`invalid delete target '${id}'`, line);
      claim(id);
      ops.push({ kind: 'delete', id });
      return;
    }
    if (/^ret\s/.test(text)) {
      if (sawRet) throw new A0Error('duplicate ret in edit', line);
      sawRet = true;
      const parts = text.split(/\s+/);
      if (parts.length !== 2) throw new A0Error('ret expects one operand', line);
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
export function replaceNodes(
  program: TypedProgram,
  fn: TypedFunc,
  ops: readonly (EditOp | Node)[],
): TypedFunc {
  const edits: EditOp[] = ops.map((o) => ('kind' in o ? o : { kind: 'node', node: o }));
  let nodes: Node[] = [...fn.nodes];
  let ret = fn.ret;
  // 1. deletions
  for (const op of edits) {
    if (op.kind !== 'delete') continue;
    const before = nodes.length;
    nodes = nodes.filter((n) => n.id !== op.id);
    if (nodes.length === before)
      throw new A0Error(`${fn.name}: cannot delete unknown node '${op.id}'`);
  }
  // 2. replacements and insertions
  for (const op of edits) {
    if (op.kind !== 'node') continue;
    const at = nodes.findIndex((n) => n.id === op.node.id);
    if (op.after !== undefined) {
      if (at >= 0) nodes.splice(at, 1);
      const anchor = nodes.findIndex((n) => n.id === op.after);
      if (anchor < 0)
        throw new A0Error(`${fn.name}: cannot insert after unknown node '${op.after}'`);
      nodes.splice(anchor + 1, 0, op.node);
    } else if (at >= 0) {
      nodes[at] = op.node;
    } else {
      nodes.push(op.node);
    }
  }
  // 3. result
  for (const op of edits) if (op.kind === 'ret') ret = op.operand;
  if (nodes.length > LIMITS.maxNodesPerFunction) throw new A0Error(`${fn.name}: too many nodes`);
  const replaced: Func = { ...fn, nodes, ret };
  // Legal call targets are exactly the functions defined before this one.
  const scope = new Map<string, TypedFunc>();
  for (const f of program.functions) {
    if (f.name === fn.name) break;
    scope.set(f.name, f);
  }
  return validateFunction(replaced, scope);
}

/**
 * Semantic revision: the function's own content revision folded with the semantic
 * revisions of every callee, transitively. Any change in a dependency changes it,
 * so it is the correct cache key for derived artifacts (unlike `revision`, which
 * is the editing identity of one function's text).
 */
export function semanticRevision(fn: TypedFunc): string {
  const h = createHash('sha256').update(revision(fn), 'utf8');
  for (const name of [...fn.calls.keys()].sort()) {
    const callee = fn.calls.get(name);
    if (callee !== undefined) h.update(`|${name}=${semanticRevision(callee)}`, 'utf8');
  }
  return h.digest('hex');
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
  if (Buffer.byteLength(text, 'utf8') > LIMITS.maxSourceBytes) throw new A0Error('patch too large');
  const lines = text
    .split(/\r?\n/)
    .map((l) => stripComment(l).trim())
    .filter((l) => l.length > 0);
  const head = lines[0]?.split(/\s+/) ?? [];
  if (head[0] !== 'patch' || head.length !== 3) {
    throw new A0Error("expected 'patch <function> <revision>'", 1);
  }
  const functionName = head[1] ?? '';
  const rev = head[2] ?? '';
  if (!SHA256_HEX.test(rev)) throw new A0Error('revision must be 64 lowercase hex characters', 1);
  if (lines[lines.length - 1] !== 'end') throw new A0Error("patch must end with 'end'");
  const nodes = parseReplacementNodes(lines.slice(1, -1), 2);
  return { functionName, revision: rev, nodes };
}

export function applyPatch(program: TypedProgram, patch: Patch): TypedProgram {
  const fn = program.byName.get(patch.functionName);
  if (fn === undefined) throw new A0Error(`unknown function '${patch.functionName}'`);
  const current = revision(fn);
  if (current !== patch.revision) {
    throw new A0Error(
      `revision mismatch for '${fn.name}': patch targets ${patch.revision.slice(0, 12)}…, current is ${current.slice(0, 12)}…`,
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
}

export function formatSignature(fn: Func): string {
  const sig = fn.params.length > 0 ? ` ${fn.params.map(formatType).join(' ')}` : '';
  return `fn ${fn.name}${sig} -> ${formatType(fn.result)}`;
}

/** The dependency-scoped view text of a function (without a handle line). */
export function scopedView(fn: TypedFunc): string {
  const sigs = [...fn.calls.values()].map((c) => `${formatSignature(c)} end`);
  return sigs.length > 0 ? `${formatFunction(fn)}\n${sigs.join('\n')}` : formatFunction(fn);
}

interface OpenHandle {
  readonly functionName: string;
  readonly revision: string;
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
  #next = 0;

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

  /** Open a view of one function and return a short handle bound to its current revision. */
  open(functionName: string, options: ViewOptions = {}): View {
    const fn = this.#program.byName.get(functionName);
    if (fn === undefined) throw new A0Error(`unknown function '${functionName}'`);
    if (this.#handles.size >= this.#maxOpen) {
      throw new A0Error(`session handle limit (${this.#maxOpen}) reached; close handles first`);
    }
    const handle = `e${this.#next}`;
    this.#next += 1;
    const rev = revision(fn);
    this.#handles.set(handle, { functionName, revision: rev });
    const body = options.scope === 'deps' ? scopedView(fn) : formatFunction(fn);
    return { handle, functionName, revision: rev, text: `${handle}\n${body}` };
  }

  close(handle: string): boolean {
    return this.#handles.delete(handle);
  }

  /**
   * Apply a session edit: first line is the handle, remaining lines are replacement
   * nodes. The handle must be open and bound to the function's current revision.
   * On success the handle is consumed and the new program is committed atomically.
   */
  apply(text: string): TypedProgram {
    if (Buffer.byteLength(text, 'utf8') > LIMITS.maxSourceBytes)
      throw new A0Error('edit too large');
    const lines = text
      .split(/\r?\n/)
      .map((l) => stripComment(l).trim())
      .filter((l) => l.length > 0);
    const handle = lines[0] ?? '';
    if (!HANDLE.test(handle)) throw new A0Error(`invalid handle '${handle}'`, 1);
    const bound = this.#handles.get(handle);
    if (bound === undefined) throw new A0Error(`unknown or consumed handle '${handle}'`, 1);
    const fn = this.#program.byName.get(bound.functionName);
    if (fn === undefined) throw new A0Error(`handle '${handle}' refers to a removed function`);
    if (revision(fn) !== bound.revision) {
      throw new A0Error(
        `handle '${handle}' is stale: '${fn.name}' changed since the view was opened`,
      );
    }
    const nodes = parseReplacementNodes(lines.slice(1), 2);
    const updated = replaceNodes(this.#program, fn, nodes);
    // Validation succeeded: commit and consume the handle atomically.
    this.#program = commit(this.#program, updated);
    this.#handles.delete(handle);
    return this.#program;
  }
}
