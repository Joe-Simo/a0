import { aggregate, formatAggregate } from './aggregate.mjs';
/**
 * A0 v0.1 core: grammar, typed representation, validation, and reference interpreter.
 *
 * Semantics (exact, target-independent):
 * - Types: u32 (unsigned 32-bit integer) and bool.
 * - add/sub/mul wrap modulo 2^32. and/or/xor are bitwise on u32.
 * - shl/shr shift by the low five bits of the distance; shr is logical.
 * - eq/lt are unsigned comparisons yielding bool.
 * - select(c, a, b) chooses a when c is true, else b; a and b share a type
 *   and are both already computed (no laziness, no effects).
 * - mov is the identity on either type.
 * - call f a... applies an earlier-defined function of this program to arguments
 *   whose types match its parameters; the result has the callee's result type.
 *   Callees must precede callers, so the call graph is acyclic (no recursion).
 * - fold f n s a... runs state = f(state, i, a...) for i = 0..n-1 starting from s and
 *   yields the final state; f is an earlier function of type (T, u32, A...) -> T.
 *   The u32 trip count guarantees termination; iterations are sequential and exact.
 * - loop p f n s a... is fold with early exit: before each iteration i < n the
 *   predicate p(state, i, a...) : bool is evaluated; when false the loop stops and
 *   the current state is the result; otherwise state = f(state, i, a...). n caps
 *   the iteration count so termination is still guaranteed.
 * All operations are pure and total on validated input.
 */
import { A0Error, diag, spellingSuggestion, } from '../../frozen/runtime/src/diagnostics.js';
import { isExampleLine, SpecBuilder, specLinesWithComments, specWordOf, verifySpec, } from './spec.mjs';
export const LANGUAGE_VERSION = 'a0-0.1';
/**
 * `io` is the effect capability: a linear token whose data dependencies define effect
 * order. `read t` consumes t and yields `(u32,io)`; `write t v` consumes t and yields
 * `io`. A token is consumed at most once, a function takes at most one `io` parameter,
 * arrays cannot hold tokens, and `select` cannot choose between tokens.
 */
export function containsIo(t) {
    if (t === 'io')
        return true;
    if (typeof t === 'string')
        return false;
    if (t.kind === 'arr')
        return containsIo(t.elem);
    for (const f of t.fields)
        if (containsIo(f))
            return true;
    return false;
}
export function isScalar(t) {
    return t === 'u32' || t === 'bool';
}
/** Scalars and the io token: every type that is not an array or record. */
export function isPrimitive(t) {
    return typeof t === 'string';
}
export function typeEquals(a, b) {
    // Types are immutable: one object (a type passed along from a signature) equals itself.
    if (a === b)
        return true;
    if (typeof a === 'string' || typeof b === 'string')
        return false;
    if (a.kind === 'arr')
        return b.kind === 'arr' && a.length === b.length && typeEquals(a.elem, b.elem);
    if (b.kind !== 'rec' || a.fields.length !== b.fields.length)
        return false;
    for (let i = 0; i < a.fields.length; i += 1)
        if (!typeEquals(a.fields[i], b.fields[i]))
            return false;
    return true;
}
export function formatType(t) {
    if (isScalar(t) || t === 'io')
        return t;
    if (t.kind === 'arr')
        return `${formatType(t.elem)}x${t.length}`;
    return `(${t.fields.map(formatType).join(',')})`;
}
/** Bit width of a value of this type (u32 = 32, bool = 1, aggregates packed). */
export function bitWidth(t) {
    if (t === 'u32')
        return 32;
    if (t === 'bool')
        return 1;
    if (t === 'io')
        throw diag('A0708');
    if (t.kind === 'arr')
        return t.length * bitWidth(t.elem);
    return t.fields.reduce((n, f) => n + bitWidth(f), 0);
}
/** Longest array dimension anywhere inside a type (0 for a type without arrays). */
export function longestArray(t) {
    if (isPrimitive(t))
        return 0;
    if (t.kind === 'arr')
        return Math.max(t.length, longestArray(t.elem));
    return t.fields.reduce((n, f) => Math.max(n, longestArray(f)), 0);
}
/**
 * Refuse a function whose parameters, result, or nodes use an array longer than
 * LIMITS.maxVectorArrayLength on a target that keeps aggregates in registers or bit vectors.
 */
export function assertVectorSized(fn, target) {
    const types = [...fn.params, fn.result, ...fn.types.values()];
    const longest = types.reduce((n, t) => Math.max(n, longestArray(t)), 0);
    if (longest > LIMITS.maxVectorArrayLength) {
        throw diag('A0707', [fn.name, longest, target, LIMITS.maxVectorArrayLength]);
    }
}
export const OPS = [
    'mov',
    'add',
    'sub',
    'mul',
    'and',
    'or',
    'xor',
    'shl',
    'shr',
    'eq',
    'ne',
    'lt',
    'le',
    'gt',
    'ge',
    'select',
    'call',
    'fold',
    'loop',
    'arr',
    'rec',
    'get',
    'set',
    'at',
    'put',
    'read',
    'write',
    'div',
    'rem',
    'puts',
];
/**
 * The total (checked) operations, valid in both profiles: each yields the `(value, ok)` record
 * `(u32,bool)` and never traps. The reference interpreter and every target in
 * `CHECKED_TARGETS` evaluate them; every target outside that set refuses a program that
 * uses one (A0713, `assertTargetSupports`). The A0 front end also parses and checks them, with
 * word IR codes 32 through 37. `ALL_OPS` is what the TypeScript parser, the dense form and the
 * editor tools accept.
 */
export const CHECKED_OP_NAMES = ['cadd', 'csub', 'cmul', 'cdiv', 'crem', 'cget'];
export const CHECKED_OPS = new Set(CHECKED_OP_NAMES);
export const ALL_OPS = [...OPS, ...CHECKED_OP_NAMES];
const ALL_OP_SET = new Set(ALL_OPS);
/**
 * The targets that implement the strict profile and the checked ops: `js`, `c` (with its C++ and
 * parallel variants, and the wasm build through clang), `java`, `dotnet`, the direct `wasm` backend
 * and the direct `arm64`, `x86_64`, `riscv64`, `arm32` and `avr` backends.
 */
export const STRICT_TARGETS = new Set([
    'js',
    'c',
    'java',
    'dotnet',
    'wasm',
    'arm64',
    'x86_64',
    'riscv64',
    'arm32',
    'avr',
]);
/** A0 services support total checked operations before their strict trapping runtime is ported. */
export const CHECKED_TARGETS = new Set([
    ...STRICT_TARGETS,
    'a0c',
    'a0w',
    'a0w optimizer',
]);
/**
 * Refuse what a target cannot honour. A target outside `STRICT_TARGETS` implements the canonical
 * profile, and one outside `CHECKED_TARGETS` implements none of the checked ops. None may silently run the canonical semantics for a
 * program that depends on a trap or an `(u32,bool)` record: a program with a checked op, or a
 * `profile strict` program with a site that can trap, is a `structure` error (A0713) naming the
 * target and the construct. A strict program whose every index is proved below its length and
 * every divisor proved nonzero has no site: it cannot trap, so it means the same in both
 * profiles and compiles as the canonical program does (`trapSite` is `strictTrapSite` of
 * src/optimize.ts; without it a strict program is always refused). Canonical programs pass untouched.
 */
export function assertTargetSupports(target, p, trapSite) {
    if (STRICT_TARGETS.has(target))
        return;
    if (!CHECKED_TARGETS.has(target))
        for (const fn of p.functions) {
            const node = fn.nodes.find((n) => CHECKED_OPS.has(n.op));
            if (node !== undefined)
                throw diag('A0713', [target, `the checked op ${node.op} (${fn.name}.${node.id})`]);
        }
    if (p.profile !== 'strict')
        return;
    if (trapSite === undefined)
        throw diag('A0713', [target, 'a `profile strict` program']);
    for (const fn of p.functions) {
        const site = trapSite(fn);
        if (site !== undefined)
            throw diag('A0713', [
                target,
                `a \`profile strict\` program with a site that can trap (${site})`,
            ]);
    }
}
/**
 * `program` under the canonical profile: a target outside `STRICT_TARGETS` compiles a strict
 * program only when it has no site that can trap (`assertTargetSupports`), and then it means the
 * same as the canonical program, which is what such a target emits (the same text).
 */
export function withoutProfile(program) {
    return program.profile === 'strict' ? validate({ functions: program.functions }) : program;
}
/** Operand counts; `call` is variable (the callee's parameter count) and marked -1. */
/** Binary ops whose result does not depend on how a run of operands is grouped. */
const ASSOCIATIVE_OPS = new Set(['add', 'mul', 'and', 'or', 'xor']);
export const OP_ARITY = {
    mov: 1,
    add: 2,
    sub: 2,
    mul: 2,
    and: 2,
    or: 2,
    xor: 2,
    shl: 2,
    shr: 2,
    eq: 2,
    ne: 2,
    lt: 2,
    le: 2,
    gt: 2,
    ge: 2,
    select: 3,
    call: -1,
    fold: -1,
    loop: -1,
    arr: -1,
    rec: -1,
    get: 2,
    set: 3,
    at: 2,
    put: 3,
    read: 1,
    write: 2,
    div: 2,
    rem: 2,
    puts: 2,
    cadd: 2,
    csub: 2,
    cmul: 2,
    cdiv: 2,
    crem: 2,
    cget: 2,
};
/** Index of the `#` starting a comment (outside a double-quoted text literal), or -1. */
function commentStart(line) {
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const c = line.charCodeAt(i);
        if (c === 92 && quoted) {
            i += 1; // a `\` escape inside a text literal
        }
        else if (c === 34) {
            quoted = !quoted; // `"`
        }
        else if (c === 35 && !quoted) {
            return i; // `#`
        }
    }
    return -1;
}
/** Remove a `#` comment unless the `#` sits inside a double-quoted text literal. */
export function stripComment(line) {
    const at = commentStart(line);
    return at < 0 ? line : line.slice(0, at);
}
/** The `#` comment of a line (from `#`, trailing whitespace removed), if any. */
export function lineComment(line) {
    const at = commentStart(line);
    return at < 0 ? undefined : line.slice(at).trimEnd();
}
const TEXT_LINE = /^(\S+)\s+(?:text\s+)?"((?:[^"\\]|\\.)*)"\s*$/;
function decodeText(raw, line) {
    return raw.replace(/\\(.)/g, (_, c) => {
        if (c === 'n')
            return '\n';
        if (c === 't')
            return '\t';
        if (c === '"' || c === '\\')
            return c;
        throw diag('A0008', [c], line === undefined ? {} : { line });
    });
}
export function formatTextLiteral(text) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}
export const PROFILES = ['canonical', 'strict'];
/**
 * The edit lines that change the profile (program-level, like `-fn`): `profile strict` sets it,
 * `-profile` restores the canonical default. Both are idempotent; neither belongs to a function body.
 */
export const isProfileEdit = (line) => /^(profile\s+strict|-profile)$/.test(line);
/** The profile a program declares: `strict` only when it says so. */
export const profileOf = (p) => p?.profile === 'strict' ? 'strict' : 'canonical';
/** The borrows of `o` (`borrowLive`): aggregate reads of it, or of an earlier borrow of it. */
export function borrowsOf(fn, o) {
    const same = (x) => (x.kind === 'node' && o.kind === 'node' && x.id === o.id) ||
        (x.kind === 'param' && o.kind === 'param' && x.index === o.index);
    const borrows = new Set();
    for (const n of fn.nodes) {
        const t = fn.types.get(n.id);
        if (t === undefined || isPrimitive(t))
            continue;
        const from = (x) => x !== undefined && (same(x) || (x.kind === 'node' && borrows.has(x.id)));
        const borrowed = ((n.op === 'get' || n.op === 'at') && from(n.args[0])) ||
            (n.op === 'mov' && from(n.args[0])) ||
            (n.op === 'select' && (from(n.args[1]) || from(n.args[2])));
        // From `o` itself or from an earlier borrow of it (nodes are in definition order).
        if (borrowed)
            borrows.add(n.id);
    }
    return borrows;
}
/**
 * Borrowed reads (backends with flat aggregate storage: C, the native targets, wasm). A `get`
 * or `at` whose result is an aggregate names a part of its container's storage instead of
 * copying it; `mov` and `select` of a borrow alias it too. Value semantics then require that
 * the container is not updated in place while a borrow of it is still read. Is some borrow of
 * `o` read after the node at `index` (or by that node itself, unless `selfRead`: a `set`/`put`
 * reads its value operand before writing its target, whereas a fold's body keeps reading its
 * extras while the state changes), or returned?
 */
