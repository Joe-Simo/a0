#!/usr/bin/env python3
"""Inline the small mutating primitives (fold bodies over the machine table run with count 1 or a
0/1 flag) into their callers as chains of `set` nodes.

Why: the A0 C emitter updates a state in place along a chain of `set` nodes, but copies it (the
whole 256 KB machine table) at every `fold` whose initial state is the result of another fold, so
every primitive call used to cost one copy. After this pass a handler is a single chain of sets
(in place) with a copy only at each real loop.

A primitive's body is straight line: reads (`get`), arithmetic, and `set`s of the state's pages and
of the state; nested folds of other primitives with count 1 or a flag. With a flag count c the
primitive's scalar writes (a `set` of a page's word) keep the old word when c is 0.
"""
import re
import sys

import os
BASE = set(os.environ.get('BASEPRIMS', 'wxs,wxe,wxad').split(','))
PREFIX = os.environ.get('PREFIX', 'wx')
PRIMS = set(BASE)
# fold bodies run once per element / node: all straight-line mutators are inlined into them
LOOPBODY = set('''wxwu wxwk wxvsb wxvsa wxvn1 wxvclr wxuspg wxusn wxusa wxupd wxsrc wxsm1 wxroot wxrecf
wxpa wxpel wxown wxnf wxlitpg wxlitop wxl2s wxiop wxion wxindw wxind1 wxhx wxhf wxfst wxfld1 wxext
wxec1 wxec2 wxcr0 wxcr1 wxclr wxchs wxch4 wxch3 wxch2 wxch1 wxcclr wxael wxfnd wxfun wxvsp'''.split())
TABLE = 'u32x128x512'
KEYWORDS = {'fold', 'loop', 'call', 'ret', 'true', 'false'}
OPS = {
    'mov', 'add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'shr', 'div', 'rem', 'eq', 'ne', 'lt', 'le',
    'gt', 'ge', 'select', 'call', 'fold', 'loop', 'arr', 'rec', 'text', 'get', 'set', 'at', 'put',
    'read', 'write', 'puts',
}


def parse(text):
    funcs = {}
    order = []
    lines = text.split('\n')
    i = 0
    while i < len(lines):
        if lines[i].startswith('fn '):
            header = lines[i]
            j = i + 1
            while lines[j] != 'end':
                j += 1
            name = header.split()[1]
            funcs[name] = (header, lines[i + 1:j], i, j)
            order.append(name)
            i = j
        i += 1
    return funcs, order, lines


def param_types(header):
    t = header.split()
    if '->' in t:
        k = t.index('->')
        return t[2:k]
    return t[2:]


