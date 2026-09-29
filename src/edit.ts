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
  LIMITS,
  type Node,
  type Program,
  parseNode,
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

function parseReplacementNodes(lines: readonly string[], firstLine: number): Node[] {
  if (lines.length === 0) throw new A0Error('edit contains no replacement nodes');
  if (lines.length > LIMITS.maxNodesPerFunction) throw new A0Error('edit too large');
  const seen = new Set<string>();
  const nodes: Node[] = [];
  lines.forEach((text, i) => {
    const node = parseNode(text, firstLine + i);
    if (seen.has(node.id))
      throw new A0Error(`duplicate replacement for '${node.id}'`, firstLine + i);
    seen.add(node.id);
    nodes.push(node);
  });
  return nodes;
}

/**
 * Apply node replacements to one function. Each replacement must name an existing
 * node; the node keeps its position, so dependency order is preserved and forward
 * references remain impossible. The whole result is re-validated before returning.
 */
export function replaceNodes(
  program: TypedProgram,
  fn: TypedFunc,
  nodes: readonly Node[],
): TypedFunc {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const existing = new Set(fn.nodes.map((n) => n.id));
  for (const id of byId.keys()) {
    if (!existing.has(id)) {
      throw new A0Error(
        `${fn.name}: cannot replace unknown node '${id}' (insertion is unsupported)`,
      );
    }
  }
  const replaced: Func = {
    ...fn,
    nodes: fn.nodes.map((n) => byId.get(n.id) ?? n),
  };
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
  readonly nodes: readonly Node[];
}

export function formatPatch(fn: Func, nodes: readonly Node[]): string {
  const body = nodes.map((n) => `${n.id} ${n.op} ${n.args.map(formatOperand).join(' ')}`);
  return `patch ${fn.name} ${revision(fn)}\n${body.join('\n')}\nend`;
}

export function parsePatch(text: string): Patch {
  if (Buffer.byteLength(text, 'utf8') > LIMITS.maxSourceBytes) throw new A0Error('patch too large');
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
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
  /** Text shown to the model: handle line followed by the function source. */
  readonly text: string;
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
  open(functionName: string): View {
    const fn = this.#program.byName.get(functionName);
    if (fn === undefined) throw new A0Error(`unknown function '${functionName}'`);
    if (this.#handles.size >= this.#maxOpen) {
      throw new A0Error(`session handle limit (${this.#maxOpen}) reached; close handles first`);
    }
    const handle = `e${this.#next}`;
    this.#next += 1;
    const rev = revision(fn);
    this.#handles.set(handle, { functionName, revision: rev });
    return { handle, functionName, revision: rev, text: `${handle}\n${formatFunction(fn)}` };
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
      .map((l) => l.replace(/#.*$/, '').trim())
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