export function borrowLive(fn, o, index, selfRead) {
    const borrows = borrowsOf(fn, o);
    if (borrows.size === 0)
        return false;
    const isBorrow = (x) => x.kind === 'node' && borrows.has(x.id);
    if (isBorrow(fn.ret))
        return true;
    for (const [j, n] of fn.nodes.entries()) {
        if (j < index || (j === index && selfRead))
            continue;
        if (n.args.some(isBorrow))
            return true;
    }
    return false;
}
export { A0Error, formatDiagnostic, formatTrap, TRAP_FIX, } from '../../frozen/runtime/src/diagnostics.js';
// ---------------------------------------------------------------------------
// Limits (hostile-input bounds)
// ---------------------------------------------------------------------------
export const LIMITS = {
    maxSourceBytes: 2 << 20,
    /** Functions per program, also after linking (a0c-0.1.14: raised from 1024). */
    maxFunctions: 65536,
    maxNodesPerFunction: 4096,
    maxParams: 64,
    maxIdentifierLength: 64,
    /** Elements per array dimension; the native paths (C, JS, JVM, .NET, arm64) hold these in memory. */
    maxArrayLength: 65536,
    /** Total bits of one aggregate value (bounds nested arrays): 65536 u32 words. */
    maxAggregateBits: 1 << 21,
    /**
     * Longest array the hardware (SystemVerilog) and GPU (Metal) backends accept: these targets
     * hold aggregates as bit vectors or thread-local registers, so larger values are refused
     * with a `limit` diagnostic instead of being emitted as multi-megabit vectors.
     */
    maxVectorArrayLength: 1024,
    /** Product of literal trip counts along any nesting path a validator will accept (compute bound). */
    maxStaticIterations: 1 << 24,
    /** Default interpreter fuel: node evaluations before `run` aborts with A0Error. */
    defaultFuel: 100_000_000,
    /** Maximum words an io state may accumulate on its output in the reference evaluator. */
    maxIoOutput: 1 << 20,
};
// The word shapes below are tested over char codes, not with regular expressions: a regular expression
// starts in V8's regexp interpreter, and a cold `a0 check` runs these once per word of the program.
/** `/^[a-z][a-z0-9_]{0,63}$/.test(s)`. */
function isIdentShape(s) {
    const n = s.length;
    if (n === 0 || n > 64)
        return false;
    let c = s.charCodeAt(0);
    if (c < 97 || c > 122)
        return false;
    for (let i = 1; i < n; i += 1) {
        c = s.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95))
            return false;
    }
    return true;
}
/** `/^(0|[1-9][0-9]*)$/.test(s.slice(from))`. */
function isDecimalFrom(s, from) {
    const n = s.length;
    if (from >= n)
        return false;
    const c0 = s.charCodeAt(from);
    if (c0 === 48)
        return n === from + 1;
    if (c0 < 49 || c0 > 57)
        return false;
    for (let i = from + 1; i < n; i += 1) {
        const c = s.charCodeAt(i);
        if (c < 48 || c > 57)
            return false;
    }
    return true;
}
/** `/^p(0|[1-9][0-9]*)$/.test(s)`: a parameter reference. */
function isParamWord(s) {
    return s.charCodeAt(0) === 112 && isDecimalFrom(s, 1);
}
/** Whether `c` is a char code `\s` matches. */
function isSpaceCode(c) {
    return (c === 32 ||
        (c >= 9 && c <= 13) ||
        c === 0xa0 ||
        c === 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) ||
        c === 0x2028 ||
        c === 0x2029 ||
        c === 0x202f ||
        c === 0x205f ||
        c === 0x3000 ||
        c === 0xfeff);
}
// The scanners below (and the line scanner in `parse`) test the printable ASCII range (`!` to `~`,
// never `\s`) inline before calling `isSpaceCode`: nearly every char of a program is in it, and a
// cold run executes them unoptimised, where each call costs.
/** `text.trim().split(/\s+/)`, in one pass over the char codes. */
function splitWords(text) {
    const out = [];
    const n = text.length;
    let i = 0;
    for (;;) {
        while (i < n) {
            const c = text.charCodeAt(i);
            if ((c > 32 && c < 0x7f) || !isSpaceCode(c))
                break;
            i += 1;
        }
        if (i === n)
            break;
        const start = i;
        while (i < n) {
            const c = text.charCodeAt(i);
            if (!((c > 32 && c < 0x7f) || !isSpaceCode(c)))
                break;
            i += 1;
        }
        out.push(start === 0 && i === n ? text : text.slice(start, i));
    }
    if (out.length === 0)
        out.push('');
    return out;
}
const RESERVED = new Set(['fn', 'ret', 'end', 'patch', 'true', 'false']);
const U32_MAX = 0xffff_ffff;
/** UTF-8 byte length without Node's Buffer (the compiler core also runs in the browser). */
export function utf8Length(text) {
    return new TextEncoder().encode(text).length;
}
export function isValidIdentifier(id) {
    return isIdentShape(id) && !RESERVED.has(id) && !isParamWord(id);
}
export function isValidFunctionName(name) {
    return isIdentShape(name) && !RESERVED.has(name);
}
/** A line of source as the checker compares it: comment removed, whitespace normalised. */
export function normalizeLine(raw) {
    return stripComment(raw).trim().split(/\s+/).join(' ');
}
/** An exact or maybe edit replacing the failing line (matched by its normalised text). */
function lineEdit(rule, text, to, line) {
    return {
        op: 'lines',
        rule,
        text: normalizeLine(text),
        to,
        ...(line === undefined ? {} : { line }),
    };
}
/** `lineText` with the first whole word after the first equal to `from` replaced by `to`. */
function replaceWord(lineText, from, to) {
    const words = normalizeLine(lineText).split(' ');
    const at = words.findIndex((w, i) => i > 0 && w === from);
    if (at >= 0)
        words[at] = to;
    return words.join(' ');
}
/** `newMin` as `new_min`: the lowercase spelling of a name, or undefined when none exists. */
function lowerName(name) {
    const out = name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_');
    return /^[a-z]/.test(out) && out !== name ? out : undefined;
}
/** The types an unknown type word can be a misspelling of. */
const TYPE_WORDS = ['u32', 'bool', 'io'];
/**
 * Parse a type. `header` (the whole `fn` line) lets a misspelt type word carry a did-you-mean
 * edit that rewrites it.
 */
export function parseType(text, line, header) {
    let pos = 0;
    const fail = (msg, word) => {
        let fix;
        let edits;
        if (word !== undefined && word === text) {
            const guess = spellingSuggestion(word, TYPE_WORDS);
            if (guess !== undefined) {
                fix = `did you mean '${guess}'? types are u32, bool, io, arrays u32x4, records (u32,bool)`;
                if (header !== undefined)
                    edits = [lineEdit('typo', header, replaceWord(header, word, guess), line)];
            }
        }
        throw diag('A0001', [text, msg], {
            ...(line === undefined ? {} : { line }),
            ...(fix === undefined ? {} : { fix }),
            ...(edits === undefined ? {} : { edits }),
        });
    };
    const parseOne = () => {
        let base;
        if (text[pos] === '_') {
            base = 'u32';
            pos += 1;
        }
        else if (text.startsWith('u32', pos)) {
            base = 'u32';
            pos += 3;
        }
        else if (text.startsWith('bool', pos)) {
            base = 'bool';
            pos += 4;
        }
        else if (text.startsWith('io', pos)) {
            base = 'io';
            pos += 2;
        }
        else if (text[pos] === '(') {
            pos += 1;
            const fields = [parseOne()];
            while (text[pos] === ',') {
                pos += 1;
                fields.push(parseOne());
            }
            if (text[pos] !== ')')
                fail("expected ')'");
            pos += 1;
            base = { kind: 'rec', fields };
        }
        else {
            return fail(`unexpected '${text[pos] ?? 'end'}'`, /^[A-Za-z0-9_]+/.exec(text.slice(pos))?.[0]);
        }
        while (text[pos] === 'x') {
            const m = /^x([1-9][0-9]*)/.exec(text.slice(pos));
            if (!m)
                fail('expected array length after x');
            const length = Number(m?.[1]);
            // The signature must represent every pure aggregate accepted by IR typing, including
            // inferred legacy bool arrays above the old u32-oriented dimension limit.
            const maxLength = containsIo(base) ? LIMITS.maxArrayLength : Math.max(LIMITS.maxArrayLength, Math.floor(LIMITS.maxAggregateBits / bitWidth(base)));
            if (length > maxLength)
                fail(`array length exceeds ${maxLength}`);
            pos += (m?.[0] ?? '').length;
            if (containsIo(base))
                fail('arrays cannot hold io tokens');
            base = { kind: 'arr', length, elem: base };
        }
        if (!containsIo(base) && bitWidth(base) > LIMITS.maxAggregateBits)
            fail(`type exceeds ${LIMITS.maxAggregateBits} bits`);
        return base;
    };
    const t = parseOne();
    if (pos !== text.length)
        fail(`trailing '${text.slice(pos)}'`);
    return t;
}
export function parseOperand(text, line, lineText, parameterUse) {
    // The first char picks the one shape the word can have: a literal, a parameter, or a name.
    const c0 = text.charCodeAt(0);
    if (text.length === 1 && c0 >= 65 && c0 <= 90) {
        const index = c0 - 65;
        if (parameterUse !== undefined && parameterUse.count <= index)
            parameterUse.count = index + 1;
        return { kind: 'param', index };
    }
    if (c0 >= 48 && c0 <= 57) {
        if (isDecimalFrom(text, 0)) {
            const value = Number(text);
            if (value > U32_MAX)
                throw diag('A0004', [text], lineAt(line));
            return { kind: 'u32', value };
        }
    }
    else if (c0 === 112 && isDecimalFrom(text, 1)) {
        const index = Number(text.slice(1));
        if (parameterUse !== undefined && parameterUse.count <= index)
            parameterUse.count = index + 1;
        return { kind: 'param', index };
    }
    else if (isIdentShape(text)) {
        if (text === 'true')
            return { kind: 'bool', value: true };
        if (text === 'false')
            return { kind: 'bool', value: false };
        if (!RESERVED.has(text))
            return { kind: 'node', id: text };
    }
    const at = line === undefined ? {} : { line };
    if (lineText !== undefined) {
        const edit = (rule, to) => lineEdit(rule, lineText, to, line);
        const lower = text.toLowerCase();
        if (text.includes(',') && !text.includes('(')) {
            const to = normalizeLine(lineText.replaceAll(',', ' '));
            throw diag('A0003', [text], {
                ...at,
                fix: `write \`${to}\`: operands are separated by spaces, not commas`,
                applicability: 'exact',
                edits: [edit('comma', to)],
            });
        }
        const hex = /^0x([0-9a-f]+)$/i.exec(text);
        if (hex !== null && Number.parseInt(hex[1], 16) <= U32_MAX) {
            const value = String(Number.parseInt(hex[1], 16));
            throw diag('A0003', [text], {
                ...at,
                fix: `write ${value}: literals are decimal`,
                applicability: 'exact',
                edits: [edit('hex', replaceWord(lineText, text, value))],
            });
        }
        if (lower !== text &&
            (lower === 'true' || lower === 'false' || isParamWord(lower) || isValidIdentifier(lower))) {
            throw diag('A0003', [text], {
                ...at,
                fix: `write '${lower}': operands are lowercase`,
                applicability: 'exact',
                edits: [edit('case', replaceWord(lineText, text, lower))],
            });
        }
        const negative = /^-([0-9]+)$/.exec(text);
        if (negative !== null && Number(negative[1]) >= 1 && Number(negative[1]) <= 2 ** 32) {
            const wrapped = String(2 ** 32 - Number(negative[1]));
            throw diag('A0003', [text], {
                ...at,
                fix: `literals are unsigned: ${text} wraps to ${wrapped} (or use sub); check that is what you meant`,
                edits: [edit('negative', replaceWord(lineText, text, wrapped))],
            });
        }
    }
    throw diag('A0003', [text], at);
}
function isOp(text) {
    return ALL_OP_SET.has(text);
}
/**
 * Accepted spellings of an op, parsed as the op itself (the canonical form prints the op). Every
 * A0 integer op is unsigned, so `udiv`/`urem` name exactly `div`/`rem`.
 */
