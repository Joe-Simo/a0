import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import {
  type Func,
  formatProgram,
  formatSource,
  type Program,
  run,
  type Type,
  validate,
} from '../src/core.js';
import { link } from '../src/link.js';
import { type NativeApi, nativeSource, nativeSourceApi } from '../src/source-native.js';
import { nativeSourceArtifact } from '../tools/source-native-artifact.js';

const scalar = (value: number) => ({ kind: 'u32' as const, value });
const parameter = (index: number) => ({ kind: 'param' as const, index });
const reference = (id: string) => ({ kind: 'node' as const, id });
function program(): Program {
  return {
    profile: 'strict',
    profileComments: { leading: ['# profile metadata'] },
    uses: ['metadata-only/λ.a0'],
    useComments: [{ trailing: '# retained import metadata' }],
    functions: [
      {
        name: 'increment',
        params: ['u32'],
        result: 'u32',
        nodes: [
          {
            id: 'next',
            op: 'add',
            args: [parameter(0), scalar(1)],
            comments: { leading: ['# node comment'] },
          },
        ],
        ret: reference('next'),
        comments: { leading: ['# header'], trailing: '# increment' },
        retComments: { trailing: '# returned' },
        endComments: { leading: ['# end'] },
        afterComments: ['# between functions'],
        spec: {
          examples: [
            { args: [scalar(9)], result: scalar(10), comments: { trailing: '# example' } },
          ],
          pre: {
            id: 'pre',
            op: 'lt',
            args: [parameter(0), scalar(100)],
            comments: { leading: ['# pre'] },
          },
          post: {
            id: 'post',
            op: 'gt',
            args: [reference('r'), parameter(0)],
            comments: { trailing: '# post' },
          },
        },
      },
      {
        name: 'twice',
        params: ['u32'],
        result: 'u32',
        nodes: [
          { id: 'first', op: 'call', callee: 'increment', args: [parameter(0)] },
          { id: 'second', op: 'call', callee: 'increment', args: [reference('first')] },
        ],
        ret: reference('second'),
        afterComments: ['# file tail'],
        spec: { examples: [{ args: [scalar(3)], result: scalar(5) }] },
      },
    ],
  };
}

test('structured Program checking bypasses every source parser and preserves checked IR and metadata', async () => {
  const module = await nativeSourceArtifact();
  const api = new WebAssembly.Instance(module).exports as unknown as NativeApi;
  const engine = nativeSourceApi({
    ...api,
    frontend_parse() {
      throw new Error('structured checking called the source parser');
    },
    frontend_parse_unit() {
      throw new Error('structured checking called the source-unit parser');
    },
  });
  try {
    const input = program();
    const expected = validate(input);
    const result = engine.checkProgram(input);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(formatSource(result.program), formatSource(input));
    assert.equal(formatProgram(result.typed), formatProgram(expected));
    const twice = result.typed.byName.get('twice');
    assert.ok(twice);
    assert.equal(run(twice, [17]), 19);
    assert.equal(twice.profile, 'strict');
    assert.equal(twice.calls.get('increment'), result.typed.byName.get('increment'));
    assert.notEqual(result.program.functions[0]?.comments, input.functions[0]?.comments);
    assert.notEqual(
      result.program.functions[0]?.nodes[0]?.comments,
      input.functions[0]?.nodes[0]?.comments,
    );
  } finally {
    engine.close();
  }
});

