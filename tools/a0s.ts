/**
 * A0S: a small expression language that compiles to A0, one node a line. compiler/optimize.a0
 * is generated from compiler/optimize.a0s with it (`bun tools/a0s.ts compiler/optimize.a0s
 * compiler/optimize.a0`; `--check` as a third argument compares instead of writing). A0 has no
 * control flow, so the optimizer's steps are long chains of table reads, selects and writes, and
 * a table passed to a call is copied by the C emitter: reads and writes must be written out
 * inline. A0S writes them as expressions and expands them.
 *
 *   const NAME = EXPR                     compile-time u32 constant
 *   extern f(T, U) -> R                   a function defined elsewhere
 *   fn f(a: T, b: U) -> R ... end         a function (parameters p0.. in the output)
 *   def m(a: T) -> R ... end              a macro, expanded inline at each call
 *   raw TEXT                              TEXT unchanged in the output
 * Statements (one a line): `let x = E` / `x = E` (a new SSA name: values are immutable),
 * `let (a, b) = E` (the fields of a record; a macro's `return (a, b)` is not built), `T[i] = E`
 * (a table write: `T` is renamed), `T[i] = E if C` (written when C), `return E`.
 * Expressions: u32 and bool literals, `+ - * / % & | ^ << >> == != < <= > >=` (u32 wrapping;
 * `&&` and `||` are `&` and `|`), `!x`, `c ? a : b` (select: both sides are computed),
 * `T[i]` (read: a table `u32x128xN` is paged, element i at page i>>7 word i&127; a flat
 * `u32xN` is a `get`), `x#k` (field k of a record), `f(args)`, `(a, b)` (record), and the
 * builtins fold(f, n, init, extras...), loop(p, f, n, init, extras...), arr, rec, at, get,
 * set, put, mov, read, write, bit(c) (c ? 1 : 0), zeros(N) (a zero `u32x128xN`), zlist()
 * (a zero `u32x64`). Literal arithmetic is folded; names are lower-cased into A0 ids.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Ast =
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'id'; n: string }
  | { k: 'bin'; op: string; a: Ast; b: Ast }
  | { k: 'not'; a: Ast }
  | { k: 'tern'; c: Ast; a: Ast; b: Ast }
  | { k: 'idx'; a: Ast; i: Ast }
  | { k: 'fld'; a: Ast; n: number }
  | { k: 'call'; f: string; args: Ast[] }
  | { k: 'tup'; items: Ast[] };

const U = (x: number): number => x >>> 0;

function tokenize(s: string): string[] {
  const toks: string[] = [];
  const re =
    /\s*(0x[0-9a-fA-F]+|\d+|[A-Za-z_][A-Za-z0-9_]*|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^<>!?:()[\],#=])/y;
  let i = 0;
  while (i < s.length) {
    if (/^\s*$/.test(s.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw new Error(`bad token in: ${s.slice(i)}`);
    toks.push(m[1] as string);
    i = re.lastIndex;
  }
  return toks;
}

class Parser {
  i = 0;
  constructor(public t: string[]) {}
  peek(): string | undefined {
    return this.t[this.i];
  }
  next(): string {
    return this.t[this.i++] as string;
  }
  eat(x: string): boolean {
    if (this.t[this.i] === x) {
      this.i++;
      return true;
    }
    return false;
  }
  expect(x: string): void {
    if (!this.eat(x)) throw new Error(`expected ${x} got ${this.peek()} in ${this.t.join(' ')}`);
  }
  expr(): Ast {
    const c = this.bin(0);
    if (this.eat('?')) {
      const a = this.expr();
      this.expect(':');
      const b = this.expr();
      return { k: 'tern', c, a, b };
    }
    return c;
  }
  static LEVELS: string[][] = [
    ['||'],
    ['&&'],
    ['|'],
    ['^'],
    ['&'],
    ['==', '!='],
    ['<', '<=', '>', '>='],
    ['<<', '>>'],
    ['+', '-'],
    ['*', '/', '%'],
  ];
  bin(l: number): Ast {
    if (l >= Parser.LEVELS.length) return this.unary();
    let a = this.bin(l + 1);
    for (;;) {
      const p = this.peek();
      if (p !== undefined && (Parser.LEVELS[l] as string[]).includes(p)) {
        this.next();
        const b = this.bin(l + 1);
        a = { k: 'bin', op: p === '&&' ? '&' : p === '||' ? '|' : p, a, b };
      } else return a;
    }
  }
  unary(): Ast {
    if (this.eat('!')) return { k: 'not', a: this.unary() };
    return this.postfix();
  }
  postfix(): Ast {
    let a = this.primary();
    for (;;) {
      if (this.eat('[')) {
        const i = this.expr();
        this.expect(']');
        a = { k: 'idx', a, i };
      } else if (this.eat('#')) {
        a = { k: 'fld', a, n: Number(this.next()) };
      } else return a;
    }
  }
  primary(): Ast {
    const t = this.next();
    if (t === '(') {
      const items: Ast[] = [this.expr()];
      let tup = false;
      while (this.eat(',')) {
        tup = true;
        items.push(this.expr());
      }
      this.expect(')');
      return tup ? { k: 'tup', items } : (items[0] as Ast);
    }
    if (/^(0x[0-9a-fA-F]+|\d+)$/.test(t)) return { k: 'num', v: U(Number(t)) };
    if (t === 'true' || t === 'false') return { k: 'bool', v: t === 'true' };
    if (/^[A-Za-z_]/.test(t)) {
      if (this.eat('(')) {
        const args: Ast[] = [];
        if (!this.eat(')')) {
          do args.push(this.expr());
          while (this.eat(','));
          this.expect(')');
        }
        return { k: 'call', f: t, args };
      }
      return { k: 'id', n: t };
    }
    throw new Error(`unexpected ${t}`);
  }
}

const parseExpr = (s: string): Ast => {
  const p = new Parser(tokenize(s));
  const e = p.expr();
  if (p.peek() !== undefined) throw new Error(`trailing ${p.peek()} in ${s}`);
  return e;
};

// ---- types
function splitTop(s: string): string[] {
  const out: string[] = [];
  let d = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') d++;
    if (ch === ')') d--;
    if (ch === ',' && d === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}
const isTuple = (t: string): boolean => t.startsWith('(');
const tupleParts = (t: string): string[] => splitTop(t.slice(1, -1));
function elemType(t: string): string {
  const i = t.lastIndexOf('x');
  if (i < 0) throw new Error(`not an array type: ${t}`);
  return t.slice(0, i);
}
function dims(t: string): number[] {
  return t.split('x').slice(1).map(Number);
}

interface Val {
  o: string;
  t: string;
  c?: number | boolean;
  parts?: Val[];
}
interface Sig {
  params: string[];
  ret: string;
}
interface Def {
  params: [string, string][];
  ret: string;
  body: string[];
}

const consts = new Map<string, number>();
const sigs = new Map<string, Sig>();
const defs = new Map<string, Def>();

class Scope {
  vars = new Map<string, Val>();
  constructor(public prefix: string) {}
}

class FnGen {
  lines: string[] = [];
  n = 0;
  used = new Set<string>();
  macroN = 0;
  zp: string | undefined;
  result: Val | undefined;
  constructor(public name: string) {}
  fresh(hint: string | undefined, prefix: string): string {
    if (hint !== undefined) {
      let h = `${prefix}${hint}`.toLowerCase();
      let k = 1;
      while (this.used.has(h)) h = `${prefix}${hint}_${k++}`.toLowerCase();
      this.used.add(h);
      return h;
    }
    let h: string;
    do h = `q${this.n++}`;
    while (this.used.has(h));
    this.used.add(h);
    return h;
  }
  emit(id: string, rest: string): string {
    this.lines.push(`${id} ${rest}`);
    return id;
  }
}

const OPS: Record<string, string> = {
  '+': 'add',
  '-': 'sub',
  '*': 'mul',
  '/': 'div',
  '%': 'rem',
  '&': 'and',
  '|': 'or',
  '^': 'xor',
  '<<': 'shl',
  '>>': 'shr',
  '==': 'eq',
  '!=': 'ne',
  '<': 'lt',
  '<=': 'le',
  '>': 'gt',
  '>=': 'ge',
};
const CMP = new Set(['==', '!=', '<', '<=', '>', '>=']);

function foldBin(
  op: string,
  a: number | boolean,
  b: number | boolean,
): number | boolean | undefined {
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    switch (op) {
      case '&':
        return a && b;
      case '|':
        return a || b;
      case '^':
        return a !== b;
      case '==':
        return a === b;
      case '!=':
        return a !== b;
    }
    return undefined;
  }
  if (typeof a !== 'number' || typeof b !== 'number') return undefined;
  switch (op) {
    case '+':
      return U(a + b);
    case '-':
      return U(a - b);
    case '*':
      return U(Math.imul(a, b));
    case '/':
      return b === 0 ? 0xffffffff : U(Math.floor(a / b));
    case '%':
      return b === 0 ? a : a % b;
    case '&':
      return U(a & b);
    case '|':
      return U(a | b);
    case '^':
      return U(a ^ b);
    case '<<':
      return U(a << (b & 31));
    case '>>':
      return U(a >>> (b & 31));
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
  }
  return undefined;
}

const lit = (v: number | boolean): Val =>
  typeof v === 'boolean' ? { o: String(v), t: 'bool', c: v } : { o: String(v), t: 'u32', c: v };

const STMT_RETURN = /^return\s+(.*)$/;
const STMT_TUPLE = /^let\s+\(([^)]*)\)\s*=\s*(.*)$/;
const STMT_WRITE =
  /^(?:let\s+)?([A-Za-z_][A-Za-z0-9_]*)\[(.+?)\]\s*=(?!=)\s*(.*?)(?:\s+if\s+(.+))?$/;
const STMT_LET = /^(?:let\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function compileBlock(g: FnGen, sc: Scope, body: string[]): void {
  for (const raw of body) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const ret = STMT_RETURN.exec(line);
    const tuple = STMT_TUPLE.exec(line);
    const write = STMT_WRITE.exec(line);
    const assign = STMT_LET.exec(line);
    if (ret) {
      g.result = exr(g, sc, parseExpr(ret[1] as string), undefined);
    } else if (tuple) {
      const v = exr(g, sc, parseExpr(tuple[2] as string), undefined);
      const names = (tuple[1] as string).split(',').map((s) => s.trim());
      const parts = tupleParts(v.t);
      for (const [k, nm] of names.entries()) {
        if (nm === '_') continue;
        if (v.parts !== undefined) {
          sc.vars.set(nm, v.parts[k] as Val);
          continue;
        }
        const id = g.fresh(nm, sc.prefix);
        g.emit(id, `at ${v.o} ${k}`);
        sc.vars.set(nm, { o: id, t: parts[k] as string });
      }
    } else if (write) {
      writeIdx(g, sc, write[1] as string, write[2] as string, write[3] as string, write[4]);
    } else if (assign) {
      const nm = assign[1] as string;
      sc.vars.set(nm, exr(g, sc, parseExpr(assign[2] as string), nm));
    } else throw new Error(`cannot parse statement: ${line}`);
  }
}

function writeIdx(
  g: FnGen,
  sc: Scope,
  tn: string,
  idx: string,
  val: string,
  cond: string | undefined,
): void {
  const T = sc.vars.get(tn);
  if (T === undefined) throw new Error(`unknown table ${tn}`);
  const i = ex(g, sc, parseExpr(idx), undefined);
  let v = ex(g, sc, parseExpr(val), undefined);
  const paged = isPaged(T.t);
  if (cond !== undefined) {
    const c = ex(g, sc, parseExpr(cond), undefined);
    const old = readIdx(g, sc, T, i);
    v = sel(g, sc, c, v, old);
  }
  if (paged) {
    const p = bin(g, sc, '>>', i, lit(7));
    const w = bin(g, sc, '&', i, lit(127));
    const pg = emitv(g, sc, `get ${T.o} ${p.o}`, elemType(T.t), `${tn}_g`);
    const pg2 = emitv(g, sc, `set ${pg.o} ${w.o} ${v.o}`, pg.t, `${tn}_h`);
    sc.vars.set(tn, emitv(g, sc, `set ${T.o} ${p.o} ${pg2.o}`, T.t, tn));
  } else {
    sc.vars.set(tn, emitv(g, sc, `set ${T.o} ${i.o} ${v.o}`, T.t, tn));
  }
}

const isPaged = (t: string): boolean => {
  if (isTuple(t)) return false;
  const d = dims(t);
  return d.length === 2 && d[0] === 128;
};

function emitv(g: FnGen, sc: Scope, rest: string, t: string, hint: string | undefined): Val {
  const id = g.fresh(hint, sc.prefix);
  g.emit(id, rest);
  return { o: id, t };
}

function readIdx(g: FnGen, sc: Scope, T: Val, i: Val): Val {
  if (isPaged(T.t)) {
    const p = bin(g, sc, '>>', i, lit(7));
    const w = bin(g, sc, '&', i, lit(127));
    const pg = emitv(g, sc, `get ${T.o} ${p.o}`, elemType(T.t), undefined);
    return emitv(g, sc, `get ${pg.o} ${w.o}`, elemType(pg.t), undefined);
  }
  return emitv(g, sc, `get ${T.o} ${i.o}`, elemType(T.t), undefined);
}

function sel(g: FnGen, sc: Scope, c: Val, a: Val, b: Val, hint?: string): Val {
  if (c.c !== undefined) return c.c ? a : b;
  return emitv(g, sc, `select ${c.o} ${a.o} ${b.o}`, a.t, hint);
}

function bin(g: FnGen, sc: Scope, op: string, a: Val, b: Val, hint?: string): Val {
  if (a.c !== undefined && b.c !== undefined) {
    const f = foldBin(op, a.c, b.c);
    if (f !== undefined) return lit(f);
  }
  const t = CMP.has(op) ? 'bool' : a.t;
  return emitv(g, sc, `${OPS[op]} ${a.o} ${b.o}`, t, hint);
}

function ex(g: FnGen, sc: Scope, e: Ast, hint: string | undefined): Val {
  return mat(g, sc, exr(g, sc, e, hint));
}

function mat(g: FnGen, sc: Scope, v: Val): Val {
  if (v.parts === undefined || v.o !== '') return v;
  const o = emitv(g, sc, `rec ${v.parts.map((x) => x.o).join(' ')}`, v.t, undefined);
  return { o: o.o, t: v.t, parts: v.parts };
}

function exr(g: FnGen, sc: Scope, e: Ast, hint: string | undefined): Val {
  switch (e.k) {
    case 'num':
      return lit(e.v);
    case 'bool':
      return lit(e.v);
    case 'id': {
      const v = sc.vars.get(e.n);
      if (v !== undefined) return v;
      const c = consts.get(e.n);
      if (c !== undefined) return lit(c);
      throw new Error(`unknown name ${e.n} in ${g.name}`);
    }
    case 'bin':
      return bin(g, sc, e.op, ex(g, sc, e.a, undefined), ex(g, sc, e.b, undefined), hint);
    case 'not': {
      const a = ex(g, sc, e.a, undefined);
      if (a.c !== undefined) return lit(!a.c);
      return emitv(g, sc, `xor ${a.o} true`, 'bool', hint);
    }
    case 'tern': {
      const c = ex(g, sc, e.c, undefined);
      const a = ex(g, sc, e.a, undefined);
      const b = ex(g, sc, e.b, undefined);
      return sel(g, sc, c, a, b, hint);
    }
    case 'idx':
      return readIdx(g, sc, ex(g, sc, e.a, undefined), ex(g, sc, e.i, undefined));
    case 'fld': {
      const a0 = exr(g, sc, e.a, undefined);
      if (a0.parts !== undefined) return a0.parts[e.n] as Val;
      const a = mat(g, sc, a0);
      return emitv(g, sc, `at ${a.o} ${e.n}`, tupleParts(a.t)[e.n] as string, hint);
    }
    case 'tup': {
      const items = e.items.map((x) => ex(g, sc, x, undefined));
      void hint;
      return { o: '', t: `(${items.map((x) => x.t).join(',')})`, parts: items };
    }
    case 'call':
      return callExpr(g, sc, e, hint);
  }
}

function callExpr(
  g: FnGen,
  sc: Scope,
  e: Extract<Ast, { k: 'call' }>,
  hint: string | undefined,
): Val {
  const f = e.f;
  const args = e.args.map((a, k) =>
    (f === 'fold' && k === 0) || (f === 'loop' && k < 2)
      ? ({ o: '', t: '' } as Val)
      : ex(g, sc, a, undefined),
  );
  const aop = args.map((a) => a.o).join(' ');
  switch (f) {
    case 'fold':
      return emitv(
        g,
        sc,
        `fold ${(e.args[0] as { n: string }).n} ${args
          .slice(1)
          .map((a) => a.o)
          .join(' ')}`,
        (args[2] as Val).t,
        hint,
      );
    case 'loop':
      return emitv(
        g,
        sc,
        `loop ${(e.args[0] as { n: string }).n} ${(e.args[1] as { n: string }).n} ${args
          .slice(2)
          .map((a) => a.o)
          .join(' ')}`,
        (args[3] as Val).t,
        hint,
      );
    case 'arr':
      return emitv(g, sc, `arr ${aop}`, `${(args[0] as Val).t}x${args.length}`, hint);
    case 'rec':
      return emitv(g, sc, `rec ${aop}`, `(${args.map((a) => a.t).join(',')})`, hint);
    case 'at':
      return emitv(
        g,
        sc,
        `at ${aop}`,
        tupleParts((args[0] as Val).t)[(args[1] as Val).c as number] as string,
        hint,
      );
    case 'get':
      return emitv(g, sc, `get ${aop}`, elemType((args[0] as Val).t), hint);
    case 'set':
      return emitv(g, sc, `set ${aop}`, (args[0] as Val).t, hint);
    case 'put':
      return emitv(g, sc, `put ${aop}`, (args[0] as Val).t, hint);
    case 'mov':
      return emitv(g, sc, `mov ${aop}`, (args[0] as Val).t, hint);
    case 'write':
      return emitv(g, sc, `write ${aop}`, 'io', hint);
    case 'read':
      return emitv(g, sc, `read ${aop}`, '(u32,io)', hint);
    case 'zlist':
      return emitv(g, sc, `arr ${Array(64).fill('0').join(' ')}`, 'u32x64', hint);
    case 'zeros': {
      if (!g.zp) {
        g.zp = g.fresh('zp', '');
        g.emit(g.zp, 'call zpage');
      }
      const nn = (args[0] as Val).c as number;
      return emitv(g, sc, `arr ${Array(nn).fill(g.zp).join(' ')}`, `u32x128x${nn}`, hint);
    }
    case 'sel':
      return sel(g, sc, args[0] as Val, args[1] as Val, args[2] as Val, hint);
    case 'bool':
      return bin(g, sc, '!=', args[0] as Val, lit(0), hint);
    case 'bit':
      return sel(g, sc, args[0] as Val, lit(1), lit(0), hint);
  }
  const d = defs.get(f);
  if (d !== undefined) return expandDef(g, d, args, hint);
  const s = sigs.get(f);
  if (s === undefined) throw new Error(`unknown function ${f}`);
  return emitv(g, sc, `call ${f} ${aop}`, s.ret, hint);
}

function expandDef(g: FnGen, d: Def, args: Val[], hint: string | undefined): Val {
  const sc = new Scope(`m${g.macroN++}_`);
  for (const [k, [n]] of d.params.entries()) sc.vars.set(n, args[k] as Val);
  const save = g.result;
  g.result = undefined;
  compileBlock(g, sc, d.body);
  const r = g.result;
  g.result = save;
  if (r === undefined) throw new Error('macro without return');
  void hint;
  return r;
}

function parseSig(head: string): { name: string; params: [string, string][]; ret: string } {
  const m = /^(?:fn|def|extern)\s+([A-Za-z0-9_]+)\s*\((.*)\)\s*->\s*(.+)$/.exec(head);
  if (!m) throw new Error(`bad signature: ${head}`);
  const params = splitTop(m[2] as string)
    .filter((s) => s.trim() !== '')
    .map((p): [string, string] => {
      if (!p.includes(':')) return ['_', p.replace(/\s+/g, '')];
      const [n, t] = p.split(':').map((s) => s.replace(/\s+/g, ''));
      return [n as string, t as string];
    });
  return { name: m[1] as string, params, ret: (m[3] as string).replace(/\s+/g, '') };
}

const STMT_CONST = /^const\s+([A-Za-z0-9_]+)\s*=\s*(.*)$/;

/** Compile A0S source text to A0 text. */
export function compileA0S(text: string): string {
  const src = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < src.length; i += 1) {
    const raw = src[i] as string;
    // `raw TEXT` lines pass through unchanged (comments and `use` lines of the output).
    if (raw === 'raw' || raw.startsWith('raw ')) {
      out.push(raw.slice(4));
      continue;
    }
    const t = raw.replace(/\s+#.*$/, '').trim();
    if (t === '' || t.startsWith('#')) continue;
    const konst = STMT_CONST.exec(t);
    if (konst) {
      const v = ex(new FnGen('const'), new Scope(''), parseExpr(konst[2] as string), undefined);
      if (typeof v.c !== 'number') throw new Error(`const ${konst[1]} not constant`);
      consts.set(konst[1] as string, v.c);
    } else if (t.startsWith('extern ')) {
      const s = parseSig(t);
      sigs.set(s.name, { params: s.params.map((p) => p[1]), ret: s.ret });
    } else if (t.startsWith('fn ') || t.startsWith('def ')) {
      const body: string[] = [];
      i += 1;
      while ((src[i] as string).trim() !== 'end') {
        body.push((src[i] as string).replace(/\s+#.*$/, ''));
        i += 1;
      }
      const s = parseSig(t);
      if (t.startsWith('def ')) defs.set(s.name, { params: s.params, ret: s.ret, body });
      else {
        sigs.set(s.name, { params: s.params.map((p) => p[1]), ret: s.ret });
        out.push(compileFn({ head: t, body }));
      }
    } else throw new Error(`line ${i + 1}: ${t}`);
  }
  return `${out.join('\n')}\n`;
}

function compileFn(it: { head: string; body: string[] }): string {
  const s = parseSig(it.head);
  const g = new FnGen(s.name);
  const sc = new Scope('');
  for (const [k, [n, t]] of s.params.entries()) sc.vars.set(n, { o: `p${k}`, t });
  compileBlock(g, sc, it.body);
  if (g.result === undefined) throw new Error(`${s.name}: no return`);
  g.result = mat(g, sc, g.result);
  const retOp = g.result.o;
  if (g.result.c !== undefined || /^p\d+$/.test(retOp) === false) {
    // literal or node: ret accepts any operand
  }
  if (g.lines.length > 2600) console.error(`WARNING ${s.name}: ${g.lines.length} nodes`);
  const header = `fn ${s.name}${s.params.length ? ` ${s.params.map((p) => p[1]).join(' ')}` : ''} -> ${s.ret}`;
  if (g.result.t !== s.ret) console.error(`note ${s.name}: result type ${g.result.t} vs ${s.ret}`);
  return [header, ...g.lines, `ret ${retOp}`, 'end'].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [input, output, check] = process.argv.slice(2);
  if (input === undefined || output === undefined)
    throw new Error('usage: a0s.ts input.a0s output.a0 [--check]');
  const text = compileA0S(readFileSync(input, 'utf8'));
  if (check === '--check') {
    if (readFileSync(output, 'utf8') !== text) {
      process.stderr.write(`${output} is not what ${input} compiles to\n`);
      process.exit(1);
    }
  } else writeFileSync(output, text);
}