export const OP_ALIASES = { udiv: 'div', urem: 'rem', '<<': 'shl', '>>': 'shr' };
/**
 * Words models write for an op A0 has under another name. They are not accepted as ops (the grammar
 * keeps one spelling per op); an unknown-callee diagnostic on one of them with the op's operand count
 * carries the rewrite as an exact fix. Every A0 integer is an unsigned u32, so the unsigned spellings name the plain op.
 */
const OP_SPELLINGS = {
    sel: { op: 'select', arity: 3, note: ' (`select cond a b` yields a when cond is true, else b)' },
    lte: { op: 'le', arity: 2, note: '' },
    gte: { op: 'ge', arity: 2, note: '' },
    ule: { op: 'le', arity: 2, note: ' (every A0 number is unsigned)' },
    uge: { op: 'ge', arity: 2, note: ' (every A0 number is unsigned)' },
    ult: { op: 'lt', arity: 2, note: ' (every A0 number is unsigned)' },
    ugt: { op: 'gt', arity: 2, note: ' (every A0 number is unsigned)' },
    neq: { op: 'ne', arity: 2, note: '' },
    equ: { op: 'eq', arity: 2, note: '' },
};
/**
 * Operator symbols written where the op belongs (`c == a b`): the op each stands for. A rewrite is exact only
 * when the line has the op's own operand count, so `c < a b` is `c lt a b` and nothing is guessed.
 */
const SYMBOL_OPS = {
    '==': 'eq',
    '!=': 'ne',
    '<': 'lt',
    '<=': 'le',
    '>': 'gt',
    '>=': 'ge',
    '+': 'add',
    '-': 'sub',
    '*': 'mul',
    '/': 'div',
    '%': 'rem',
    '&': 'and',
    '&&': 'and',
    '|': 'or',
    '||': 'or',
    '^': 'xor',
    '<<': 'shl',
    '>>': 'shr',
};
/**
 * The exact fixes and hints for invented op names (symbols, chains, not, max, min, NAMED_HINTS) are on unless
 * `A0_NEW_FIXES=off`, which gives the diagnostics as they were before them (the old arm of the pre-registered run).
 */
const newFixes = () => typeof process === 'undefined' || process.env.A0_NEW_FIXES !== 'off';
/** What to write for a name models invent that has no single exact rewrite (the meaning depends on the operand type). */
const NAMED_HINTS = {
    not: 'there is no `not`: flip a bool with `xor x true`; for a u32, a logical not is `eq x 0` and the bitwise complement is `xor x 4294967295`',
    neg: 'there is no `neg`: every A0 number is unsigned and wraps, so the negation of x is `sub 0 x`',
    abs: 'there is no `abs`: every A0 number is unsigned, so there is no sign to remove; for a distance between a and b use a compare and a select of `sub a b` and `sub b a`',
    cmp: 'there is no `cmp`: compare with eq ne lt le gt ge, each yields a bool (`c lt a b`)',
    max: 'there is no `max`: `t gt a b` then `x select t a b`',
    min: 'there is no `min`: `t lt a b` then `x select t a b`',
};
/** The op a word names (an op or an accepted alias), or undefined. */
export function opOf(word) {
    return isOp(word) ? word : Object.hasOwn(OP_ALIASES, word) ? OP_ALIASES[word] : undefined;
}
/**
 * Whether `word` in op position is a direct call `id F args…` (short for `id call F args…`):
 * any valid function name that is not an op, an alias, or the `text` form. Ops take precedence,
 * so a function named like an op is called only with `call`.
 */
export function isDirectCallee(word) {
    return opOf(word) === undefined && word !== 'text' && isValidFunctionName(word);
}
/**
 * Fix for a line with a parenthesised operand, which A0 does not have (one op per line): the
 * inner op on its own line above, then the line using that node. `ret (a, b)` builds a record.
 * `to` is the rewritten text (one or two lines); `exact` when the line has one pair of
 * parentheses, so the rewrite leaves nothing nested.
 */
function nestedFix(id, head, rest) {
    const text = rest.join(' ');
    const open = text.indexOf('(');
    const close = text.indexOf(')', open);
    const inner = (close < 0 ? text.slice(open + 1) : text.slice(open + 1, close))
        .replaceAll(',', ' ')
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0);
    const innerOp = inner[0] ?? '';
    // `(a, b)` or `(a b)` is a record; `(OP …)` or `(F …)` an inner op or call.
    const tuple = text.slice(open, close < 0 ? undefined : close).includes(',') ||
        (opOf(innerOp) === undefined && !(isDirectCallee(innerOp) && inner.length > 1));
    if (tuple)
        inner.unshift('rec');
    const pairs = text.split('(').length - 1 === 1 && text.split(')').length - 1 === 1;
    if (id === 'ret' && text.startsWith('(') && (close < 0 || close === text.length - 1)) {
        const to = `ret ${inner.join(' ')}`;
        return { fix: `write \`${to}\``, to, exact: pairs };
    }
    const t = `${id === 'ret' ? 'r' : id}1`;
    const outer = `${text.slice(0, open)}${t}${close < 0 ? '' : text.slice(close + 1)}`
        .trim()
        .replace(/\s+/g, ' ');
    const first = `${t} ${inner.join(' ')}`;
    const second = [...head, outer].join(' ');
    return {
        fix: `one op per line: write \`${first}\` above, then \`${second}\``,
        to: `${first}\n${second}`,
        exact: pairs && close >= 0,
    };
}
/** The error for a line with a parenthesised operand. */
function nestedError(id, head, rest, lineText, line, cls) {
    const { fix, to, exact } = nestedFix(id, head, rest);
    const e = diag('A0010', [], {
        ...(line === undefined ? {} : { line }),
        fix,
        ...(exact ? { applicability: 'exact' } : {}),
        edits: [lineEdit('nested', lineText, to, line)],
    });
    return cls === e.code ? e : new A0Error(e.detail, e.line, { ...e.detailOf(), code: cls });
}
/** `words.map((w) => parseOperand(w, line, lineText))`, without a closure per line. */
function operandsOf(words, line, lineText, parameterUse) {
    const out = [];
    for (let k = 0; k < words.length; k += 1)
        out.push(parseOperand(words[k], line, lineText, parameterUse));
    return out;
}
/** Parse one instruction line `id op operand...` (no validation of references). */
/** The `line` field of a diagnostic, built only when one is thrown. */
function lineAt(line) {
    return line === undefined ? {} : { line };
}
/** Flat aggregate syntax uses the source scanner's words; it never tokenizes the line again. */
function parseAggregateNode(id, parts, line, parameterUse) {
    const cursor = { text: parts.slice(1).join(' '), pos: 0 };
    const fail = (message) => { throw new A0Error(message, line); };
    const value = aggregate(cursor, {
        maxElements: LIMITS.maxAggregateBits,
        fail,
        atom: () => {
            const word = /^[^\s,\[\]()*;]+/.exec(cursor.text.slice(cursor.pos))?.[0];
            if (word === undefined)
                return fail('an aggregate element must be an operand');
            cursor.pos += word.length;
            return parseOperand(word, line, undefined, parameterUse);
        },
    });
    if (cursor.pos !== cursor.text.length)
        fail('unexpected text after aggregate literal');
    return { id, op: value.kind, args: value.items };
}
export function parseNode(lineText, line) {
    return parseNodeOf(lineText, line, undefined);
}
/**
 * `parseNode`, given the line's words (`lineText.trim().split(/\s+/)`) when the parser has them
 * already; only for a line without a `"`, as a text literal is matched on the whole line.
 */
function parseNodeOf(lineText, line, words, parameterUse) {
    // TEXT_LINE needs a quote: a line without one skips the regular expression.
    const textMatch = words === undefined && lineText.includes('"') ? TEXT_LINE.exec(lineText.trim()) : null;
    if (textMatch !== null) {
        // `id text "..."` desugars to `arr` of UTF-8 byte words; the source form is retained.
        const [, id, raw] = textMatch;
        if (id === undefined || !isValidIdentifier(id)) {
            throw diag('A0005', [id ?? ''], lineAt(line));
        }
        const text = decodeText(raw ?? '', line);
        const bytes = new TextEncoder().encode(text);
        if (bytes.length === 0)
            throw diag('A0006', [], lineAt(line));
        if (bytes.length > LIMITS.maxArrayLength) {
            throw diag('A0007', [LIMITS.maxArrayLength], lineAt(line));
        }
        return { id, op: 'arr', args: [...bytes].map((value) => ({ kind: 'u32', value })), text };
    }
    const parts = words ?? splitWords(lineText);
    const id = parts[0];
    const word = parts[1];
    const rest = parts.slice(2);
    if (id === undefined || word === undefined)
        throw diag('A0009', [], lineAt(line));
    if (!isValidIdentifier(id)) {
        const colon = id.endsWith(':') && isValidIdentifier(id.slice(0, -1));
        const snake = lowerName(id);
        throw diag('A0005', [id], {
            ...lineAt(line),
            ...(colon
                ? {
                    fix: `write '${id.slice(0, -1)}': a node id has no colon`,
                    applicability: 'exact',
                    edits: [lineEdit('colon', lineText, [id.slice(0, -1), word, ...rest].join(' '), line)],
                }
                : snake !== undefined && isValidIdentifier(snake)
                    ? {
                        fix: `write '${snake}' and use it everywhere: ids are lowercase letters, numbers and _`,
                    }
                    : {}),
        });
    }
    if (word.charCodeAt(0) === 91 || word.charCodeAt(0) === 40)
        return parseAggregateNode(id, parts, line, parameterUse);
    let nested = false;
    for (let k = 0; k < rest.length; k += 1) {
        const r = rest[k];
        if (r.charCodeAt(0) === 40 || r.charCodeAt(r.length - 1) === 41) {
            nested = true;
            break;
        }
    }
    if (nested)
        throw nestedError(id, [id, word], rest, lineText, line, 'parse');
    // `id F args…` with F a function name (not an op) is the direct form of `id call F args…`.
    const op = opOf(word);
    if (op === undefined && isDirectCallee(word))
        return { id, op: 'call', callee: word, args: operandsOf(rest, line, lineText, parameterUse) };
    if (op === undefined) {
        const lower = word.toLowerCase();
        const assign = word === '=' && rest.length > 0;
        const caseFix = lower !== word && (opOf(lower) !== undefined || isDirectCallee(lower));
        const symbol = Object.hasOwn(SYMBOL_OPS, word) ? SYMBOL_OPS[word] : undefined;
        const symbolFix = newFixes() && symbol !== undefined && rest.length === OP_ARITY[symbol];
        throw diag('A0011', [word], {
            ...lineAt(line),
            ...(symbolFix
                ? {
                    fix: `write \`${id} ${symbol} ${rest.join(' ')}\`: the op is written as a word, \`${symbol}\`, before its operands`,
                    applicability: 'exact',
                    edits: [lineEdit('symbol', lineText, replaceWord(lineText, word, symbol), line)],
                }
                : assign
                    ? {
                        fix: `write \`${[id, ...rest].join(' ')}\`: there is no \`=\`, the op follows the id`,
                        applicability: 'exact',
                        edits: [lineEdit('assign', lineText, [id, ...rest].join(' '), line)],
                    }
                    : caseFix
                        ? {
                            fix: `write '${lower}': ops and function names are lowercase`,
                            applicability: 'exact',
                            edits: [lineEdit('case', lineText, replaceWord(lineText, word, lower), line)],
                        }
                        : {
                            fix: `use one of ${OPS.join(' ')}, or call a function F defined above: \`${id} F args…\``,
                        }),
        });
    }
    if (op === 'loop') {
        const [pred, callee, ...args] = rest;
        if (pred === undefined ||
            !isValidFunctionName(pred) ||
            callee === undefined ||
            !isValidFunctionName(callee)) {
            throw diag('A0012', [], lineAt(line));
        }
        return { id, op, pred, callee, args: operandsOf(args, line, lineText, parameterUse) };
    }
    if (op === 'call' || op === 'fold') {
        const [callee, ...args] = rest;
        if (callee === undefined || !isValidFunctionName(callee)) {
            const lower = (callee ?? '').toLowerCase();
            const caseFix = callee !== undefined && lower !== callee && isValidFunctionName(lower);
            throw diag('A0013', [op, callee ?? ''], {
                ...lineAt(line),
                ...(caseFix
                    ? {
                        fix: `write '${lower}': function names are lowercase`,
                        applicability: 'exact',
                        edits: [lineEdit('case', lineText, replaceWord(lineText, callee, lower), line)],
                    }
                    : {}),
            });
        }
        return { id, op, callee, args: operandsOf(args, line, lineText, parameterUse) };
    }
    if (OP_ARITY[op] >= 0 && rest.length !== OP_ARITY[op]) {
        // an associative binary op written with more operands: show the chain that says it
        const chain = OP_ARITY[op] === 2 && rest.length > 2 && ASSOCIATIVE_OPS.has(op)
            ? `write exactly 2 operands after ${op}; to combine ${rest.length} operands chain two at a time: ${rest
                .slice(1)
                .map((r, i) => `${id}${i === rest.length - 2 ? '' : `t${i}`} ${op} ${i === 0 ? rest[0] : `${id}t${i - 1}`} ${r}`)
                .join(', then ')}`
            : undefined;
        // The chain is the left-to-right grouping `((a op b) op c) op d`, the same value for an associative op
        // whatever the grouping; it is exact when the checker accepts the rewritten lines (a clash of the fresh ids
        // with an id the function already has shows up there as a duplicate id, and `fix all` then stops).
        const chainLines = chain === undefined || !newFixes()
            ? undefined
            : rest.slice(1).map((r, i, all) => {
                const target = i === all.length - 1 ? id : `${id}t${i}`;
                return `${target} ${op} ${i === 0 ? rest[0] : `${id}t${i - 1}`} ${r}`;
            });
        throw diag('A0014', [op, OP_ARITY[op], rest.length], {
            ...lineAt(line),
            expected: String(OP_ARITY[op]),
            actual: String(rest.length),
            ...(chain === undefined ? {} : { fix: chain }),
            ...(chainLines === undefined
                ? {}
                : {
                    applicability: 'exact',
                    edits: [lineEdit('chain', lineText, chainLines.join('\n'), line)],
                }),
        });
    }
    if (OP_ARITY[op] < 0 && rest.length === 0)
        throw diag('A0015', [op], lineAt(line));
    return { id, op, args: operandsOf(rest, line, lineText, parameterUse) };
}
// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
/**
 * Parse A0 source text. Blank lines are discarded; comments (`#` to end of line) are kept
 * on the line they belong to (see `Comments`) for `formatSource` and never affect meaning.
 */