class Inliner:
    def __init__(self, funcs):
        self.funcs = funcs
        self.counter = 0

    def types_of(self, header):
        ty = {}
        for k, t in enumerate(param_types(header)):
            ty[f'p{k}'] = 'table' if t == TABLE else ('page' if t == 'u32x128' else 'scalar')
        return ty

    def expand_body(self, body, ty, alias):
        """Return the body with primitive folds expanded (state names resolved through alias)."""
        out = []
        for line in body:
            if line.startswith('#') or not line.strip():
                out.append(line)
                continue
            t = line.split()
            t = [alias.get(x, x) for x in t]
            name = t[0]
            op = t[1] if len(t) > 1 else ''
            if t[0] == 'ret':
                out.append(' '.join(t))
                continue
            if op == 'fold' and t[2] in PRIMS and ty.get(t[4]) == 'table':
                f, cnt, state, args = t[2], t[3], t[4], t[5:]
                lines, final = self.inline(f, cnt, state, args, name)
                out.extend(lines)
                alias[name] = final
                ty[final] = 'table'
                ty[name] = 'table'
                continue
            out.append(' '.join(t))
            # types
            if op == 'get':
                a = ty.get(t[2], 'scalar')
                ty[name] = 'page' if a == 'table' else 'scalar'
            elif op == 'set':
                ty[name] = ty.get(t[2], 'scalar')
            elif op == 'fold':
                ty[name] = ty.get(t[4], 'scalar')
            else:
                ty[name] = 'scalar'
        return out

    def inline(self, f, cnt, state, args, result):
        header, body, _, _ = self.funcs[f]
        pts = param_types(header)
        cond = None if cnt == '1' else cnt
        prefix = result + '__'
        # parameter map: p0 state, p1 trip (0), p2.. args
        pmap = {'p0': state, 'p1': '0'}
        for k, a in enumerate(args):
            pmap[f'p{k + 2}'] = a
        ids = set()
        for line in body:
            if line.startswith('#') or not line.strip():
                continue
            ids.add(line.split()[0])
        def ren(x):
            if x in pmap:
                return pmap[x]
            if x in ids:
                return prefix + x
            return x
        lines = []
        cb = prefix + 'gcondb'
        if cond is not None:
            lines.append(f'{cb} ne {cond} 0')
        ty = {'p0': 'table'}
        alias_local = {}
        final = state
        # types of the renamed state lineage
        local_ty = {state: 'table'}
        for line in body:
            if line.startswith('#') or not line.strip():
                continue
            t = line.split()
            name = t[0]
            if name == 'ret':
                final = alias_local.get(ren(t[1]), ren(t[1]))
                continue
            op = t[1]
            toks = [ren(x) if k != 0 else prefix + x for k, x in enumerate(t)]
            toks = [alias_local.get(x, x) for x in toks[:1]] + [alias_local.get(x, x) for x in toks[1:]]
            new_name = toks[0]
            if op == 'fold' and toks[2] in PRIMS:
                ncnt, nstate, nargs = toks[3], toks[4], toks[5:]
                if cond is not None:
                    if ncnt == '1':
                        c2 = cond
                    else:
                        c2 = new_name + '_c'
                        lines.append(f'{c2} and {cond} {ncnt}')
                else:
                    c2 = ncnt
                sub = Inliner(self.funcs)
                sub.counter = self.counter
                ls, fin = sub.inline(toks[2], c2, nstate, nargs, new_name)
                lines.extend(ls)
                alias_local[new_name] = fin
                local_ty[new_name] = 'table'
                local_ty[fin] = 'table'
                continue
            if op == 'get':
                a = local_ty.get(toks[2], 'scalar')
                local_ty[new_name] = 'page' if a == 'table' else 'scalar'
            elif op == 'set':
                local_ty[new_name] = local_ty.get(toks[2], 'scalar')
                if local_ty[new_name] == 'table' and cond is not None:
                    # the primitive is off: keep the old page
                    tbl, idx, val = toks[2], toks[3], toks[4]
                    lines.append(f'{new_name}_o get {tbl} {idx}')
                    lines.append(f'{new_name}_s select {cb} {val} {new_name}_o')
                    lines.append(f'{new_name} set {tbl} {idx} {new_name}_s')
                    continue
            elif op == 'fold':
                local_ty[new_name] = local_ty.get(toks[4], 'scalar')
            else:
                local_ty[new_name] = 'scalar'
            lines.append(' '.join(toks))
        return lines, final


def eligible_set(funcs):
    el = set()
    changed = True
    while changed:
        changed = False
        for name, (header, body, _, _) in funcs.items():
            if name in el or not name.startswith(PREFIX) or name in LOOPBODY:
                continue
            pts = param_types(header)
            if not pts or pts[0] != TABLE or header.split()[-1] != TABLE:
                continue
            ok = True
            for line in body:
                t = line.split()
                if len(t) > 4 and t[1] == 'fold':
                    # a fold whose state is a table (names not defined as scalars are table lineage)
                    if t[2] in funcs and param_types(funcs[t[2]][0])[:1] == [TABLE]:
                        if t[2] not in el and t[2] not in BASE:
                            ok = False
                            break
                if len(t) > 1 and t[1] == 'loop':
                    ok = False
                    break
            if ok:
                el.add(name)
                changed = True
    return el | BASE


def transform(text):
    funcs, order, lines = parse(text)
    global PRIMS
    elig = eligible_set(funcs)
    inl = Inliner(funcs)
    out = list(lines)
    # process functions back to front so the line numbers stay valid
    for name in reversed(order):
        header, body, a, b = funcs[name]
        if not name.startswith(PREFIX):
            continue
        if not any(('fold ' in l) for l in body):
            continue
        ty = inl.types_of(header)
        alias = {}
        PRIMS = elig if name in LOOPBODY else BASE
        new = inl.expand_body(body, ty, alias)
        # final ret may name an aliased state
        new = [(' '.join(alias.get(x, x) for x in l.split()) if l.startswith('ret ') else l) for l in new]
        out[a + 1:b] = new
    return '\n'.join(out)


if __name__ == '__main__':
    src = open(sys.argv[1]).read()
    open(sys.argv[2], 'w').write(transform(src))
