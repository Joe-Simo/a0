#!/usr/bin/env python3
"""wasm_code_raw.a0 -> compiler/wasm_code.a0: inline reads of the state tables, then the mutators."""
import os
import subprocess
import sys

D = '<tmp>'
W = '<home>/Downloads/a0/.claude/worktrees/agent-aae7f9232410fdf8e'
sys.path.insert(0, D)
from inline_reads import transform
t = transform(open(f'{D}/wasm_code_raw.a0').read())
open(f'{D}/wasm_code_r.a0', 'w').write(t)
env = dict(os.environ, PREFIX='wfz', BASEPRIMS='wfzp1,wfzp2,wfzp4')
r = subprocess.run(['python3', f'{D}/inline_prims.py', f'{D}/wasm_code_r.a0', f'{D}/wasm_code_ip.a0'], env=env, capture_output=True, text=True)
print(r.stderr.strip())
r = subprocess.run(['python3', f'{D}/shorten.py', f'{D}/wasm_code_ip.a0', f'{W}/compiler/wasm_code.a0'], capture_output=True, text=True)
print(r.stderr.strip())