/** Node id for a `ret OP …` line: `retval`, or `retval2`, `retval3`… if taken. */
export function freshRetId(nodes) {
    const taken = new Set(nodes.map((n) => n.id));
    if (!taken.has('retval'))
        return 'retval';
    for (let k = 2;; k += 1)
        if (!taken.has(`retval${k}`))
            return `retval${k}`;
}
/**
 * Whether a `ret` line (split on whitespace) is `ret OP ARGS…` or `ret F ARGS…`: sugar for a
 * fresh node computing the value and `ret` of it. `ret NAME` alone is always the operand NAME.
 */
export function isRetNodeForm(parts) {
    const word = parts[1] ?? '';
    return parts.length > 2 && (opOf(word) !== undefined || isDirectCallee(word));
}
/** The error for a `ret` line with more than one word that is not `ret OP ARGS…`. */
export function retOperandError(parts, line, code) {
    const rest = parts.slice(1);
    const nested = rest.some((r) => r.includes('('));
    if (nested)
        return nestedError('ret', ['ret'], rest, parts.join(' '), line, code);
    const e = diag('A0030', [], line === undefined ? {} : { line });
    return code === e.code ? e : new A0Error(e.detail, e.line, { ...e.detailOf(), code });
}
export function parse(source) {
    // A UTF-16 unit is at most 3 UTF-8 bytes: a source that short cannot be over, and is not encoded to measure it.
    if (source.length * 3 > LIMITS.maxSourceBytes && utf8Length(source) > LIMITS.maxSourceBytes) {
        throw diag('A0016', [LIMITS.maxSourceBytes]);
    }
    const functions = [];
    const names = new Set();
    // One pass over the source, cut into lines as `source.split(/\r?\n/)` would (a `\r` before the
    // `\n` is dropped). Each line is scanned once: the comment start (a `#` outside a text literal),
    // the words of the code before it (`text.split(/\s+/)` of the trimmed code) and its bounds, so
    // neither the raw line nor an untrimmed copy is made, and a node line is not split again.
    const n = source.length;
    let pos = 0;
    let lineNo = 0;
    let pending = [];
    const next = () => {
        while (pos <= n) {
            const start = pos;
            let end = source.indexOf('\n', start);
            if (end < 0)
                end = n;
            pos = end + 1;
            lineNo += 1;
            if (end > start && source.charCodeAt(end - 1) === 13)
                end -= 1;
            const words = [];
            let quote = false;
            let at = -1;
            let word = -1; // start of the word being scanned, or -1 between words
            let lo = -1; // start of the first word
            let hi = -1; // end of the last word
            for (let k = start; k < end; k += 1) {
                const c = source.charCodeAt(k);
                if (c === 34) {
                    // A text literal: its words are split from the trimmed code below; here it is only
                    // skipped, so a `#` or space inside it is not taken for a comment or a word break.
                    quote = true;
                    if (word < 0)
                        word = k;
                    if (lo < 0)
                        lo = k;
                    for (k += 1; k < end; k += 1) {
                        const q = source.charCodeAt(k);
                        if (q === 92)
                            k += 1;
                        else if (q === 34)
                            break;
                    }
                    hi = k < end ? k + 1 : end;
                }
                else if (c === 35) {
                    at = k;
                    break;
                }
                else if ((c > 32 && c < 0x7f) || !isSpaceCode(c)) {
                    if (word < 0)
                        word = k;
                    if (lo < 0)
                        lo = k;
                    hi = k + 1;
                }
                else if (word >= 0) {
                    words.push(source.slice(word, k));
                    word = -1;
                }
            }
            let comment;
            if (at >= 0) {
                // The comment starts with `#`, so trimming its end never empties it.
                let ce = end;
                while (isSpaceCode(source.charCodeAt(ce - 1)))
                    ce -= 1;
                comment = source.slice(at, ce);
            }
            if (lo < 0) {
                if (comment !== undefined)
                    pending.push(comment);
                continue;
            }
            if (word >= 0)
                words.push(source.slice(word, hi));
            const text = words.length === 1 && !quote ? words[0] : source.slice(lo, hi);
            const leading = pending;
            pending = [];
            const comments = commentsOf(leading, comment);
            const parts = quote ? splitWords(text) : words;
            return comments === undefined
                ? { text, line: lineNo, words: parts, quote }
                : { text, line: lineNo, words: parts, quote, comments };
        }
        return undefined;
    };
    const uses = [];
    const useComments = [];
    let profile;
    let profileComments;
    let first = true;
    for (let cur = next(); cur !== undefined; cur = next()) {
        const head = cur.words;
        const atStart = first;
        first = false;
        if (head[0] === 'profile') {
            if (!atStart || head.length !== 2 || head[1] !== 'strict')
                throw diag('A0031', [], { line: cur.line });
            profile = 'strict';
            profileComments = cur.comments;
            continue;
        }
        if (head[0] === 'use') {
            const m = /^use\s+"([^"\\]+)"$/.exec(cur.text);
            if (m === null || functions.length > 0)
                throw diag('A0017', [], { line: cur.line });
            uses.push(m[1]);
            useComments.push(cur.comments);
            continue;
        }
        if (head[0] !== 'fn')
            throw diag('A0018', [head[0] ?? ''], { line: cur.line });
        const name = head[1];
        if (name === undefined || !isValidFunctionName(name)) {
            const snake = lowerName(name ?? '');
            throw diag('A0019', [name ?? ''], {
                line: cur.line,
                ...(snake !== undefined && isValidFunctionName(snake)
                    ? {
                        fix: `write '${snake}' and use it everywhere: names are lowercase letters, numbers and _`,
                    }
                    : {}),
            });
        }
        if (names.has(name))
            throw diag('A0020', [name], { line: cur.line });
        const arrow = head.indexOf('->');
        const inferParams = arrow === -1 && head.length === 2;
        if (!inferParams && (arrow < 2 || arrow !== head.length - 2)) {
            throw diag('A0023', [], { line: cur.line });
        }
        const params = inferParams ? [] : head.slice(2, arrow).map((t) => parseType(t, cur.line, cur.text));
        if (params.length > LIMITS.maxParams)
            throw diag('A0024', [], { line: cur.line });
        const result = inferParams ? 'u32' : parseType(head[arrow + 1] ?? '', cur.line, cur.text);
        const parameterUse = inferParams ? { count: 0 } : undefined;
        const header = cur.comments;
        const nodes = [];
        let ret;
        let retComments;
        let endComments;
        let closed = false;
        const specs = new SpecBuilder(name);
        for (let body = next(); body !== undefined; body = next()) {
            const parts = body.words;
            const first = parts[0];
            // Spec lines stand between the header and the first node (or `ret`).
            if (nodes.length === 0 && ret === undefined) {
                const word = specWordOf(body.text);
                if (word !== undefined) {
                    specs.add(word, body.text.slice(word.length).trim(), body.line, body.comments);
                    continue;
                }
            }
            else if (isExampleLine(body.text)) {
                // An example after the first node is unambiguous (the arrow); it joins the others under the
                // header, so the canonical text is the same whichever place the writer chose.
                specs.add('ex', body.text.slice(2).trim(), body.line, body.comments);
                continue;
            }
            if (first === 'ret') {
                retComments = body.comments;
                if (isRetNodeForm(parts)) {
                    // `ret OP ARGS…` is sugar for a fresh node followed by `ret` of it.
                    const id = freshRetId(nodes);
                    try {
                        nodes.push(parseNodeOf(`${id} ${parts.slice(1).join(' ')}`, body.line, undefined, parameterUse));
                    }
                    catch (e) {
                        // The failing line is the synthesised `retval OP …`, not the source line: no edits.
                        throw e instanceof A0Error && e.edits.length > 0 ? e.withEdits([], 'maybe') : e;
                    }
                    ret = { kind: 'node', id };
                }
                else {
                    if (parts.length !== 2)
                        throw retOperandError(parts, body.line, 'parse');
                    ret = parseOperand(parts[1] ?? '', body.line, body.text, parameterUse);
                }
                const endLine = next();
                if (endLine === undefined || endLine.text !== 'end') {
                    // A missing `end` before the next function (or the end of the file) is added.
                    const addable = endLine === undefined || endLine.words[0] === 'fn';
                    throw diag('A0025', [], {
                        line: endLine?.line ?? body.line,
                        ...(addable
                            ? {
                                applicability: 'exact',
                                edits: [
                                    lineEdit('end', body.text, `${normalizeLine(body.text)}\nend`, body.line),
                                ],
                            }
                            : {}),
                    });
                }
                endComments = endLine.comments;
                closed = true;
                break;
            }
            if (first === 'end' || first === 'fn') {
                const last = nodes[nodes.length - 1]?.id;
                // The last node is nearly always the result: say the line to write (a suggestion, not exact: the result type is the reader's call).
                throw diag('A0026', [first], {
                    line: body.line,
                    ...(last === undefined
                        ? {}
                        : {
                            fix: `a function is \`fn ...\` then instruction lines, \`ret X\`, \`end\`: write \`ret ${last}\` before \`${first}\` if '${last}' is the result (else \`ret\` the node that is), and start the next \`fn\` after that \`end\``,
                        }),
                });
            }
            if (nodes.length >= LIMITS.maxNodesPerFunction) {
                throw diag('A0027', [], { line: body.line });
            }
            const node = parseNodeOf(body.text, body.line, body.quote ? undefined : parts, parameterUse);
            nodes.push(body.comments === undefined ? node : { ...node, comments: body.comments });
        }
        if (!closed || ret === undefined)
            throw diag('A0028', [name]);
        if (functions.length >= LIMITS.maxFunctions)
            throw diag('A0029');
        names.add(name);
        const spec = specs.build();
        if (inferParams) {
            let count = parameterUse?.count ?? 0;
            const see = (a) => { if (a.kind === 'param')
                count = Math.max(count, a.index + 1); };
            for (const n of [spec?.pre, spec?.post])
                if (n)
                    for (const a of n.args)
                        see(a);
            if (count > LIMITS.maxParams)
                throw diag('A0024', [], { line: cur.line });
            for (let k = 0; k < count; k += 1)
                params.push('u32');
        }
        functions.push({
            name,
            params,
            result,
            nodes,
            ret,
            ...(spec === undefined ? {} : { spec }),
            ...(header === undefined ? {} : { comments: header }),
            ...(retComments === undefined ? {} : { retComments }),
            ...(endComments === undefined ? {} : { endComments }),
        });
    }
    // Comments after the last `end` travel with the last function, so edits that rebuild the
    // program keep them.
    const last = functions[functions.length - 1];
    if (last !== undefined && pending.length > 0)
        functions[functions.length - 1] = { ...last, afterComments: pending };
    return {
        functions,
        ...(profile === undefined ? {} : { profile }),
        ...(profileComments === undefined ? {} : { profileComments }),
        uses,
        ...(useComments.some((c) => c !== undefined) ? { useComments } : {}),
        ...(last === undefined && pending.length > 0 ? { tailComments: pending } : {}),
    };
}
function commentsOf(leading, trailing) {
    if (leading.length === 0 && trailing === undefined)
        return undefined;
    return {
        ...(leading.length > 0 ? { leading } : {}),
        ...(trailing === undefined ? {} : { trailing }),
    };
}
// ---------------------------------------------------------------------------
// Validation and type inference
// ---------------------------------------------------------------------------
function operandType(operand, fn, types, defined, where) {
    switch (operand.kind) {
        case 'u32':
            return 'u32';
        case 'bool':
            return 'bool';
        case 'param': {
            const t = fn.params[operand.index];
            if (t === undefined) {
                const n = fn.params.length;
                const sig = `a \`fn ${fn.name} ...\` block with the parameter in its signature`;
                throw diag('A0105', [where, operand.index], {
                    fix: n === 0
                        ? `${fn.name} has no parameters: add them with ${sig}`
                        : `${fn.name} has ${n} parameter${n === 1 ? '' : 's'} (p0..p${n - 1}): use one of them, or add the parameter with ${sig}`,
                });
            }
            return t;
        }
        case 'node': {
            if (!defined.has(operand.id)) {
                const node = where.slice(fn.name.length + 1);
                const later = fn.nodes.some((n) => n.id === operand.id);
                const guess = later ? undefined : spellingSuggestion(operand.id, defined);
                throw diag('A0101', [where, operand.id], {
                    ...(later
                        ? {
                            fix: `'${operand.id}' is defined on a later line of ${fn.name}: move it above ${where}`,
                        }
                        : guess === undefined
                            ? {}
                            : {
                                fix: `did you mean '${guess}'?`,
                                edits: [
                                    { op: 'rename', rule: 'typo', fn: fn.name, node, from: operand.id, to: guess },
                                ],
                            }),
                });
            }
            const t = types.get(operand.id);
            if (t === undefined)
                throw diag('A0792', [where, operand.id]);
            return t;
        }
    }
}
/**
 * Fix text for a fold/loop whose body does not fit its operands. The body is called as
 * `F(state, i, extras...)` once per step, so the operands fix one header,
 * `fn F S u32 X... -> S` (S the initial state's type, X the extras'). The text names that
 * header, the body's actual header, and the operand shape the actual header accepts.
 */
