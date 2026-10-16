/**
 * Linker: resolves `use "path"` lines into one flat program.
 *
 * A0 has one namespace per program and no forward references, so linking is a
 * dependency-ordered concatenation: every used file is loaded once (by resolved path),
 * its own uses come first, cycles are rejected, and the result is validated as a whole.
 * Function names must be unique across all files; a clash is reported with both files.
 * Diagnostics raised on the combined text are mapped back to `file:line`.
 */
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { A0Error, formatSource, LIMITS, parse, profileOf, stripComment, utf8Length, validate, } from './core.js';
import { diag } from './diagnostics.js';
import { existsSync, realpath } from './node-fs.js';
import { specLineOf } from './spec.js';
/** Dense files use this extension; any other file is read as canonical unless `dense` is set. */
export const DENSE_EXTENSION = '.a0d';
/** Whether a path names a dense-form source file. */
export function isDensePath(path) {
    return path.endsWith(DENSE_EXTENSION);
}
const USE_PATH = /^use\s+"([^"\\]+)"$/;
/** The `use` targets of a dense file, found before parsing it (its callee arities come from them). */
function denseUses(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
        const m = USE_PATH.exec(stripComment(raw).trim());
        if (m !== null)
            out.push(m[1]);
        else if (/^fn(\s|$)/.test(stripComment(raw).trim()))
            break;
    }
    return out;
}
function projectRoot(entry) {
    const start = dirname(resolve(entry));
    for (let dir = start;; dir = dirname(dir)) {
        if (existsSync(join(dir, 'package.json')))
            return dir;
        if (dirname(dir) === dir)
            return start;
    }
}
/** Follow symlinks; a path that does not exist yet cannot be a link and stays as resolved. */
async function canonical(path) {
    try {
        return await realpath(path);
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return resolve(path);
        throw e;
    }
}
/** Load `entry` and everything it uses; `read` is injected so tests need no filesystem. */
export async function link(entry, read, options = {}) {
    const root = await canonical(options.root ?? projectRoot(entry));
    const inside = (abs) => {
        const rel = relative(root, abs);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    };
    /** `text` is the canonical text the program is built from; `shown` the file as written. */
    const order = [];
    const visiting = new Set();
    const done = new Set();
    /** Parameter counts of every function a file defines or reaches through its uses. */
    const closureOf = new Map();
    const sigsOf = new Map();
    const visit = async (path, from) => {
        const abs = resolve(path);
        if (done.has(abs))
            return;
        if (visiting.has(abs)) {
            throw diag('A0620', [abs, from === undefined ? '' : ` (from ${from})`]);
        }
        visiting.add(abs);
        const shown = await read(abs);
        if (utf8Length(shown) > LIMITS.maxSourceBytes)
            throw diag('A0621', [abs, LIMITS.maxSourceBytes]);
        const isDense = options.dense === true || isDensePath(abs);
        const parsedCanonical = isDense ? undefined : parse(shown);
        const uses = isDense ? denseUses(shown) : (parsedCanonical?.uses ?? []);
        const known = new Map();
        const usedSigs = new Map();
        for (const use of uses) {
            const target = await canonical(resolve(dirname(abs), use));
            if (!(target.endsWith('.a0') || isDensePath(target)) || !inside(target))
                throw diag('A0622', [use, abs, target, root]);
            await visit(target, abs);
            for (const [name, n] of closureOf.get(target) ?? [])
                known.set(name, n);
            for (const [name, g] of sigsOf.get(target) ?? [])
                usedSigs.set(name, g);
        }
        let text = shown;
        let functions;
        let declared = 'canonical';
        if (isDense && options.denseReader !== undefined) {
            text = options.denseReader(shown, usedSigs, abs);
            const parsed = parse(text);
            functions = parsed.functions;
            declared = profileOf(parsed);
        }
        else if (isDense) {
            // dense.ts is loaded only for a dense file: a canonical `a0 check` never pays its start-up
            const { parseDense } = await import('./dense.js');
            let parsed;
            try {
                parsed = parseDense(shown, { known });
            }
            catch (e) {
                if (!(e instanceof A0Error) || e.line === undefined)
                    throw e;
                throw e.rewrite(`${abs}:${e.line}: ${e.message.replace(/^line \d+: /, '')}`);
            }
            text = formatSource(parsed);
            functions = parsed.functions;
            declared = profileOf(parsed);
        }
        else {
            functions = parsedCanonical.functions;
            declared = profileOf(parsedCanonical);
        }
        const own = new Map();
        for (const f of functions)
            own.set(f.name, f.params.length);
        closureOf.set(abs, new Map([...known, ...own]));
        sigsOf.set(abs, new Map([...usedSigs, ...functions.map((f) => [f.name, f])]));
        visiting.delete(abs);
        done.add(abs);
        order.push({
            path: abs,
            text,
            shown,
            fns: functions.map((f) => f.name),
            profile: declared,
            parsed: parsedCanonical,
        });
    };
    await visit(entry, undefined);
    // One profile per program: every file must declare what the entry file declares.
    const entryFile = order.find((o) => o.path === resolve(entry));
    const rootProfile = entryFile?.profile ?? 'canonical';
    for (const o of order) {
        if (o.profile !== rootProfile)
            throw diag('A0624', [resolve(entry), rootProfile, o.path, o.profile]);
    }
    const profile = options.profile ?? rootProfile;
    // Duplicate function names across files: report both definitions.
    const owner = new Map();
    for (const { path, fns } of order) {
        for (const name of fns) {
            const prev = owner.get(name);
            if (prev !== undefined && prev !== path) {
                throw diag('A0022', [name, prev, path]);
            }
            owner.set(name, path);
        }
    }
    const sources = [];
    let line = 1;
    const parts = [];
    for (const { path, text } of order) {
        // Drop `use` lines (already resolved) but keep line count so diagnostics map back.
        const body = text
            .replace(/^\s*use\s+"[^"]*"\s*$/gm, '')
            .replace(/^[ \t]*profile[ \t]+strict[ \t]*(#.*)?$/gm, '');
        const lineCount = body.split(/\r?\n/).length;
        sources.push({ path, startLine: line, lineCount });
        parts.push(body);
        line += lineCount;
    }
    const combined = parts.join('\n');
    if (utf8Length(combined) > LIMITS.maxSourceBytes)
        throw diag('A0623', [LIMITS.maxSourceBytes]);
    // A single canonical file with no `use` or `profile` line to drop is its own combined text: its
    // parse above is the parse of `combined` (parse is a pure function of the text), so it is not
    // parsed a second time.
    const only = order.length === 1 ? order[0] : undefined;
    const reuse = only?.parsed !== undefined && combined === only.text ? only.parsed : undefined;
    try {
        const parsed = reuse ?? parse(combined);
        return {
            program: validate(profile === 'strict' ? { ...parsed, profile } : parsed),
            text: combined,
            sources,
        };
    }
    catch (e) {
        if (!(e instanceof A0Error))
            throw e;
        // Parse errors carry a line in the combined text; validator errors name `fn.node` or
        // `fn`. Both are mapped to the owning file, and the node to its line in that file.
        if (e.line !== undefined) {
            const src = sources.find((s) => e.line !== undefined && e.line >= s.startLine && e.line < s.startLine + s.lineCount);
            if (src !== undefined) {
                const local = e.line - src.startLine + 1;
                throw e.rewrite(`${src.path}:${local}: ${e.detail}`);
            }
            throw e;
        }
        const m = /^([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?[:.]/.exec(e.message);
        const path = m === null ? undefined : owner.get(m[1]);
        if (path === undefined)
            throw e;
        const text = order.find((o) => o.path === path)?.shown ?? '';
        const fileLines = text.split(/\r?\n/);
        let line = fileLines.findIndex((l) => new RegExp(`^\\s*fn\\s+${m?.[1]}\\b`).test(l));
        if (line >= 0 && m?.[2] !== undefined) {
            const node = fileLines.findIndex((l, i) => i > line && new RegExp(`^\\s*${m[2]}\\s`).test(l));
            if (node >= 0)
                line = node;
        }
        // A spec failure points at the spec line it is about (the example it broke).
        if (line >= 0 && e.spec !== undefined)
            line = specLineOf(fileLines, line, e.spec) ?? line;
        throw e.rewrite(`${path}${line >= 0 ? `:${line + 1}` : ''}: ${e.message}`);
    }
}
/**
 * One file parsed on its own, canonical or dense, without validating or linking it, plus the
 * parameter counts of the functions its `use`s bring in (what the dense converter needs).
 */
export async function parseFile(entry, read, dense = false) {
    const seen = new Map();
    const load = async (path, asDense) => {
        const abs = resolve(path);
        const text = await read(abs);
        const isDense = asDense || isDensePath(abs);
        const uses = isDense ? denseUses(text) : (parse(text).uses ?? []);
        const known = new Map();
        for (const use of uses) {
            const target = resolve(dirname(abs), use);
            if (!seen.has(target))
                await load(target, false);
            for (const [name, n] of seen.get(target) ?? [])
                known.set(name, n);
        }
        const program = isDense
            ? (await import('./dense.js')).parseDense(text, { known })
            : parse(text);
        const own = new Map(program.functions.map((f) => [f.name, f.params.length]));
        seen.set(abs, new Map([...known, ...own]));
        return program;
    };
    const program = await load(entry, dense);
    const known = new Map();
    for (const use of program.uses ?? [])
        for (const [name, n] of seen.get(resolve(dirname(resolve(entry)), use)) ?? [])
            known.set(name, n);
    return { program, known };
}
//# sourceMappingURL=link.js.map