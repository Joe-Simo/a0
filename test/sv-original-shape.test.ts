import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';

// Optimization can erase a callee's division while its original module interface stays clocked.
test('SV optimized predicates retain their original module handshake connections', () => {
  const program = parseAndValidate(`fn pred u32 u32 -> bool
dead div p0 2
r lt p0 7
ret r
end
fn body u32 u32 -> u32
r xor p0 p1
ret r
end
fn f u32 -> u32
r loop pred body p0 0
ret r
end
`);
  const sv = compile(program, 'sv').text;
  const header = /module a0_pred \(([\s\S]*?)\);/.exec(sv)?.[1];
  assert.ok(header);
  assert.match(header, /input logic clk/);
  const instance = sv.split('\n').find((line) => /^\s*a0_pred u_/.test(line));
  assert.ok(instance);
  const connected = new Set([...instance.matchAll(/\.(\w+)\s*\(/g)].map((m) => m[1]));
  for (const name of ['clk', 'rst', 'start', 'done']) assert.ok(connected.has(name), name);
});