function foldBodyFix(op, callee, init, extra) {
    const header = (params, result) => `\`fn ${[callee.name, ...params.map(formatType)].join(' ')} -> ${formatType(result)}\``;
    const head = op === 'loop' ? `loop P ${callee.name}` : `fold ${callee.name}`;
    const wanted = header([init, 'u32', ...extra], init);
    const actual = header(callee.params, callee.result);
    const [stateT, indexT, ...extraT] = callee.params;
    const shape = stateT !== undefined &&
        indexT !== undefined &&
        typeEquals(indexT, 'u32') &&
        typeEquals(callee.result, stateT)
        ? `; as declared, write \`${[head, 'N', 'S', ...extraT.map((_, i) => `X${i}`)].join(' ')}\` with S a ${formatType(stateT)}${extraT.length === 0 ? ' and no extras' : ` and extras ${extraT.map(formatType).join(' ')}`}`
        : '';
    return `each step runs state = ${callee.name}(state, i, extras...) where i is the u32 step index, not an element, so these operands need ${wanted}; ${callee.name} is ${actual}${shape}`;
}
function expect(actual, wanted, where) {
    if (!typeEquals(actual, wanted)) {
        throw diag('A0201', [where, formatType(wanted), formatType(actual)], {
            expected: formatType(wanted),
            actual: formatType(actual),
        });
    }
}
/** The declared result type disagrees with what `ret` returns: change the value or the signature. */
function expectResult(fn, actual) {
    if (typeEquals(actual, fn.result))
        return;
    const wanted = formatType(fn.result);
    const got = formatType(actual);
    const sig = `fn ${[fn.name, ...fn.params.map(formatType)].join(' ')} -> ${got}`;
    const bool = actual === 'bool' && fn.result === 'u32' ? ' (`select c 1 0` turns a bool c into a u32)' : '';
    throw diag('A0201', [`${fn.name}.ret`, wanted, got], {
        expected: wanted,
        actual: got,
        fix: `return a ${wanted} value${bool}, or change the declared result: send the function with its header as \`${sig}\``,
    });
}
/** Infer the result type of an operation given operand types; throws on mismatch. */
export function resultType(op, argTypes, where) {
    const a = argTypes[0];
    const b = argTypes[1];
    const c = argTypes[2];
    if (a === undefined)
        throw diag('A0202', [where]);
    switch (op) {
        case 'mov':
            return a;
        case 'and':
        case 'or':
        case 'xor':
            // Bitwise on u32, logical on bool: both operands must share the type.
            if (b === undefined)
                throw diag('A0202', [where]);
            if (a === 'bool') {
                expect(b, 'bool', where);
                return 'bool';
            }
            expect(a, 'u32', where);
            expect(b, 'u32', where);
            return 'u32';
        case 'add':
        case 'sub':
        case 'mul':
        case 'shl':
        case 'shr':
        case 'div':
        case 'rem':
            if (b === undefined)
                throw diag('A0202', [where]);
            expect(a, 'u32', where);
            expect(b, 'u32', where);
            return 'u32';
        case 'eq':
        case 'ne':
            if (b === undefined)
                throw diag('A0202', [where]);
            if (a === 'bool') {
                if (typeEquals(b, 'u32')) {
                    // A bool compared with a number (`eq c 1`): A0 has no truthiness, so say how to write it.
                    throw diag('A0201', [where, 'bool', 'u32'], {
                        expected: 'bool',
                        actual: 'u32',
                        fix: `a bool is compared only with a bool: for \`${op} C 1\` use the bool C itself (or \`${op} C true\`), and turn a u32 X into a bool with \`ne X 0\``,
                    });
                }
                expect(b, 'bool', where);
                return 'bool';
            }
            expect(a, 'u32', where);
            expect(b, 'u32', where);
            return 'bool';
        case 'lt':
        case 'le':
        case 'gt':
        case 'ge':
            if (b === undefined)
                throw diag('A0202', [where]);
            expect(a, 'u32', where);
            expect(b, 'u32', where);
            return 'bool';
        case 'select':
            if (b === undefined || c === undefined)
                throw diag('A0202', [where]);
            if (typeEquals(a, 'u32')) {
                // A u32 condition (`c and p1 1` then `select c …`): A0 has no truthiness.
                throw diag('A0201', [where, 'bool', 'u32'], {
                    expected: 'bool',
                    actual: 'u32',
                    fix: 'the select condition is a bool and A0 has no truthiness: for a u32 X write `t ne X 0` above (true when X is nonzero) and select on t',
                });
            }
            expect(a, 'bool', where);
            if (!typeEquals(b, c)) {
                throw diag('A0203', [where, formatType(b), formatType(c)]);
            }
            if (containsIo(b))
                throw diag('A0204', [where]);
            return b;
        case 'arr': {
            for (const [i, t] of argTypes.entries())
                expect(t, a, `${where} element ${i}`);
            if (containsIo(a))
                throw diag('A0205', [where]);
            const t = { kind: 'arr', length: argTypes.length, elem: a };
            if (bitWidth(t) > LIMITS.maxAggregateBits)
                throw diag('A0206', [where]);
            return t;
        }
        case 'rec': {
            const t = { kind: 'rec', fields: [...argTypes] };
            if (argTypes.filter(containsIo).length > 1)
                throw diag('A0207', [where]);
            if (!containsIo(t) && bitWidth(t) > LIMITS.maxAggregateBits)
                throw diag('A0206', [where]);
            return t;
        }
        case 'read':
            expect(a, 'io', `${where} token`);
            return { kind: 'rec', fields: ['u32', 'io'] };
        case 'write':
            if (b === undefined)
                throw diag('A0202', [where]);
            expect(a, 'io', `${where} token`);
            expect(b, 'u32', `${where} value`);
            return 'io';
        case 'puts':
            if (b === undefined)
                throw diag('A0202', [where]);
            expect(a, 'io', `${where} token`);
            if (isPrimitive(b) || b.kind !== 'arr' || b.elem !== 'u32') {
                throw diag('A0208', [where, formatType(b)]);
            }
            return 'io';
        case 'cadd':
        case 'csub':
        case 'cmul':
        case 'cdiv':
        case 'crem':
            if (b === undefined)
                throw diag('A0202', [where]);
            expect(a, 'u32', where);
            expect(b, 'u32', where);
            return { kind: 'rec', fields: ['u32', 'bool'] };
        case 'cget':
            if (b === undefined)
                throw diag('A0202', [where]);
            if (isPrimitive(a) || a.kind !== 'arr' || a.elem !== 'u32')
                throw diag('A0209', [where, formatType(a)], {
                    fix: 'cget reads an array of u32: `cget A I` gives (value, in-range)',
                });
            expect(b, 'u32', `${where} index`);
            return { kind: 'rec', fields: ['u32', 'bool'] };
        case 'get':
            if (b === undefined)
                throw diag('A0202', [where]);
            if (isPrimitive(a) || a.kind !== 'arr')
                throw diag('A0209', [where, formatType(a)], {
                    ...(!isPrimitive(a) && a.kind === 'rec'
                        ? { fix: 'records use at with a literal field index: `at R K` (get is for arrays)' }
                        : {}),
                });
            expect(b, 'u32', `${where} index`);
            return a.elem;
        case 'set':
            if (b === undefined || c === undefined)
                throw diag('A0202', [where]);
            if (isPrimitive(a) || a.kind !== 'arr')
                throw diag('A0210', [where, formatType(a)], {
                    ...(!isPrimitive(a) && a.kind === 'rec'
                        ? { fix: 'records use put with a literal field index: `put R K V` (set is for arrays)' }
                        : {}),
                });
            expect(b, 'u32', `${where} index`);
            expect(c, a.elem, `${where} element`);
            return a;
        case 'at':
        case 'put':
            throw diag('A0211', [where, op]);
        case 'call':
        case 'fold':
        case 'loop':
            throw diag('A0212', [where, op]);
    }
}
/** The error for a fold body or loop predicate naming a function that is not defined above. */
function unknownFunction(id, where, fn, node, name, scope, later, args) {
    const guess = spellingSuggestion(name, scope.keys());
    const below = later?.has(name) === true;
    return diag(id, [where, ...args], {
        ...(below
            ? {
                fix: `'${name}' is defined below ${fn.name}: callees must be defined above their callers, so move '${name}' above ${fn.name}`,
            }
            : guess === undefined
                ? {
                    fix: `'${name}' is no function defined above ${fn.name}: add a \`fn ${name} ...\` block that defines it (callees come first; a fold or loop body takes the state and the u32 step index), or name an existing function`,
                }
                : {
                    fix: `did you mean '${guess}'?`,
                    edits: [
                        { op: 'rename', rule: 'typo', fn: fn.name, node: node.id, from: name, to: guess },
                    ],
                }),
    });
}
/*
 * The node kinds that need more than an operand check each have their own function, apart from the
 * per-node loop of `validateFunction`: the loop stays small, and so does the code an optimizing
 * compiler builds for it (a fresh `a0 check` process waits for that compile before it exits).
 */