test('structured native checking detects invalid edits and specification failures', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  const base: Func = {
    name: 'value',
    params: ['u32'],
    result: 'u32',
    nodes: [],
    ret: parameter(0),
  };
  const invalid: Program[] = [
    { functions: [base, base] },
    { functions: [{ ...base, params: Array<Type>(65).fill('u32') }] },
    {
      functions: [
        {
          ...base,
          nodes: Array.from({ length: 4097 }, (_, index) => ({
            id: `n${index}`,
            op: 'mov' as const,
            args: [parameter(0)],
          })),
        },
      ],
    },
    { functions: [{ ...base, ret: reference('missing') }] },
    { functions: [{ ...base, result: 'bool' }] },
    {
      functions: [
        {
          ...base,
          nodes: [{ id: 'sum', op: 'add', args: [parameter(0), { kind: 'bool', value: true }] }],
        },
      ],
    },
    { functions: [{ ...base, nodes: [{ id: 'sum', op: 'add', args: [parameter(0)] }] }] },
    {
      functions: [
        {
          ...base,
          nodes: [
            { id: 'sum', op: 'add', args: [parameter(0), scalar(1)] },
            { id: 'sum', op: 'add', args: [parameter(0), scalar(2)] },
          ],
        },
      ],
    },
    {
      functions: [
        {
          ...base,
          nodes: [{ id: 'called', op: 'call', callee: 'later', args: [parameter(0)] }],
          ret: reference('called'),
        },
        { ...base, name: 'later' },
      ],
    },
    { functions: [{ ...base, spec: { examples: [{ args: [scalar(1)], result: scalar(2) }] } }] },
    {
      functions: [
        {
          ...base,
          spec: {
            examples: [1, 2, 3, 4].map((value) => ({
              args: [scalar(value)],
              result: scalar(value),
            })),
          },
        },
      ],
    },
    {
      functions: [
        {
          ...base,
          spec: {
            examples: [{ args: [scalar(1)], result: scalar(1) }],
            pre: { id: 'pre', op: 'lt', args: [parameter(0), scalar(0)] },
          },
        },
      ],
    },
    {
      functions: [
        {
          ...base,
          spec: {
            examples: [{ args: [scalar(1)], result: scalar(1) }],
            post: { id: 'post', op: 'eq', args: [reference('r'), scalar(2)] },
          },
        },
      ],
    },
  ];
  try {
    for (const input of invalid) {
      assert.throws(() => validate(input));
      const result = engine.checkProgram(input);
      assert.equal(result.ok, false, formatProgram(input));
    }
    const valid = engine.checkProgram({ functions: [base] });
    assert.ok(valid.ok);
    const checked = valid.typed.functions[0];
    assert.ok(checked);
    assert.equal(run(checked, [123]), 123);
  } finally {
    engine.close();
  }
});

test('structured checking preserves aggregate type identity, nested literals and wide arrays', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  const nested: Type = {
    kind: 'rec',
    fields: ['u32', 'bool', { kind: 'arr', elem: 'u32', length: 3 }],
  };
  const wide: Type = { kind: 'arr', elem: 'u32', length: 65536 };
  const text = 'λ☃\n';
  const bytes = [...new TextEncoder().encode(text)];
  const literal = {
    kind: 'rec' as const,
    items: [
      scalar(42),
      { kind: 'bool' as const, value: true },
      { kind: 'arr' as const, items: [scalar(1), scalar(2), scalar(3)] },
    ],
  };
  const input: Program = {
    functions: [
      {
        name: 'nested',
        params: [nested],
        result: nested,
        nodes: [],
        ret: parameter(0),
        spec: { examples: [{ args: [literal], result: literal }] },
      },
      { name: 'wide', params: [wide], result: wide, nodes: [], ret: parameter(0) },
      {
        name: 'message',
        params: [],
        result: { kind: 'arr', elem: 'u32', length: bytes.length },
        nodes: [{ id: 'bytes', op: 'arr', args: bytes.map(scalar), text }],
        ret: reference('bytes'),
      },
    ],
  };
  try {
    const result = engine.checkProgram(input);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(formatProgram(result.typed), formatProgram(validate(input)));
    assert.equal(formatSource(result.program), formatSource(input));
    const nestedFn = result.typed.byName.get('nested');
    assert.ok(nestedFn);
    assert.equal(nestedFn.params[0], nestedFn.result, 'A0 interners own structural type identity');
    assert.deepEqual(run(nestedFn, [[42, true, [1, 2, 3]]]), [42, true, [1, 2, 3]]);
  } finally {
    engine.close();
  }
});

