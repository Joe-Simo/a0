import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAndValidate, run, type TypedProgram } from '../src/core.js';
import { optimizeFunction } from '../src/optimize.js';

function fn(program: TypedProgram, name: string) {
  const result = program.byName.get(name);
  if (result === undefined) throw new Error(`missing ${name}`);
  return result;
}

function matrixSource(n: number, side: 'right' | 'left', trips: number, indirect = false): string {
  const lines = [`fn matrix_step u32x${n * n} u32 u32x${n * n} -> u32x${n * n}`];
  for (let i = 0; i < n * n; i += 1) lines.push(`s${i} get p0 ${i}`, `m${i} get p2 ${i}`);
  const result: string[] = [];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      let sum = '';
      for (let k = 0; k < n; k += 1) {
        const id = `v${r}_${c}_${k}`;
        lines.push(
          side === 'right'
            ? `${id} mul s${r * n + k} m${k * n + c}`
            : `${id} mul m${r * n + k} s${k * n + c}`,
        );
        if (k === 0) sum = id;
        else {
          lines.push(`a${r}_${c}_${k} add ${sum} ${id}`);
          sum = `a${r}_${c}_${k}`;
        }
      }
      result.push(sum);
    }
  }
  lines.push(`r arr ${result.join(' ')}`, 'ret r', 'end');
  if (indirect) lines.push('fn count u32 -> u32', 'ret p0', 'end');
  lines.push(`fn top u32x${n * n} u32x${n * n} -> u32x${n * n}`);
  if (indirect) lines.push(`n call count ${trips}`);
  lines.push(`r fold matrix_step ${indirect ? 'n' : trips} p0 p1`, 'ret r', 'end', '');
  return lines.join('\n');
}

const mask = 0xffff_ffffn;
function product(x: readonly bigint[], y: readonly bigint[], n: number): bigint[] {
  return Array.from({ length: n * n }, (_, i) => {
    let v = 0n;
    for (let k = 0; k < n; k += 1) {
      const a = x[Math.floor(i / n) * n + k];
      const b = y[k * n + (i % n)];
      assert.ok(a !== undefined && b !== undefined);
      v = (v + a * b) & mask;
    }
    return v;
  });
}
function powerOracle(
  state: readonly number[],
  matrix: readonly number[],
  n: number,
  trips: number,
  side: 'right' | 'left',
): number[] {
  let acc = state.map(BigInt);
  let pow = matrix.map(BigInt);
  for (let left = BigInt(trips); left > 0n; left >>= 1n) {
    if ((left & 1n) !== 0n) acc = side === 'right' ? product(acc, pow, n) : product(pow, acc, n);
    if (left > 1n) pow = product(pow, pow, n);
  }
  return acc.map(Number);
}

for (const trips of [0x8000_0000, 0x8000_0001, 0xffff_ffff]) {
  test(`matrix exponent exposed by inlining retains all u32 bits: ${trips}`, () => {
    const p = parseAndValidate(matrixSource(2, 'right', trips, true));
    // The original accepted program has a variable fold count. Never execute its billions
    // of trips: the independent logarithmic BigInt oracle checks only optimized tiny output.
    const state = [1, 2, 3, 4];
    const matrix = [1, 1, 0, 1];
    const want = powerOracle(state, matrix, 2, trips, 'right');
    const ts = optimizeFunction(fn(p, 'top')).fn;
    assert.ok(!ts.nodes.some((node) => node.op === 'fold'));
    assert.deepEqual(run(ts, [state, matrix]), want);
  });
}