// Linearity: an io-carrying value is consumed at most once. `at` of a field without io
// only reads; `at` of the io-carrying field takes the token out of the record, which may
// then only read its other fields or get that field back with `put` (anything else would
// use the token twice).
function checkLinearity(node, argTypes, where, consumed, taken) {
    for (let k = 0; k < node.args.length; k += 1) {
        const arg = node.args[k];
        const t = argTypes[k];
        if (!containsIo(t))
            continue;
        const key = arg.kind === 'param' ? `p${arg.index}` : arg.kind === 'node' ? arg.id : '';
        const field = node.args[1]?.kind === 'u32' ? node.args[1].value : -1;
        if (node.op === 'at' && k === 0) {
            const ft = !isPrimitive(t) && t.kind === 'rec' ? t.fields[field] : undefined;
            if (ft === undefined || !containsIo(ft))
                continue;
            if (consumed.has(key))
                throw diag('A0310', [where, key]);
            if (taken.has(key))
                throw diag('A0311', [where, taken.get(key), key], {
                    fix: `use the value that \`at\` returned, or put a token back first with \`put ${key} ${taken.get(key)} <io>\``,
                });
            taken.set(key, field);
            continue;
        }
        if (consumed.has(key))
            throw diag('A0310', [where, key]);
        const out = taken.get(key);
        if (out !== undefined && !(node.op === 'put' && k === 0 && field === out))
            throw diag('A0312', [where, key, out], {
                fix: `read the other fields first, or put the token back with \`put ${key} ${out} <io>\` and use that record`,
            });
        consumed.add(key);
    }
}
/** The type of an `at` or `put` node (a record field read or write). */
function recordOpType(node, argTypes, where) {
    const [recT, idx] = argTypes;
    const index = node.args[1];
    if (recT === undefined || isPrimitive(recT) || recT.kind !== 'rec') {
        throw diag('A0220', [where, node.op, recT === undefined ? 'nothing' : formatType(recT)], {
            ...(recT !== undefined && !isPrimitive(recT) && recT.kind === 'arr'
                ? {
                    fix: `arrays use ${node.op === 'at' ? 'get: `get A I`' : 'set: `set A I V`'} (${node.op} is for records)`,
                    // `at`/`put` on an array has one meaning: `get`/`set` at that index (the index wraps by the length).
                    applicability: 'exact',
                    edits: [
                        lineEdit('array-op', formatNode(node), formatNode({ ...node, op: node.op === 'at' ? 'get' : 'set' })),
                    ],
                }
                : {}),
        });
    }
    if (index === undefined || index.kind !== 'u32' || idx !== 'u32') {
        throw diag('A0221', [where, node.op]);
    }
    const field = recT.fields[index.value];
    if (field === undefined)
        throw diag('A0222', [where, index.value, formatType(recT)]);
    if (node.op === 'put')
        expect(argTypes[2], field, `${where} field value`);
    return node.op === 'at' ? field : recT;
}
/** The type of a `call` node; records the callee and raises the iteration bounds. */
function callType(fn, node, argTypes, where, scope, later, calls, iter) {
    const callee = scope.get(node.callee ?? '');
    if (callee === undefined) {
        const name = node.callee ?? '';
        // `a mod x y` is `a rem x y`: every A0 number is a u32, where remainder and modulo agree.
        // Exact when the line is that two-operand op and no operand is a node of the same name.
        if ((name === 'mod' || name === 'umod') &&
            later?.has(name) !== true &&
            node.args.length === 2 &&
            node.args.every((a) => a.kind !== 'node' || a.id !== name)) {
            throw diag('A0102', [where, name], {
                fix: `write \`${node.id} rem …\`: the remainder op is \`rem\` (on u32 it is the modulo)`,
                applicability: 'exact',
                edits: [{ op: 'rename', rule: 'mod', fn: fn.name, node: node.id, from: name, to: 'rem' }],
            });
        }
        const written = `${node.id} ${name} ${node.args.map(formatOperand).join(' ')}`.trimEnd();
        const clash = (n) => fn.nodes.some((m) => m.id === n);
        // `x not b` on a bool is `x xor b true`: the only meaning `not` has on one bool operand.
        if (newFixes() &&
            name === 'not' &&
            later?.has(name) !== true &&
            node.args.length === 1 &&
            argTypes[0] === 'bool') {
            throw diag('A0102', [where, name], {
                fix: `write \`${node.id} xor ${formatOperand(node.args[0])} true\`: there is no \`not\`, flipping a bool is xor with true`,
                applicability: 'exact',
                edits: [
                    lineEdit('not', written, `${node.id} xor ${formatOperand(node.args[0])} true`),
                ],
            });
        }
        // `x max a b` and `x min a b` on two u32 are a compare and a select: `t gt a b` then `x select t a b`
        // (`lt` for min); the compare gets a fresh id.
        if (newFixes() &&
            (name === 'max' || name === 'min') &&
            later?.has(name) !== true &&
            node.args.length === 2 &&
            argTypes[0] === 'u32' &&
            argTypes[1] === 'u32') {
            let k = 0;
            while (clash(`${node.id}t${k}`))
                k += 1;
            const fresh = `${node.id}t${k}`;
            const [a, b] = node.args.map(formatOperand);
            const cmp = name === 'max' ? 'gt' : 'lt';
            throw diag('A0102', [where, name], {
                fix: `write \`${fresh} ${cmp} ${a} ${b}\` then \`${node.id} select ${fresh} ${a} ${b}\`: there is no \`${name}\`, it is a compare and a select`,
                applicability: 'exact',
                edits: [
                    lineEdit(name, written, `${fresh} ${cmp} ${a} ${b}\n${node.id} select ${fresh} ${a} ${b}`),
                ],
            });
        }
        // Other spellings of an op that models write (`sel c a b`, `lte a b`): the op they name, exact when the
        // operand count is the op's own and no operand is a node of the same name.
        const spelled = Object.hasOwn(OP_SPELLINGS, name) ? OP_SPELLINGS[name] : undefined;
        if (spelled !== undefined &&
            later?.has(name) !== true &&
            node.args.length === spelled.arity &&
            node.args.every((a) => a.kind !== 'node' || a.id !== name)) {
            throw diag('A0102', [where, name], {
                fix: `write \`${node.id} ${spelled.op} …\`: '${name}' is not an op, the op is \`${spelled.op}\`${spelled.note}`,
                applicability: 'exact',
                edits: [
                    {
                        op: 'rename',
                        rule: 'alias',
                        fn: fn.name,
                        node: node.id,
                        from: name,
                        to: spelled.op,
                    },
                ],
            });
        }
        const guess = spellingSuggestion(name, [...OPS, ...Object.keys(OP_ALIASES), ...scope.keys()]);
        // Names models write for an op that has no single exact rewrite: say what to write instead.
        const named = newFixes() && Object.hasOwn(NAMED_HINTS, name) ? NAMED_HINTS[name] : undefined;
        throw diag('A0102', [where, name], {
            fix: later?.has(name) === true
                ? `'${name}' is defined below ${fn.name}: callees must be defined above their callers, so move '${name}' above ${fn.name}`
                : named !== undefined
                    ? named
                    : guess !== undefined
                        ? `did you mean '${guess}'?`
                        : `'${name}' is neither an op nor a function defined above ${fn.name}: define it above, or use one of ${OPS.join(' ')}; rarely needed: text "s", loop P F n s a... (F while P(state,i,a...) holds, at most n times), io values are one linear token used once: read t -> (u32,io), write t v -> io, puts t a -> io`,
            ...(guess === undefined || later?.has(name) === true || named !== undefined
                ? {}
                : {
                    edits: [
                        {
                            op: 'rename',
                            rule: 'typo',
                            fn: fn.name,
                            node: node.id,
                            from: name,
                            to: guess,
                        },
                    ],
                }),
        });
    }
    if (argTypes.length !== callee.params.length) {
        throw diag('A0219', [where, callee.name, callee.params.length, argTypes.length]);
    }
    const params = callee.params;
    for (let i = 0; i < params.length; i += 1) {
        const t = params[i];
        // The label is built only for the diagnostic.
        if (!typeEquals(argTypes[i], t))
            expect(argTypes[i], t, `${where} argument ${i}`);
    }
    calls.set(callee.name, callee);
    iter.static = Math.max(iter.static, callee.staticIterations);
    iter.literal = Math.max(iter.literal, callee.literalIterations);
    return callee.result;
}
/** The type of a `fold` or `loop` node; records the body (and predicate) and raises the iteration bounds. */
function foldType(fn, node, argTypes, where, scope, later, calls, iter) {
    const callee = scope.get(node.callee ?? '');
    if (callee === undefined) {
        const name = node.callee ?? '';
        throw unknownFunction('A0103', where, fn, node, name, scope, later, [node.op, name]);
    }
    // fold f n s a...  with f : (T, u32, A...) -> T
    // loop p f n s a... additionally p : (T, u32, A...) -> bool with identical parameters
    const [count, init, ...extra] = argTypes;
    if (count === undefined || init === undefined) {
        throw diag('A0216', [where]);
    }
    expect(count, 'u32', `${where} trip count`);
    // Every body mismatch names the step's expected header and the call shape it implies.
    // (Built only when a diagnostic needs it: it is a pure function of these operands.)
    const fixOf = () => foldBodyFix(node.op === 'loop' ? 'loop' : 'fold', callee, init, extra);
    const expectBody = (actual, wanted, what) => {
        if (!typeEquals(actual, wanted))
            throw diag('A0213', [where, what, formatType(wanted), formatType(actual)], {
                expected: formatType(wanted),
                actual: formatType(actual),
                fix: fixOf(),
            });
    };
    const [stateT, indexT, ...extraT] = callee.params;
    if (stateT === undefined || indexT === undefined)
        throw diag('A0214', [where, callee.name], { fix: fixOf() });
    expectBody(indexT, 'u32', 'body index parameter');
    expectBody(init, stateT, 'initial state');
    expectBody(callee.result, stateT, 'body result');
    if (extra.length !== extraT.length)
        throw diag('A0215', [where, callee.name, extraT.length, extra.length], { fix: fixOf() });
    for (let i = 0; i < extraT.length; i += 1) {
        const t = extraT[i];
        if (!typeEquals(extra[i], t))
            expectBody(extra[i], t, `extra argument ${i}`);
    }
    calls.set(callee.name, callee);
    if (node.op === 'loop') {
        const pred = scope.get(node.pred ?? '');
        if (pred === undefined) {
            const name = node.pred ?? '';
            throw unknownFunction('A0104', where, fn, node, name, scope, later, [name]);
        }
        expect(pred.result, 'bool', `${where} predicate result`);
        if (pred.params.length !== callee.params.length ||
            pred.params.some((t, i) => !typeEquals(t, callee.params[i]))) {
            throw diag('A0217', [where, pred.name, callee.name]);
        }
        calls.set(pred.name, pred);
    }
    const countOp = node.args[0];
    const trips = countOp?.kind === 'u32' ? countOp.value : 2 ** 32;
    iter.static = Math.max(iter.static, trips * callee.staticIterations);
    if (countOp?.kind === 'u32') {
        iter.literal = Math.max(iter.literal, trips * callee.literalIterations);
        if (iter.literal > LIMITS.maxStaticIterations) {
            throw diag('A0218', [where, iter.literal, LIMITS.maxStaticIterations]);
        }
    }
    else {
        iter.literal = Math.max(iter.literal, callee.literalIterations);
    }
    return stateT;
}
/**
 * Validate one function. `scope` holds the functions defined earlier in the program
 * (the only legal call targets); a function cannot call itself or a later function. `later`
 * (the names defined after it) only sharpens the fix of an unknown callee.
 */
