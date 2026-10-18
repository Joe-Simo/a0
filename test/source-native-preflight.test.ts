import assert from 'node:assert/strict';
import test from 'node:test';
import { A0Error, type Func, type Program, type Type, validate } from '../src/core.js';
import { nativeSource } from '../src/source-native.js';
import { nativeSourceArtifact } from '../tools/source-native-artifact.js';

const parameter = { kind: 'param' as const, index: 0 };
const base: Func = { name: 'valid', params: ['u32'], result: 'u32', nodes: [], ret: parameter };
function diagnostic(program: Program): number {
  try {
    validate(program);
    return 0;
  } catch (error) {
    assert.ok(error instanceof A0Error && error.id);
    return Number(error.id.slice(1));
  }
}
function parity(engine: ReturnType<typeof nativeSource>, program: Program, label: string): void {
  const expected = diagnostic(program),
    result = engine.checkProgram(program);
  assert.equal(result.ok, expected === 0, label);
  if (!result.ok) assert.equal(result.state[1], expected, label);
}

test('native structured names use the source grammar classifier with function/node distinctions', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  const names = [
    '',
    'a',
    'a0',
    'a_b',
    'a'.repeat(64),
    'a'.repeat(65),
    'fn',
    'ret',
    'end',
    'patch',
    'true',
    'false',
    'use',
    'profile',
    'strict',
    'text',
    'ex',
    'pre',
    'post',
    'add',
    'div',
    'udiv',
    'loop',
    'p',
    'p0',
    'p1',
    'p00',
    'p01',
    'p4294967296',
    `p${'9'.repeat(63)}`,
    `p${'9'.repeat(64)}`,
    'Bad',
    'A',
    '_a',
    'a-b',
    'λ',
    'aλ',
    'a b',
    'a\n',
    'a\0',
  ];
  try {
    for (const name of names) {
      parity(engine, { functions: [{ ...base, name }] }, `function ${JSON.stringify(name)}`);
      parity(
        engine,
        {
          functions: [
            {
              ...base,
              nodes: [{ id: name, op: 'mov', args: [parameter] }],
              ret: { kind: 'node', id: name },
            },
          ],
        },
        `node ${JSON.stringify(name)}`,
      );
    }
  } finally {
    engine.close();
  }
});

test('native structured preflight preserves first-failure precedence across body and spec phases', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  const invalidName: Func = { ...base, name: 'Bad' };
  const invalidNode: Func = {
    ...base,
    nodes: [{ id: 'Bad', op: 'add', args: [parameter] }],
    ret: { kind: 'node', id: 'Bad' },
  };
  const cases: readonly (readonly [string, Program])[] = [
    [
      'function spelling before parameter bound',
      { functions: [{ ...invalidName, params: Array<Type>(65).fill('u32') }] },
    ],
    ['duplicate function before later body spelling', { functions: [base, invalidNode] }],
    ['node spelling before arity', { functions: [invalidNode] }],
    [
      'parameter bound before node spelling',
      { functions: [{ ...invalidNode, params: Array<Type>(65).fill('u32') }] },
    ],
    [
      'node count before node spelling',
      {
        functions: [
          {
            ...base,
            nodes: Array.from(
              { length: 4097 },
              () => invalidNode.nodes[0] as Func['nodes'][number],
            ),
          },
        ],
      },
    ],
    [
      'earlier body type before later spelling',
      { functions: [{ ...base, result: 'bool' }, invalidName] },
    ],
    [
      'earlier body reference before later spelling',
      { functions: [{ ...base, ret: { kind: 'node', id: 'missing' } }, invalidName] },
    ],
    [
      'earlier example before later spelling',
      {
        functions: [
          {
            ...base,
            spec: {
              examples: [{ args: [{ kind: 'u32', value: 1 }], result: { kind: 'u32', value: 2 } }],
            },
          },
          invalidName,
        ],
      },
    ],
    [
      'node spelling before duplicate',
      {
        functions: [
          {
            ...invalidNode,
            nodes: [
              invalidNode.nodes[0] as Func['nodes'][number],
              invalidNode.nodes[0] as Func['nodes'][number],
            ],
          },
        ],
      },
    ],
  ];
  try {
    for (const [name, input] of cases) parity(engine, input, name);
  } finally {
    engine.close();
  }
});

test('native preflight leaves the original spec-expression id outside body identifier rules', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  const input: Program = {
    functions: [
      {
        ...base,
        spec: {
          examples: [{ args: [{ kind: 'u32', value: 1 }], result: { kind: 'u32', value: 1 } }],
          pre: { id: 'Bad', op: 'lt', args: [parameter, { kind: 'u32', value: 2 }] },
          post: { id: 'p0', op: 'eq', args: [{ kind: 'node', id: 'r' }, parameter] },
        },
      },
    ],
  };
  try {
    parity(engine, input, 'spec expression ids are not body ids');
  } finally {
    engine.close();
  }
});

test('native global function count is checked before names and retains the accepted boundary', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  const functions: Func[] = Array.from({ length: 65536 }, (_, index) => ({
    name: `f${index}`,
    params: [],
    result: 'u32',
    nodes: [],
    ret: { kind: 'u32', value: 0 },
  }));
  const budget = 0xffff_ffff;
  try {
    const accepted = engine.checkProgram({ functions }, budget);
    assert.ok(accepted.ok, JSON.stringify({ status: accepted.status, state: accepted.state }));
    assert.equal(accepted.typed.functions.length, 65536);
    const excessive: Program = {
      functions: [{ ...(functions[0] as Func), name: 'Bad' }, ...functions.slice(1), base],
    };
    assert.equal(diagnostic(excessive), 29);
    const rejected = engine.checkProgram(excessive, budget);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.state[1], 29, 'global count outranks the invalid first function name');
    assert.equal(rejected.state[109], 0xffff_ffff, 'a global error has no selected function');
  } finally {
    engine.close();
  }
});
