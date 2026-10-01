#!/usr/bin/env python3
"""shorten.py IN OUT: rename every node id of every function to a short name (generated code only).

The linked compiler source is limited to 1 MiB; the expansion of inlined primitives produces long
mangled ids (`m2__m1__fl_rp`), so ids are renamed per function to a, b, ..., z, a0, a1, ... in
order of definition (skipping ops, keywords and function names).
"""
import re
import sys

OPS = {
    'mov', 'add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'shr', 'div', 'rem', 'eq', 'ne', 'lt', 'le',
    'gt', 'ge', 'select', 'call', 'fold', 'loop', 'arr', 'rec', 'text', 'get', 'set', 'at', 'put',
    'read', 'write', 'puts', 'ret', 'end', 'fn', 'true', 'false', 'patch',
}


def names():
    letters = 'abcdefghijklmnopqrstuvwxyz'
    alnum = letters + '0123456789'
    for c in letters:
        yield c
    for c in letters:
        for d in alnum:
            yield c + d
    for c in letters:
        for d in alnum:
            for e in alnum:
                yield c + d + e
    for c in letters:
        for d in alnum:
            for e in alnum:
                for f in alnum:
                    yield c + d + e + f


def main(src, dst):
    lines = open(src).read().split('\n')
    fnames = set()
    for l in lines:
        if l.startswith('fn '):
            fnames.add(l.split()[1])
    out = []
    i = 0
    while i < len(lines):
        l = lines[i]
        if not l.startswith('fn '):
            out.append(l)
            i += 1
            continue
        out.append(l)
        i += 1
        body = []
        while lines[i] != 'end':
            body.append(lines[i])
            i += 1
        ids = []
        seen = set()
        for b in body:
            if b.startswith('#') or not b.strip():
                continue
            t = b.split()
            if t[0] != 'ret' and t[0] not in seen:
                seen.add(t[0])
                ids.append(t[0])
        gen = names()
        mapping = {}
        reserved = OPS | fnames
        for x in ids:
            while True:
                n = next(gen)
                if n in reserved or re.fullmatch(r'p[0-9]+', n) or n in ids and n != x and False:
                    continue
                break
            mapping[x] = n
        # an id that is also a plain word elsewhere (ops, function names) keeps working because only
        # defined ids are renamed and only in operand positions (never after fold/call/loop heads)
        for b in body:
            if b.startswith('#') or not b.strip():
                out.append(b)
                continue
            t = b.split()
            if t[0] == 'ret':
                t = [t[0]] + [mapping.get(x, x) for x in t[1:]]
            else:
                op = t[1]
                head = [mapping[t[0]], op]
                rest = t[2:]
                if op in ('call',):
                    rest = [rest[0]] + [mapping.get(x, x) for x in rest[1:]]
                elif op == 'fold':
                    rest = [rest[0]] + [mapping.get(x, x) for x in rest[1:]]
                elif op == 'loop':
                    rest = rest[:2] + [mapping.get(x, x) for x in rest[2:]]
                elif op in OPS:
                    rest = [mapping.get(x, x) for x in rest]
                else:
                    # `ID F args`: a call written without the call keyword
                    rest = [mapping.get(x, x) for x in rest]
                t = head + rest
            out.append(' '.join(t))
        out.append('end')
        i += 1
    open(dst, 'w').write('\n'.join(out))


main(sys.argv[1], sys.argv[2])