export function validateFunction(fn, scope = new Map(), later, profile) {
    if (!isValidFunctionName(fn.name))
        throw diag('A0301', [fn.name]);
    if (fn.params.length > LIMITS.maxParams)
        throw diag('A0315', [fn.name]);
    if (fn.nodes.length > LIMITS.maxNodesPerFunction)
        throw diag('A0316', [fn.name]);
    const types = new Map();
    const defined = new Set();
    const calls = new Map();
    const consumed = new Set();
    /** Records whose io-carrying field (the value) was taken out by `at`. */
    const taken = new Map();
    const iter = { static: 1, literal: 1 };
    if (fn.params.filter(containsIo).length > 1) {
        throw diag('A0309', [fn.name]);
    }
    for (const node of fn.nodes) {
        const where = `${fn.name}.${node.id}`;
        if (!isValidIdentifier(node.id))
            throw diag('A0302', [where]);
        if (defined.has(node.id))
            throw diag('A0303', [where]);
        const hasCallee = node.op === 'call' || node.op === 'fold' || node.op === 'loop';
        if (hasCallee !== (node.callee !== undefined)) {
            throw diag('A0304', [where]);
        }
        if ((node.op === 'loop') !== (node.pred !== undefined)) {
            throw diag('A0305', [where]);
        }
        if (!hasCallee && OP_ARITY[node.op] >= 0 && node.args.length !== OP_ARITY[node.op]) {
            throw diag('A0306', [where]);
        }
        if (OP_ARITY[node.op] < 0 && !hasCallee && node.args.length === 0) {
            throw diag('A0307', [where, node.op]);
        }
        const args = node.args;
        const argTypes = [];
        for (let k = 0; k < args.length; k += 1)
            argTypes.push(operandType(args[k], fn, types, defined, where));
        for (let k = 0; k < args.length; k += 1) {
            const arg = args[k];
            if (arg.kind === 'u32' &&
                (!Number.isInteger(arg.value) || arg.value < 0 || arg.value > U32_MAX)) {
                throw diag('A0308', [where]);
            }
        }
        checkLinearity(node, argTypes, where, consumed, taken);
        if (node.op === 'at' || node.op === 'put') {
            types.set(node.id, recordOpType(node, argTypes, where));
        }
        else if (node.op === 'call') {
            types.set(node.id, callType(fn, node, argTypes, where, scope, later, calls, iter));
        }
        else if (node.op === 'fold' || node.op === 'loop') {
            types.set(node.id, foldType(fn, node, argTypes, where, scope, later, calls, iter));
        }
        else {
            types.set(node.id, resultType(node.op, argTypes, where));
        }
        defined.add(node.id);
    }
    const retType = operandType(fn.ret, fn, types, defined, `${fn.name}.ret`);
    expectResult(fn, retType);
    if (containsIo(retType)) {
        const key = fn.ret.kind === 'param' ? `p${fn.ret.index}` : fn.ret.kind === 'node' ? fn.ret.id : '';
        if (consumed.has(key))
            throw diag('A0314', [fn.name, key]);
        if (taken.has(key))
            throw diag('A0313', [fn.name, key, taken.get(key)], {
                fix: `return the record with the token put back: \`put ${key} ${taken.get(key)} <io>\``,
            });
    }
    // The profile comes from the program being validated, never from an earlier typing of `fn`.
    const { profile: _earlier, ...base } = fn;
    return {
        ...base,
        ...(profile === 'strict' ? { profile } : {}),
        types,
        calls,
        staticIterations: iter.static,
        literalIterations: iter.literal,
    };
}
/** Only objects `validate` itself produced are here: a spread copy of a typed function is not. */
const typingInputs = new WeakMap();
function specCallees(fn) {
    const out = [];
    for (const n of [fn.spec?.pre, fn.spec?.post]) {
        if (n === undefined)
            continue;
        if (n.callee !== undefined)
            out.push(n.callee);
        if (n.pred !== undefined)
            out.push(n.pred);
    }
    return out;
}
let reuseEnabled = true;
/** False inside `withoutReuse`: no typed result, canonical text or revision is remembered or reused. */
export const reusing = () => reuseEnabled;
/**
 * Run `run` with nothing reused: every function is typed, formatted and hashed again, as before validation
 * was incremental. The reference for the differential tests and the baseline of tools/edit-incremental.ts.
 */
export function withoutReuse(run) {
    const was = reuseEnabled;
    reuseEnabled = false;
    try {
        return run();
    }
    finally {
        reuseEnabled = was;
    }
}
/** The typed result of `fn` from an earlier validation, if it is still exactly what validating it here gives. */
function reusable(fn, scope, profile) {
    if (!reuseEnabled)
        return undefined;
    const typed = fn;
    const inputs = typingInputs.get(typed);
    if (inputs === undefined || inputs.profile !== profile)
        return undefined;
    for (const [name, callee] of inputs.deps)
        if (scope.get(name) !== callee)
            return undefined;
    return typed;
}
/**
 * Validate a whole program. Incremental by identity: a function that is a typed result of an
 * earlier `validate` (an edit passes every unchanged function back as it received it), under the
 * same profile, whose every resolved callee is the same object in this program, is reused as is;
 * only the functions whose text changed and the functions that (transitively) call them are typed
 * again. The result, and the first diagnostic of a program that fails, equal a validation from scratch.
 */
export function validate(program) {
    if (program.functions.length > LIMITS.maxFunctions)
        throw diag('A0029');
    const byName = new Map();
    const functions = [];
    const profile = program.profile === 'strict' ? 'strict' : undefined;
    // Last index of each name: a name is defined below function k when its last index is above k.
    // One map for the whole program, where a set of the remaining names per function was quadratic.
    let lastIndex;
    for (const [k, fn] of program.functions.entries()) {
        if (byName.has(fn.name))
            throw diag('A0021', [fn.name]);
        const kept = reusable(fn, byName, profile);
        if (kept !== undefined) {
            byName.set(fn.name, kept);
            functions.push(kept);
            continue;
        }
        lastIndex ??= new Map(program.functions.map((f, j) => [f.name, j]));
        const index = lastIndex;
        const later = { has: (name) => (index.get(name) ?? -1) > k };
        const typed = validateFunction(fn, byName, later, profile);
        // Spec lines are checked once the function is typed, against its callees (all above it).
        if (typed.spec !== undefined)
            verifySpec(typed, byName);
        const deps = new Map(typed.calls);
        for (const name of specCallees(typed)) {
            const callee = byName.get(name);
            if (callee !== undefined)
                deps.set(name, callee);
        }
        typingInputs.set(typed, { profile, deps });
        byName.set(fn.name, typed);
        functions.push(typed);
    }
    return {
        ...(program.profile === 'strict' ? { profile: program.profile } : {}),
        functions,
        byName,
    };
}
// ---------------------------------------------------------------------------
// Printing (canonical source form)
// ---------------------------------------------------------------------------
/** Bare headers mean u32 parameters through the highest referenced position and u32 result. */
function sourceHeader(fn) {
    let count = 0;
    const see = (a) => { if (a.kind === 'param')
        count = Math.max(count, a.index + 1); };
    if (fn.result === 'u32' && fn.params.every(t => t === 'u32')) {
        for (const n of fn.nodes)
            for (const a of n.args)
                see(a);
        see(fn.ret);
        for (const n of [fn.spec?.pre, fn.spec?.post])
            if (n)
                for (const a of n.args)
                    see(a);
        if (count === fn.params.length)
            return `fn ${fn.name}`;
    }
    const type = (t) => formatType(t).replaceAll('u32', '_');
    const params = fn.params.map(type);
    return `fn ${fn.name}${params.length ? ' ' + params.join(' ') : ''} -> ${type(fn.result)}`;
}
export function formatOperand(operand) {
    switch (operand.kind) {
        case 'node':
            return operand.id;
        case 'param':
            return operand.index < 26 ? String.fromCharCode(65 + operand.index) : `p${operand.index}`;
        case 'u32':
            return String(operand.value);
        case 'bool':
            return operand.value ? 'true' : 'false';
    }
}
export function formatNode(node) {
    if (node.op === 'arr' && node.text !== undefined)
        return `${node.id} ${formatTextLiteral(node.text)}`;
    if (node.op === 'arr' || node.op === 'rec') {
        return node.id + ' ' + formatAggregate(node.op, node.args, formatOperand);
    }
    const pred = node.op === 'loop' ? ` ${node.pred ?? ''}` : '';
    const callee = node.callee !== undefined ? ` ${node.callee}` : '';
    const opWord = node.op === 'shl' ? '<<' : node.op === 'shr' ? '>>' : node.op;
    const direct = node.op === 'call' && node.callee !== undefined && isDirectCallee(node.callee);
    let out = direct ? node.id + ' ' + node.callee : `${node.id} ${opWord}${pred}${callee}`;
    for (const arg of node.args)
        out += ` ${formatOperand(arg)}`;
    return out;
}
const canonicalText = new WeakMap();
/**
 * The canonical text of a function. A `Func` is immutable, so the text is remembered per object: an edit that
 * leaves most of a program as it was formats, and so hashes, only the functions it rebuilt.
 */
export function formatFunction(fn) {
    if (!reuseEnabled)
        return formatFunctionUncached(fn);
    let text = canonicalText.get(fn);
    if (text === undefined) {
        text = formatFunctionUncached(fn);
        canonicalText.set(fn, text);
    }
    return text;
}
function formatFunctionUncached(fn) {
    const sig = fn.params.length > 0 ? ` ${fn.params.map(formatType).join(' ')}` : '';
    const spec = specLinesWithComments(fn.spec)
        .map(([, line]) => line)
        .join('\n');
    const body = fn.nodes.map(formatNode).join('\n');
    return `${sourceHeader(fn)}\n${spec}${spec ? '\n' : ''}${body}${body ? '\n' : ''}ret ${formatOperand(fn.ret)}\nend`;
}
export function formatProgram(program) {
    // The directive is part of the canonical form, so a strict program has a different hash.
    const head = program.profile === 'strict' ? 'profile strict\n\n' : '';
    return `${head}${program.functions.map(formatFunction).join('\n\n')}\n`;
}
/** One source line with its comments: leading lines above it, trailing after one space. */
function withComments(line, comments) {
    if (comments === undefined)
        return line;
    const above = (comments.leading ?? []).map((c) => `${c}\n`).join('');
    return `${above}${line}${comments.trailing === undefined ? '' : ` ${comments.trailing}`}`;
}
/** A function in canonical form with its source comments in place. */
export function formatFunctionSource(fn) {
    const sig = fn.params.length > 0 ? ` ${fn.params.map(formatType).join(' ')}` : '';
    return [
        withComments(sourceHeader(fn), fn.comments),
        ...specLinesWithComments(fn.spec).map(([comments, line]) => withComments(line, comments)),
        ...fn.nodes.map((n) => withComments(formatNode(n), n.comments)),
        withComments(`ret ${formatOperand(fn.ret)}`, fn.retComments),
        withComments('end', fn.endComments),
        ...(fn.afterComments === undefined ? [] : ['', ...fn.afterComments]),
    ].join('\n');
}
/**
 * The file a formatter writes: `use` lines, then the canonical form of every function,
 * with every source comment kept on the line it was attached to. Unlike `formatProgram`,
 * this is not a revision input; comments never change a hash.
 */
export function formatSource(program) {
    const directive = program.profile === 'strict'
        ? `${withComments('profile strict', program.profileComments)}\n`
        : '';
    const uses = (program.uses ?? [])
        .map((u, k) => `${withComments(`use "${u}"`, program.useComments?.[k])}\n`)
        .join('');
    const fns = program.functions.map(formatFunctionSource).join('\n\n');
    const body = fns.length > 0 ? `${fns}\n` : '';
    const tail = (program.tailComments ?? []).map((c) => `${c}\n`).join('');
    const head = `${directive}${uses}`;
    return `${head}${head && (body || tail) ? '\n' : ''}${body}${tail}`;
}
export function makeIo(input = []) {
    return { input, position: 0, output: [] };
}
/** Append one output word, bounded so a runaway program cannot exhaust memory. */
function emit(state, word) {
    if (state.output.length >= LIMITS.maxIoOutput) {
        throw diag('A0702', [LIMITS.maxIoOutput]);
    }
    state.output.push(word);
}
export function isIoState(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v) && 'output' in v;
}
export function valueEquals(a, b) {
    if (isIoState(a) || isIoState(b))
        return a === b;
    if (Array.isArray(a) || Array.isArray(b)) {
        return (Array.isArray(a) &&
            Array.isArray(b) &&
            a.length === b.length &&
            a.every((x, i) => valueEquals(x, b[i])));
    }
    return a === b;
}
/**
 * One operation on concrete values. Canonical semantics unless `strict` is given: then an index
 * at or past the length (`get` `set` `at` `put`), a division or remainder by zero, and a `read`
 * on exhausted input call `strict` instead of wrapping. The checked ops (`cadd` ... `cget`) are
 * total and behave the same in both profiles.
 */
