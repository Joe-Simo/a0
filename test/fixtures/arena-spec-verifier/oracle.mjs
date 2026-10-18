// Source bytes go straight to native A0. The TS compiler is an independent oracle.
// This file contains only binary framing, storage inspection and assertions.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A0Error, LIMITS, parse, parseAndValidate } from '../../../dist/src/core.js';
import { spawnWithInput } from '../../../dist/src/toolchain.js';
import { cases, simple } from './cases.mjs';
import { legacyAdjacencyCases, sharedCases } from './shared-cases.mjs';

const [exe, group] = process.argv.slice(2);
assert.ok(exe);
let requests = 0;
function invokeStandalone(input) {
  // Match spawnWithInput's descriptor-based stdin; its API deliberately has no argv.
  const dir = mkdtempSync(join(tmpdir(), 'a0-spec-standalone-'));
  try {
    const path = join(dir, 'stdin');
    writeFileSync(path, input);
    const fd = openSync(path, 'r');
    try {
      return spawnSync(exe, ['--standalone'], {
        stdio: [fd, 'pipe', 'pipe'],
        timeout: 120_000,
        maxBuffer: 1 << 28,
      });
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function invoke(source, quantum = 7, observation = 0, max = 16_000_000, standalone = false) {
  const bytes = Array.from(Buffer.from(source, 'utf8'));
  const words = [0x41535646, max, quantum, bytes.length, observation, ...bytes];
  const input = Buffer.alloc(words.length * 4);
  for (const [i, word] of words.entries()) input.writeUInt32LE(word, i * 4);
  const ran = standalone
    ? invokeStandalone(input)
    : spawnWithInput(exe, input, { timeout: 120_000, maxBuffer: 1 << 28 });
  requests++;
  assert.equal(ran.error, undefined);
  assert.equal(ran.signal, null, ran.stderr.toString());
  assert.equal(ran.status, 0, ran.stderr.toString());
  assert.equal(ran.stderr.length, 0, ran.stderr.toString());
  assert.equal(ran.stdout.length % 4, 0);
  let cursor = 0;
  const word = () => {
    assert.ok(cursor < ran.stdout.length, 'complete native packet');
    const result = ran.stdout.readUInt32LE(cursor);
    cursor += 4;
    return result;
  };
  assert.equal(word(), 0x41535646);
  const resumes = word() + word() * 2 ** 32;
  const status = word();
  const states = Array.from({ length: 6 }, () => Array.from({ length: 128 }, word));
  const count = word();
  const heap = [null];
  for (let i = 0; i < count; i++) heap.push(Array.from({ length: word() }, word));
  assert.equal(cursor, ran.stdout.length, 'no trailing native output');
  return {
    status,
    resumes,
    v: states[0],
    m: states[1],
    p: states[2],
    b: states[3],
    e: states[4],
    ir: states[5],
    heap,
    used: heap.slice(1).reduce((n, a) => n + a.length, 0),
  };
}
function check(item, got) {
  const { v, m, b } = got;
  assert.equal(got.status, item.status, item.name);
  assert.equal(v[0], item.status, item.name);
  assert.equal(v[1], 11, 'terminal state');
  assert.equal(m[1], item.id ?? 0, item.name);
  if (item.kind) assert.equal(v[14], item.kind, item.name);
  if (item.line) assert.equal(v[21], item.line, item.name);
  if (item.reason) assert.equal(b[2], item.reason, item.name);
  if (item.underlying !== undefined) assert.equal(v[13], item.underlying, item.name);
  if (item.input !== undefined) assert.equal(v[23], item.input, item.name);
  if (item.evalphase) assert.equal(v[12], item.evalphase, item.name);
  if (item.ex) assert.equal(v[3] + 1, item.ex, item.name);
  if (item.cache) assert.equal(v[33] / 2, item.cache, item.name);
  const visited = item.status === 6 ? 0 : v[2] + (v[0] ? 1 : 0);
  if (item.visited !== undefined) assert.equal(visited, item.visited, item.name);
  if (item.status !== 6) {
    const scope = got.heap[m[118]];
    const functions = got.heap[m[41]];
    for (let i = 0; i < v[2]; i++)
      assert.equal(scope[functions[i * 14]], i + 1, 'previous verified function is published');
    if (item.status !== 0 && functions?.length > v[2] * 14)
      assert.equal(scope[functions[v[2] * 14]], 0, 'failing function remains unpublished');
  }
}
// Inspect the documented native grammar tables. Drop storage identities and source spans;
// preserve spec definitions, example order/deep literal shape and contract instruction IR.
const nativeOps = [
  '',
  'mov',
  'add',
  'sub',
  'mul',
  'and',
  'or',
  'xor',
  'shl',
  'shr',
  'div',
  'rem',
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
  'text',
  'get',
  'set',
  'at',
  'put',
  'read',
  'write',
  'puts',
  'cadd',
  'csub',
  'cmul',
  'cdiv',
  'crem',
  'cget',
];
function nativeSpecs({ m, p, heap }) {
  const vector = (state, offset) => {
    const count = state[offset + 1];
    if (!count) return [];
    const allocation = heap[state[offset]];
    assert.ok(allocation && count <= allocation.length, 'grammar vector fits allocation');
    return allocation.slice(0, count);
  };
  const rows = (words, stride) => {
    assert.equal(words.length % stride, 0, 'complete grammar rows');
    return Array.from({ length: words.length / stride }, (_, i) =>
      words.slice(i * stride, (i + 1) * stride),
    );
  };
  const symbols = new Map(
    rows(vector(p, 80), 5).map(([handle, start, length, , id]) => {
      const bytes = heap[handle];
      assert.ok(bytes && start + length <= bytes.length, 'symbol span fits source');
      return [id, Buffer.from(bytes.slice(start, start + length)).toString('utf8')];
    }),
  );
  const symbol = (id) => {
    assert.ok(symbols.has(id), `known grammar symbol ${id}`);
    return symbols.get(id);
  };
  const functions = rows(vector(m, 41), 14);
  const literals = rows(vector(p, 32), 6);
  const children = vector(p, 35);
  const literal = (id) => {
    const row = literals[id];
    assert.ok(row, `known grammar literal ${id}`);
    const [tag, value, first, count] = row;
    if (tag === 1) return { kind: 'u32', value };
    if (tag === 2) return { kind: 'bool', value: value !== 0 };
    assert.ok(tag === 3 || tag === 4, 'array or record literal tag');
    assert.ok(first + count <= children.length, 'literal children fit table');
    return {
      kind: tag === 3 ? 'arr' : 'rec',
      items: children.slice(first, first + count).map(literal),
    };
  };
  const arguments_ = vector(p, 38);
  const examples = rows(vector(p, 41), 8);
  const contracts = rows(vector(p, 44), 7);
  const nodes = rows(vector(p, 47), 14);
  const operands = rows(vector(p, 50), 5);
  const operand = ([kind, value]) => {
    if (kind === 0) return { kind: 'node', id: symbol(value) };
    if (kind === 1) return { kind: 'param', index: value };
    if (kind === 2) return { kind: 'u32', value };
    assert.equal(kind, 3, 'boolean operand tag');
    return { kind: 'bool', value: value !== 0 };
  };
  const contract = (id, kind, fn) => {
    if (id === 0xffffffff) return undefined;
    const row = contracts[id];
    assert.ok(row, 'known grammar contract');
    assert.equal(row[0], kind, 'pre/post contract kind');
    assert.equal(row[1], fn, 'contract belongs to definition');
    const node = nodes[row[3]];
    assert.ok(node && nativeOps[node[1]], 'known contract instruction');
    assert.ok(node[2] + node[3] <= operands.length, 'contract operands fit table');
    return {
      id: symbol(node[0]),
      op: nativeOps[node[1]],
      args: operands.slice(node[2], node[2] + node[3]).map(operand),
      ...(node[4] === 0xffffffff ? {} : { callee: symbol(node[4]) }),
      ...(node[5] === 0xffffffff ? {} : { pred: symbol(node[5]) }),
    };
  };
  return rows(vector(p, 62), 5).map(([fn, first, count, pre, post]) => {
    assert.ok(functions[fn] && first + count <= examples.length, 'complete spec definition');
    return {
      name: symbol(functions[fn][0]),
      examples: examples.slice(first, first + count).map(([owner, , start, length, result]) => {
        assert.equal(owner, fn, 'example belongs to definition');
        assert.ok(start + length <= arguments_.length, 'example arguments fit table');
        return {
          args: arguments_.slice(start, start + length).map(literal),
          result: literal(result),
        };
      }),
      pre: contract(pre, 2, fn),
      post: contract(post, 3, fn),
    };
  });
}
function referenceSpecs(program) {
  const node = (n) =>
    n === undefined
      ? undefined
      : {
          id: n.id,
          op: n.op,
          args: n.args,
          ...(n.callee === undefined ? {} : { callee: n.callee }),
          ...(n.pred === undefined ? {} : { pred: n.pred }),
        };
  return program.functions
    .filter((fn) => fn.spec !== undefined)
    .map((fn) => ({
      name: fn.name,
      examples: fn.spec.examples.map(({ args, result }) => ({ args, result })),
      pre: node(fn.spec.pre),
      post: node(fn.spec.post),
    }));
}
if (group === 'core' || group === 'fuel') {
  for (const item of cases.filter((c) => Boolean(c.heavy) === (group === 'fuel'))) {
    let reference;
    try {
      parseAndValidate(item.source);
    } catch (e) {
      assert.ok(e instanceof A0Error);
      reference = e;
    }
    assert.equal(
      reference?.id,
      item.id ? `A${String(item.id).padStart(4, '0')}` : undefined,
      item.name,
    );
    let first;
    for (const quantum of [1, 7]) {
      const got = invoke(item.source, quantum);
      check(item, got);
      if (reference?.spec && [715, 716, 719].includes(item.id)) {
        assert.equal(reference.spec.ex, got.v[3] + 1);
        assert.equal(reference.spec.line, ['', 'ex', 'pre', 'post'][got.v[21]]);
        assert.equal('input' in reference.spec, got.v[23] !== 0);
        assert.equal(got.m[2], 0, 'semantic diagnostic line is absent');
      }
      const summary = [
        got.status,
        got.m[1],
        got.b[2],
        got.v[2],
        got.v[3],
        got.v[14],
        got.v[21],
        got.v[12],
        got.v[13],
        got.v[23],
      ];
      if (first) assert.deepEqual(summary, first, 'scheduling quantum does not change semantics');
      else first = summary;
    }
  }
} else if (group === 'capacity') {
  const count = LIMITS.maxArrayLength;
  const array = `[${Array(count).fill('0').join(';')}]`;
  const item = {
    name: 'full-width-literal-import-and-equality',
    source: simple(`ex ${array} ->${array}`, 'ret p0', `u32x${count}`, `u32x${count}`),
    status: 0,
    cache: 2 * (count + 1),
  };
  parseAndValidate(item.source);
  const got = invoke(item.source, 17);
  check(item, got);
  assert.ok(got.v[6] > 65535, 'expected literal ID crosses the old 16-bit region');
} else if (group === 'boundaries') {
  const source = cases.find((c) => c.name === 'matching-pre-post').source;
  const pending = invoke(source, 0, 1);
  assert.equal(pending.status, 7);
  assert.equal(pending.v[1], 0);
  assert.equal(pending.v[2], 0);
  for (const phase of [3, 5, 6]) {
    const prefix = invoke(source, 1, phase);
    assert.equal(prefix.status, 7);
    assert.equal(prefix.v[1], phase);
    const bounded = invoke(source, 1, 0, prefix.used + 1);
    assert.equal(bounded.status, 4, 'arena budget stays a resource error');
    assert.equal(bounded.v[0], 4);
    assert.equal(bounded.v[1], 11);
    assert.equal(bounded.m[1], 0, 'resource failure does not invent a spec diagnostic');
    assert.equal(bounded.v[20], 0);
  }
} else if (group === 'shared-source') {
  for (const item of [...sharedCases, ...legacyAdjacencyCases]) {
    let reference;
    try {
      parseAndValidate(item.canonical);
    } catch (e) {
      assert.ok(e instanceof A0Error);
      reference = e;
    }
    assert.equal(
      reference?.id,
      item.id ? `A${String(item.id).padStart(4, '0')}` : undefined,
      item.name,
    );
    const expected = item.status === 6 ? undefined : referenceSpecs(parse(item.canonical));
    let first;
    for (const source of [item.canonical, item.flat]) {
      for (const standalone of [false, true]) {
        for (const quantum of [1, 7]) {
          const got = invoke(source, quantum, 0, 16_000_000, standalone);
          check(item, got);
          const summary = [
            got.status,
            got.m[1],
            got.b[2],
            got.v[2],
            got.v[3],
            got.v[14],
            got.v[21],
            got.v[12],
            got.v[13],
            got.v[23],
          ];
          if (first)
            assert.deepEqual(
              summary,
              first,
              `${item.name}: same first failure and scheduling semantics`,
            );
          else first = summary;
          if (expected !== undefined) {
            assert.equal(got.p[92], 1, 'grammar directory is complete');
            assert.equal(got.m[60], 128, 'persisted grammar directory has full state');
            assert.deepEqual(
              nativeSpecs(got),
              expected,
              `${item.name}: source spelling and fresh/persisted AST agree`,
            );
          }
        }
      }
    }
  }
  const source = 'fn f\nex 7 ->7\npre lt A 10\npost eq r A\nx mov A\nret x\nend\n';
  for (const standalone of [false, true]) {
    const prefix = invoke(source, 1, 3, 16_000_000, standalone);
    assert.equal(prefix.status, 7);
    assert.equal(prefix.v[1], 3);
    const bounded = invoke(source, 1, 0, prefix.used + 1, standalone);
    assert.equal(bounded.status, 4, 'fresh/persisted resource failures stay explicit');
    assert.equal(bounded.v[0], 4);
    assert.equal(bounded.v[1], 11);
    assert.equal(bounded.m[1], 0, 'resource failure does not invent a grammar diagnostic');
    assert.equal(bounded.v[20], 0);
  }
} else assert.fail(`unknown group ${group}`);
assert.ok(requests > 0);
console.log(JSON.stringify({ group, requests, status: 'passed' }));
