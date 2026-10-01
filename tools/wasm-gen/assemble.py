#!/usr/bin/env python3
"""Assemble compiler/emit_wasm.a0 from the retained parts of the old file (kept as emit_wasm_old.a0
in this directory) and the new parts, then fix the fold counts."""
import os
import subprocess
import sys

sys.path.insert(0, '<tmp>')
from inline_reads import transform

D = '<tmp>'
W = '<home>/Downloads/a0/.claude/worktrees/agent-aae7f9232410fdf8e'
old = open(f'{D}/emit_wasm_old.a0').read().split('\n')


def rng(a, b):
    """old lines a..b inclusive (1-based)"""
    return '\n'.join(old[a - 1:b])


def part(n):
    lines = open(f'{D}/{n}').read().rstrip('\n').split('\n')
    return transform('\n'.join(l if l.startswith('#') else l.lower() for l in lines))


header = open(f'{D}/header.txt').read().rstrip('\n')
pieces = [
    header,
    'use "emit_c.a0"\nuse "wasm_code.a0"',
    rng(41, 376),  # paged tables .. type info (wa*, z*, writers, wafi, wainfo, wafo)
    rng(583, 600),  # waretop
    rng(819, 842),  # waown
    rng(883, 902),  # warefst wabst wab2st wab3st wamemst
]
for n in ['part1.a0', 'part2.a0', 'part3.a0', 'part4.a0', 'part5.a0', 'part6.a0', 'part7.a0',
          'part8.a0', 'part9.a0', 'part11.a0', 'part12.a0', 'part13.a0', 'part14.a0', 'part15.a0',
          'part16.a0', 'part17.a0', 'part17b.a0', 'part18.a0', 'part19.a0']:
    pieces.append(part(n))
pieces += [
    rng(2041, 2084),  # waiop waion waio wanmb
    rng(2276, 2296),  # watrail
    part('part20.a0'),
    part('part20b.a0'),
    part('part21.a0'),
    part('part22.a0'),
    open(f'{D}/tail_chunk.a0').read().rstrip('\n'),  # readers, wairchunk, wasunit, wachunkst
    open(f'{D}/linker.a0').read().rstrip('\n'),  # the linker
]
text = '\n'.join(pieces) + '\n'
open(f'{D}/emit_wasm_new.a0', 'w').write(text)
r = subprocess.run(['python3', f'{D}/fixcounts.py', f'{D}/emit_wasm_new.a0', f'{D}/emit_wasm_fc.a0'],
                   capture_output=True, text=True)
print(r.stderr.strip())
if os.environ.get('NOINLINE'):
    open(f'{W}/compiler/emit_wasm.a0', 'w').write(open(f'{D}/emit_wasm_fc.a0').read())
else:
    r = subprocess.run(['python3', f'{D}/inline_prims.py', f'{D}/emit_wasm_fc.a0', f'{D}/emit_wasm_ip.a0'],
                       capture_output=True, text=True)
    print(r.stderr.strip())
    r = subprocess.run(['python3', f'{D}/shorten.py', f'{D}/emit_wasm_ip.a0', f'{W}/compiler/emit_wasm.a0'],
                       capture_output=True, text=True)
    print(r.stderr.strip())