export function evalOp(op, args, strict) {
    const a = args[0];
    const b = args[1];
    const c = args[2];
    const num = (v) => {
        if (typeof v !== 'number')
            throw diag('A0790', [`${op}: expected u32 value`]);
        return v;
    };
    switch (op) {
        case 'mov':
            if (a === undefined)
                throw diag('A0790', ['mov: missing operand']);
            return a;
        case 'add':
            return (num(a) + num(b)) >>> 0;
        case 'sub':
            return (num(a) - num(b)) >>> 0;
        case 'mul':
            return Math.imul(num(a), num(b)) >>> 0;
        case 'and':
            if (typeof a === 'boolean')
                return a && b === true;
            return (num(a) & num(b)) >>> 0;
        case 'or':
            if (typeof a === 'boolean')
                return a || b === true;
            return (num(a) | num(b)) >>> 0;
        case 'xor':
            if (typeof a === 'boolean')
                return a !== (b === true);
            return (num(a) ^ num(b)) >>> 0;
        case 'shl':
            return (num(a) << (num(b) & 31)) >>> 0;
        case 'shr':
            return num(a) >>> (num(b) & 31);
        case 'div':
            // Unsigned division; division by zero yields all ones (total, as on RISC-V).
            if (num(b) === 0 && strict !== undefined)
                return strict('divzero');
            return num(b) === 0 ? 0xffff_ffff : Math.floor(num(a) / num(b));
        case 'rem':
            if (num(b) === 0 && strict !== undefined)
                return strict('divzero');
            return num(b) === 0 ? num(a) : num(a) % num(b);
        case 'cadd':
            return [(num(a) + num(b)) >>> 0, num(a) + num(b) <= U32_MAX];
        case 'csub':
            return [(num(a) - num(b)) >>> 0, num(a) >= num(b)];
        case 'cmul':
            return [Math.imul(num(a), num(b)) >>> 0, BigInt(num(a)) * BigInt(num(b)) <= BigInt(U32_MAX)];
        case 'cdiv':
            return num(b) === 0 ? [0, false] : [Math.floor(num(a) / num(b)), true];
        case 'crem':
            return num(b) === 0 ? [0, false] : [num(a) % num(b), true];
        case 'cget': {
            if (!Array.isArray(a))
                throw diag('A0790', ['cget: expected array']);
            return num(b) < a.length ? [a[num(b)], true] : [0, false];
        }
        case 'eq':
            if (typeof a === 'boolean')
                return a === b;
            return num(a) === num(b);
        case 'ne':
            if (typeof a === 'boolean')
                return a !== b;
            return num(a) !== num(b);
        case 'lt':
            return num(a) < num(b);
        case 'le':
            return num(a) <= num(b);
        case 'gt':
            return num(a) > num(b);
        case 'ge':
            return num(a) >= num(b);
        case 'select':
            if (typeof a !== 'boolean' || b === undefined || c === undefined) {
                throw diag('A0790', ['select: expected bool and two values']);
            }
            return a ? b : c;
        case 'arr':
        case 'rec':
            return [...args];
        case 'get': {
            if (!Array.isArray(a) || a.length === 0)
                throw diag('A0790', ['get: expected array']);
            if (num(b) >= a.length && strict !== undefined)
                return strict('bounds');
            return a[num(b) % a.length];
        }
        case 'set': {
            if (!Array.isArray(a) || a.length === 0 || c === undefined)
                throw diag('A0790', ['set: expected array']);
            if (num(b) >= a.length && strict !== undefined)
                return strict('bounds');
            const copy = [...a];
            copy[num(b) % a.length] = c;
            return copy;
        }
        case 'at': {
            if (!Array.isArray(a))
                throw diag('A0790', ['at: expected record']);
            const v = a[num(b)];
            if (v === undefined && strict !== undefined)
                return strict('bounds');
            if (v === undefined)
                throw diag('A0790', ['at: field out of range']);
            return v;
        }
        case 'put': {
            if (Array.isArray(a) && num(b) >= a.length && strict !== undefined)
                return strict('bounds');
            if (!Array.isArray(a) || c === undefined || num(b) >= a.length)
                throw diag('A0790', ['put: bad field']);
            const copy = [...a];
            copy[num(b)] = c;
            return copy;
        }
        case 'read': {
            // Exhausted input reads as 0; the token identity is the state itself.
            if (a === undefined || !isIoState(a))
                throw diag('A0790', ['read: expected io token']);
            if (a.position >= a.input.length && strict !== undefined)
                return strict('input');
            const v = a.input[a.position] ?? 0;
            if (a.position < a.input.length)
                a.position += 1;
            return [v, a];
        }
        case 'write': {
            if (a === undefined || !isIoState(a))
                throw diag('A0790', ['write: expected io token']);
            emit(a, num(b));
            return a;
        }
        case 'puts': {
            // Length word, then every element, in order.
            if (a === undefined || !isIoState(a) || !Array.isArray(b))
                throw diag('A0790', ['puts: expected io token and array']);
            emit(a, b.length);
            for (const v of b)
                emit(a, num(v));
            return a;
        }
        case 'call':
        case 'fold':
        case 'loop':
            throw diag('A0790', [`${op} is evaluated by run, not evalOp`]);
    }
}
export function checkArgument(type, value, where) {
    if (type === 'bool') {
        if (typeof value !== 'boolean')
            throw diag('A0704', [where, 'bool']);
        return;
    }
    if (type === 'u32') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > U32_MAX) {
            throw diag('A0704', [where, 'u32']);
        }
        return;
    }
    if (type === 'io') {
        if (!isIoState(value))
            throw diag('A0704', [where, 'io token']);
        return;
    }
    if (!Array.isArray(value))
        throw diag('A0704', [where, formatType(type)]);
    if (type.kind === 'arr') {
        if (value.length !== type.length)
            throw diag('A0705', [where, type.length]);
        for (const [i, v] of value.entries())
            checkArgument(type.elem, v, `${where}[${i}]`);
        return;
    }
    if (value.length !== type.fields.length)
        throw diag('A0706', [where, type.fields.length]);
    for (const [i, f] of type.fields.entries())
        checkArgument(f, value[i], `${where}.${i}`);
}
/** The trap for a budget stop, read off the running call chain. */
function trapOf(kind, options) {
    const frames = options.frames ?? [];
    const top = frames[frames.length - 1];
    let at = null;
    let trip = null;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
        const f = frames[i];
        if (f.node !== null) {
            at = `${f.fn.name}.${f.node}`;
            trip = f.trip;
            break;
        }
    }
    return { kind, fn: top?.fn.name ?? '-', at, trip, chain: frames.map((f) => f.fn.name) };
}
/**
 * Evaluate a validated function on concrete arguments with the reference semantics.
 * `options.fuel` bounds total node evaluations (default LIMITS.defaultFuel) so a hostile
 * or runaway program cannot consume unbounded compute in the reference evaluator.
 */
export function run(fn, args, options = { fuel: LIMITS.defaultFuel }) {
    if (args.length !== fn.params.length) {
        throw diag('A0703', [fn.name, fn.params.length, args.length]);
    }
    for (const [index, type] of fn.params.entries()) {
        checkArgument(type, args[index], `${fn.name} p${index}`);
    }
    options.frames = [];
    return exec(fn, args, options);
}
const STRICT_TRAP_ID = { bounds: 'A0710', divzero: 'A0711', input: 'A0712' };
/** The strict profile's trap raiser for a run: the `{kind, fn, at, trip, chain}` of the running frames. */
function strictTrap(options) {
    return (kind) => {
        throw diag(STRICT_TRAP_ID[kind], [trapOf(kind, options).fn], { trap: trapOf(kind, options) });
    };
}
/** Charge `units` of fuel; exhaustion throws a `limit` A0Error. */
function charge(fn, options, units) {
    options.fuel -= units;
    if (options.fuel < 0)
        throw diag('A0701', [fn.name], { trap: trapOf('fuel', options) });
}
/** Take one trip from the iteration cap, when there is one. */
function takeTrip(fn, options) {
    if (options.maxTrips === undefined)
        return;
    if (options.maxTrips <= 0)
        throw diag('A0709', [fn.name], { trap: trapOf('iter', options) });
    options.maxTrips -= 1;
}
const AGGREGATE_OPS = new Set(['arr', 'rec', 'set', 'put']);
/**
 * Internal evaluation: arguments come from validator-typed values (the entry check or
 * well-typed nodes), so they are not re-walked. Each entry costs one fuel unit, each node
 * one, and each aggregate-producing node max(1, length) for the copy it makes.
 */
function exec(fn, args, options) {
    if (options.frames === undefined)
        options.frames = [];
    const frames = options.frames;
    const frame = { fn, node: null, trip: 0 };
    frames.push(frame);
    charge(fn, options, 1);
    const env = new Map();
    const read = (operand) => {
        switch (operand.kind) {
            case 'u32':
            case 'bool':
                return operand.value;
            case 'param':
                return args[operand.index];
            case 'node': {
                const v = env.get(operand.id);
                if (v === undefined)
                    throw diag('A0791', [`${fn.name}: unbound node '${operand.id}'`]);
                return v;
            }
        }
    };
    for (const node of fn.nodes) {
        charge(fn, options, 1);
        if (node.op === 'call') {
            const callee = fn.calls.get(node.callee ?? '');
            if (callee === undefined)
                throw diag('A0791', [`${fn.name}: unresolved callee '${node.callee ?? ''}'`]);
            env.set(node.id, exec(callee, node.args.map(read), options));
        }
        else if (node.op === 'fold') {
            const body = fn.calls.get(node.callee ?? '');
            if (body === undefined)
                throw diag('A0791', [`${fn.name}: unresolved fold body '${node.callee ?? ''}'`]);
            const [count, init, ...extra] = node.args.map(read);
            let state = init;
            const n = count;
            frame.node = node.id;
            for (let i = 0; i < n; i += 1) {
                frame.trip = i;
                charge(fn, options, 1);
                takeTrip(fn, options);
                state = exec(body, [state, i, ...extra], options);
            }
            frame.node = null;
            env.set(node.id, state);
        }
        else if (node.op === 'loop') {
            const body = fn.calls.get(node.callee ?? '');
            const pred = fn.calls.get(node.pred ?? '');
            if (body === undefined || pred === undefined)
                throw diag('A0791', [`${fn.name}: unresolved loop functions`]);
            const [count, init, ...extra] = node.args.map(read);
            let state = init;
            const n = count;
            frame.node = node.id;
            for (let i = 0; i < n; i += 1) {
                frame.trip = i;
                charge(fn, options, 1);
                takeTrip(fn, options);
                if (exec(pred, [state, i, ...extra], options) !== true)
                    break;
                state = exec(body, [state, i, ...extra], options);
            }
            frame.node = null;
            env.set(node.id, state);
        }
        else {
            const operands = node.args.map(read);
            if (AGGREGATE_OPS.has(node.op)) {
                const source = node.op === 'set' || node.op === 'put' ? operands[0] : operands;
                charge(fn, options, Math.max(1, Array.isArray(source) ? source.length : 1));
            }
            env.set(node.id, node.op === 'write' || node.op === 'puts'
                ? ioOp(node, operands, options)
                : evalOp(node.op, operands, fn.profile === 'strict' ? strictTrap(options) : undefined));
        }
    }
    frames.pop();
    return read(fn.ret);
}
/** An io-writing op; the output cap stops it with the same trap line as the other budgets. */
function ioOp(node, operands, options) {
    try {
        return evalOp(node.op, operands);
    }
    catch (e) {
        if (e instanceof A0Error && e.code === 'limit' && e.trap === undefined && e.id === 'A0702')
            throw diag('A0702', [LIMITS.maxIoOutput], { trap: trapOf('io', options) });
        throw e;
    }
}
export function parseAndValidate(source) {
    return validate(parse(source));
}
