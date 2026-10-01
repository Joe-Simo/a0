#!/usr/bin/env python3
"""Rewrite fold counts that are bools into u32 (a `select b 1 0` line before the fold).

Usage: fixcounts.py in.a0 out.a0
Light type inference: eq ne lt le gt ge give bool; and/or of two bools give bool; select takes the
type of its second value; call results use the declared result type; `at` of a tuple takes the
component type. Names defined by unknown ops are treated as non-bool.
"""
import re
import sys

src = open(sys.argv[1]).read().split('\n')

# split a type string at top-level commas
def split_tuple(t):
    inner = t[1:-1]
    parts, depth, cur = [], 0, ''
    for ch in inner:
        if ch == ',' and depth == 0:
            parts.append(cur)
            cur = ''
            continue
        if ch == '(':
            depth += 1
        if ch == ')':
            depth -= 1
        cur += ch
    parts.append(cur)
    return parts

# collect function result types
rets = {}
for line in src:
    m = re.match(r'^fn (\S+) (.*)-> (\S+)\s*$', line)
    if m:
        rets[m.group(1)] = m.group(3)
    else:
        m = re.match(r'^fn (\S+) -> (\S+)\s*$', line)
        if m:
            rets[m.group(1)] = m.group(2)

out = []
i = 0
count_fix = 0
while i < len(src):
    line = src[i]
    m = re.match(r'^fn (\S+)(.*)$', line)
    if not m:
        out.append(line)
        i += 1
        continue
    header = line
    out.append(line)
    i += 1
    hm = re.match(r'^fn (\S+) (.*)-> (\S+)\s*$', header)
    params = hm.group(2).split() if hm else []
    types = {f'p{k}': t for k, t in enumerate(params)}
    uniq = 0

    def ty(x):
        if x in ('true', 'false'):
            return 'bool'
        if re.match(r'^[0-9]+$', x):
            return 'u32'
        return types.get(x, 'other')

    while i < len(src) and src[i] != 'end':
        l = src[i]
        i += 1
        if l.startswith('#') or not l.strip():
            out.append(l)
            continue
        t = l.split()
        if t[0] == 'ret':
            out.append(l)
            continue
        name = t[0]
        op = t[1] if len(t) > 1 else ''
        args = t[2:]
        res = 'other'
        if op in ('eq', 'ne', 'lt', 'le', 'gt', 'ge'):
            res = 'bool'
        elif op in ('and', 'or', 'xor'):
            res = 'bool' if ty(args[0]) == 'bool' and ty(args[1]) == 'bool' else 'u32'
        elif op == 'select':
            res = ty(args[1])
        elif op == 'mov':
            res = ty(args[0])
        elif op in ('add', 'sub', 'mul', 'shl', 'shr', 'div', 'rem'):
            res = 'u32'
        elif op == 'call':
            res = rets.get(args[0], 'other')
        elif op in rets:
            res = rets[op]
        elif op == 'at':
            st = ty(args[0])
            if st.startswith('(') and re.match(r'^[0-9]+$', args[1]):
                comps = split_tuple(st)
                res = comps[int(args[1])]
        elif op == 'fold':
            n = args[1]
            if ty(n) == 'bool':
                uniq += 1
                nn = f'cn{uniq}_{name}'
                out.append(f'{nn} select {n} 1 0')
                types[nn] = 'u32'
                l = ' '.join([t[0], 'fold', args[0], nn] + args[2:])
                count_fix += 1
            res = ty(args[2]) if len(args) > 2 else 'other'
        elif op == 'loop':
            res = ty(args[3]) if len(args) > 3 else 'other'
        types[name] = res
        out.append(l)
    out.append('end')
    i += 1

open(sys.argv[2], 'w').write('\n'.join(out))
print(f'fixed {count_fix} fold counts', file=sys.stderr)
