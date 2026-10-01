#!/usr/bin/env python3
"""Expand reads of the machine table into inline `get`s.

The A0 C emitter updates a fold state in place only when no earlier node passed it to a call
(a call argument counts as sharing); `get` of a page and of a word are reads that do not. So
`x call wxg M a` (word a of M), `x call wxfg M d k` (frame word), `x call wxcg M d k` (loop
context word) and `x call wxrg M d j k` (node row word) are written out as address arithmetic
and two `get`s.
"""
import re


def get_word(out, x, m, a, tag):
    out.append(f'{x}_{tag}p shr {a} 7')
    out.append(f'{x}_{tag}w and {a} 127')
    out.append(f'{x}_{tag}g get {m} {x}_{tag}p')
    out.append(f'{x} get {x}_{tag}g {x}_{tag}w')


def expand_line(line):
    t = line.split()
    if len(t) < 4 or t[1] != 'call' or t[2] not in ('wxg', 'wxfg', 'wxcg', 'wxrg', 'wfzg'):
        return [line]
    x, _, fn = t[0], t[1], t[2]
    a = t[3:]
    out = []
    if fn in ('wxg', 'wfzg'):
        get_word(out, x, a[0], a[1], 'g')
    elif fn == 'wxfg':
        m, d, k = a
        out.append(f'{x}_fa mul {d} 128')
        out.append(f'{x}_fb add {x}_fa 128')
        out.append(f'{x}_fc add {x}_fb {k}')
        get_word(out, x, m, f'{x}_fc', 'f')
    elif fn == 'wxcg':
        m, d, k = a
        out.append(f'{x}_ca mul {d} 176')
        out.append(f'{x}_cb add {x}_ca 640')
        out.append(f'{x}_cc add {x}_cb {k}')
        get_word(out, x, m, f'{x}_cc', 'c')
    elif fn == 'wxrg':
        m, d, j, k = a
        out.append(f'{x}_t1 eq {d} 0')
        out.append(f'{x}_t2 mul {j} 4')
        out.append(f'{x}_t3 add {x}_t2 5440')
        out.append(f'{x}_t4 sub {d} 1')
        out.append(f'{x}_t5 mul {x}_t4 128')
        out.append(f'{x}_t6 add {x}_t5 16704')
        out.append(f'{x}_t7 add {x}_t6 {x}_t2')
        out.append(f'{x}_t8 select {x}_t1 {x}_t3 {x}_t7')
        out.append(f'{x}_t9 add {x}_t8 {k}')
        get_word(out, x, m, f'{x}_t9', 'r')
    return out


def transform(text):
    out = []
    infn = False
    skip = False
    for line in text.split('\n'):
        if line.startswith('fn '):
            infn = True
            name = line.split()[1]
            # the readers themselves and the table accessors keep their bodies
            skip = name in ('wxg', 'wxfg', 'wxcg', 'wxrg', 'wfzg')
            out.append(line)
            continue
        if line == 'end':
            infn = False
            skip = False
            out.append(line)
            continue
        if infn and not skip and not line.startswith('#'):
            out.extend(expand_line(line))
        else:
            out.append(line)
    return '\n'.join(out)