test('structured examples preserve result ordering when literal objects are shared across edits', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  const zero = scalar(0);
  const input: Program = {
    functions: [
      {
        name: 'zero',
        params: ['u32'],
        result: 'u32',
        nodes: [],
        ret: scalar(0),
        spec: {
          examples: [
            { args: [scalar(1)], result: zero },
            { args: [scalar(2)], result: zero },
            { args: [scalar(3)], result: zero },
          ],
        },
      },
    ],
  };
  try {
    const result = engine.checkProgram(input);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(formatProgram(result.typed), formatProgram(validate(input)));
  } finally {
    engine.close();
  }
});

test('structured checking preserves IO linearity and strict executable example traps', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  const token: Func = { name: 'token', params: ['io'], result: 'io', nodes: [], ret: parameter(0) };
  try {
    assert.ok(engine.checkProgram({ profile: 'strict', functions: [token] }).ok);
    const reused: Program = {
      functions: [
        {
          ...token,
          nodes: [
            { id: 'first', op: 'write', args: [parameter(0), scalar(1)] },
            { id: 'second', op: 'write', args: [parameter(0), scalar(2)] },
          ],
          ret: reference('second'),
        },
      ],
    };
    assert.throws(() => validate(reused));
    assert.equal(engine.checkProgram(reused).ok, false);
    const division: Program = {
      functions: [
        {
          name: 'divide',
          params: ['u32'],
          result: 'u32',
          nodes: [{ id: 'quotient', op: 'div', args: [parameter(0), scalar(0)] }],
          ret: reference('quotient'),
          spec: { examples: [{ args: [scalar(7)], result: scalar(0xffffffff) }] },
        },
      ],
    };
    assert.ok(engine.checkProgram(division).ok);
    assert.equal(engine.checkProgram({ ...division, profile: 'strict' }).ok, false);
  } finally {
    engine.close();
  }
});

test('structured checking keeps owned source-unit snapshots, allocation limits and lifecycle rules', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  const unit = engine.parseUnit('fn saved u32 -> u32\nret p0\nend\n');
  assert.ok(unit.ok);
  const input = program();
  assert.equal(engine.checkProgram(input, 0).ok, false);
  assert.ok(engine.checkProgram(input).ok);
  assert.ok(engine.checkUnits([unit], 'canonical').ok);
  for (const budget of [-1, NaN, 0x100000000])
    assert.throws(
      () => engine.checkProgram(input, budget),
      /invalid source frontend allocation budget/,
    );
  for (const value of [-1, 0.5, 0x100000000])
    assert.throws(
      () =>
        engine.checkProgram({
          functions: [
            { name: 'invalid', params: [], result: 'u32', nodes: [], ret: scalar(value) },
          ],
        }),
      /unrepresentable native program IR/,
    );
  const cyclic: { kind: 'rec'; fields: Type[] } = { kind: 'rec', fields: [] };
  cyclic.fields.push(cyclic);
  assert.throws(
    () =>
      engine.checkProgram({
        functions: [
          { name: 'cyclic', params: [cyclic], result: cyclic, nodes: [], ret: parameter(0) },
        ],
      }),
    /cyclic type/,
  );
  assert.ok(engine.checkProgram(input).ok);
  engine.close();
  engine.close();
  assert.throws(() => engine.checkProgram(input), /source frontend is closed/);
});

test('structured checking preserves executable output for a complete application and the compiler graph', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  try {
    for (const entry of ['examples/life.a0', 'compiler/source_frontend.a0']) {
      const expected = (await link(entry, (path) => readFile(path, 'utf8'))).program;
      const result = engine.checkProgram(expected);
      assert.ok(result.ok, `${entry}: ${JSON.stringify(result)}`);
      assert.equal(formatProgram(result.typed), formatProgram(expected), entry);
      assert.equal(compile(result.typed, 'c').text, compile(expected, 'c').text, entry);
    }
  } finally {
    engine.close();
  }
});
