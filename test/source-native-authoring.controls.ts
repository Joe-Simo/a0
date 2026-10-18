/** Independent authoring controls over actual C-derived/direct/JS artifacts; no skipped targets. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import {
  A0Error,
  type Func,
  formatFunction,
  formatProgram,
  isPrimitive,
  lineComment,
  type Node,
  type Program,
  type Type,
  type TypedFunc,
  type TypedProgram,
  validate,
} from '../src/core.js';
import { link } from '../src/link.js';
import { formatSource } from '../src/source.js';
import { type DirectFunction, directSource } from '../src/source-direct.js';
import { linkSource } from '../src/source-link.js';
import { type NativeSourceResult, nativeSource } from '../src/source-native.js';
import type { NativeFormatOptions } from '../src/source-native-format.js';
import type { NativeDiagnosticOptions } from '../src/source-native-render.js';
import { withoutSpec } from '../src/spec.js';
import { prepareJsSource } from '../tools/source-js-load.js';
import {
  prepareSourceDiagnostic,
  prepareSourceFormat,
  prepareSourceFrontend,
} from '../tools/source-native-load.js';

const frontendPath = process.env.A0_FORMAT_FRONTEND;
const formatPath = process.env.A0_FORMAT_COMPANION;
const arenaPath = process.env.A0_FORMAT_ARENA;
const diagnosticPath = process.env.A0_FORMAT_DIAGNOSTIC;
const jsPath = process.env.A0_FORMAT_JS;
assert.ok(
  frontendPath && formatPath && arenaPath && diagnosticPath && jsPath,
  'A0_FORMAT_FRONTEND/COMPANION/ARENA/DIAGNOSTIC/JS required',
);
const companion = await prepareSourceFormat(formatPath);
const diagnostic = await prepareSourceDiagnostic(diagnosticPath);
const js = await prepareJsSource(jsPath);
const native = await prepareSourceFrontend(frontendPath);
assert.equal(native.build.diagnosticPorts, 'arena-v1');
const frontend = new WebAssembly.Module(await readFile(join(frontendPath, 'frontend.wasm')));
const arena = new WebAssembly.Module(await readFile(arenaPath));
const linked = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
assert.equal(sha(formatProgram(linked.program)), native.build.sourceSHA256);
const names = [
  'arena_parse_verify_begin',
  'arena_source_unit',
  'arena_verify_resume',
  'arena_verify_status',
  'arena_verify_begin',
  'source_ir_init',
  'source_ir_symbol',
  'source_ir_type',
];
const words = (type: Type): number =>
  isPrimitive(type)
    ? 1
    : type.kind === 'arr'
      ? type.length * words(type.elem)
      : type.fields.reduce((sum, field) => sum + words(field), 0);
const shape = (type: Type) => ({ words: words(type), scalar: isPrimitive(type) });
const functions: Record<string, DirectFunction> = {};
for (const name of names) {
  const fn = linked.program.byName.get(name);
  assert.ok(fn, name);
  functions[name] = { params: fn.params.map(shape), result: shape(fn.result) };
}
const direct = new WebAssembly.Module(
  Buffer.from(
    compile(linked.program, 'wasm', {
      wasmExports: names,
      wasmSimd: true,
      optimize: true,
      wasmIo: { module: 'a0_arena', read: 'a0_runtime_read', write: 'a0_runtime_write' },
    }).text,
    'base64',
  ),
);
const factories = [
  [
    'C-derived',
    (formatting?: NativeFormatOptions, diagnostics?: NativeDiagnosticOptions) =>
      nativeSource(frontend, diagnostics, formatting),
  ],
  [
    'direct',
    (formatting?: NativeFormatOptions, diagnostics?: NativeDiagnosticOptions) =>
      directSource({ frontend: direct, arena, functions }, diagnostics, formatting),
  ],
  [
    'JS',
    (formatting?: NativeFormatOptions, diagnostics?: NativeDiagnosticOptions) =>
      js.instantiate(diagnostics, formatting),
  ],
] as const;
type Engine = ReturnType<typeof nativeSource>;
const scalar = (value: number) => ({ kind: 'u32' as const, value });
const parameter = (index: number) => ({ kind: 'param' as const, index });
const reference = (id: string) => ({ kind: 'node' as const, id });
const identity: Func = {
  name: 'identity',
  params: ['u32'],
  result: 'u32',
  nodes: [],
  ret: parameter(0),
};
const text = 'Ω 😀 # "\t\\\n\ufeff';

/** Construct IR directly: these checks cannot acquire metadata by parsing formatted source. */
function authoredProgram(): Program {
  return {
    profile: 'strict',
    profileComments: { leading: ['# profile Ω', '# profile 😀'], trailing: '# strict profile' },
    uses: ['metadata/λ.a0', 'metadata/😀 #.a0'],
    useComments: [
      { leading: ['# first use'], trailing: '# imported λ' },
      { leading: ['# second use'], trailing: '# imported 😀' },
    ],
    functions: [
      {
        name: 'increment',
        params: ['u32'],
        result: 'u32',
        comments: { leading: ['# increment header'], trailing: '# header inline' },
        nodes: [
          {
            id: 'bytes',
            op: 'arr',
            args: [...new TextEncoder().encode(text)].map(scalar),
            text,
            comments: { leading: ['# text node Ω'], trailing: '# quoted hash stays text' },
          },
          {
            id: 'next',
            op: 'add',
            args: [parameter(0), scalar(1)],
            comments: { leading: ['# arithmetic node'], trailing: '# next value' },
          },
        ],
        ret: reference('next'),
        retComments: { leading: ['# before return'], trailing: '# return inline' },
        endComments: { leading: ['# before end'], trailing: '# end inline' },
        spec: {
          examples: [
            {
              args: [scalar(9)],
              result: scalar(10),
              comments: { leading: ['# first example'], trailing: '# example inline' },
            },
            { args: [scalar(0)], result: scalar(1), comments: { trailing: '# second example' } },
          ],
          pre: {
            id: 'pre',
            op: 'lt',
            args: [parameter(0), scalar(100)],
            comments: { leading: ['# precondition'], trailing: '# pre inline' },
          },
          post: {
            id: 'post',
            op: 'gt',
            args: [reference('r'), parameter(0)],
            comments: { leading: ['# postcondition'], trailing: '# post inline' },
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
        comments: { leading: ['# caller header'], trailing: '# caller inline' },
        afterComments: ['# final tail Ω', '# final tail 😀'],
        spec: { examples: [{ args: [scalar(3)], result: scalar(5) }] },
      },
    ],
  };
}

function bareNode(node: Node): Node {
  const { comments: _comments, ...bare } = node;
  return bare;
}
function bareFunction(fn: Func): Func {
  const {
    comments: _comments,
    retComments: _retComments,
    endComments: _endComments,
    afterComments: _afterComments,
    ...bare
  } = fn;
  return {
    ...bare,
    nodes: fn.nodes.map(bareNode),
    ...(fn.spec === undefined
      ? {}
      : {
          spec: {
            examples: fn.spec.examples.map(({ args, result }) => ({ args, result })),
            ...(fn.spec.pre === undefined ? {} : { pre: bareNode(fn.spec.pre) }),
            ...(fn.spec.post === undefined ? {} : { post: bareNode(fn.spec.post) }),
          },
        }),
  };
}
function flat(program: Program, scope: 'source' | 'program' | 'function', id: number): string {
  if (scope === 'source') return formatSource(program);
  const selected = scope === 'function' ? [program.functions[id] as Func] : program.functions;
  const output = formatSource({
    functions: selected.map(bareFunction),
    ...(scope !== 'function' && program.profile === 'strict' ? { profile: 'strict' as const } : {}),
  });
  return scope === 'function' ? output.slice(0, -1) : output;
}
function semanticOracle(fn: TypedFunc, memo = new WeakMap<TypedFunc, string>()): string {
  const previous = memo.get(fn);
  if (previous !== undefined) return previous;
  const own = sha(formatFunction(withoutSpec(fn)));
  let joined = fn.profile === 'strict' ? `profile strict|${own}` : own;
  for (const name of [...fn.calls.keys()].sort()) {
    const callee = fn.calls.get(name);
    assert.ok(callee);
    joined += `|${name}=${semanticOracle(callee, memo)}`;
  }
  const result = sha(joined);
  memo.set(fn, result);
  return result;
}

function assertOutputs(
  engine: Engine,
  result: NativeSourceResult,
  program: Program,
  typed: TypedProgram,
): void {
  assert.ok(result.ok, `checker status ${result.status}`);
  assert.equal(formatSource(result.program), formatSource(program), 'checked host metadata');
  const state = [...result.state],
    specs = [...result.specState];
  for (const skipSpecs of [false, true]) {
    const selected = skipSpecs
      ? { ...program, functions: program.functions.map(withoutSpec) }
      : program;
    for (const scope of ['source', 'program', 'function'] as const) {
      const ids = scope === 'function' ? selected.functions.map((_, id) => id) : [0];
      for (const functionIndex of ids) {
        const expected = flat(selected, scope, functionIndex);
        for (const mapping of [false, true]) {
          const formatted = engine.format(result, { scope, functionIndex, skipSpecs, mapping });
          assert.ok(
            formatted.ok,
            `${scope}/${functionIndex}/${skipSpecs}: ${JSON.stringify(formatted)}`,
          );
          assert.equal(formatted.text, expected);
          assert.deepEqual(formatted.bytes, new TextEncoder().encode(expected));
          assert.equal(formatted.events.length % 6, 0);
          assert.equal(formatted.facts[9], formatted.bytes.length);
          const comments: string[] = [];
          for (let offset = 0; offset < formatted.events.length; offset += 6) {
            const start = formatted.events[offset + 3] as number,
              count = formatted.events[offset + 4] as number;
            assert.ok(start <= formatted.bytes.length && count <= formatted.bytes.length - start);
            if (formatted.events[offset] === 16)
              comments.push(
                new TextDecoder().decode(formatted.bytes.subarray(start, start + count)),
              );
          }
          if (!mapping) assert.equal(formatted.events.length, 0);
          else
            assert.deepEqual(
              comments,
              expected.split('\n').flatMap((line) => {
                const comment = lineComment(line);
                return comment === undefined ? [] : [comment];
              }),
              'every represented comment has its own exact output mapping',
            );
        }
      }
    }
  }
  const whole = engine.revision(result, { kind: 'program' });
  assert.ok(whole.ok);
  assert.equal(whole.revision, sha(formatProgram(program)));
  for (const [functionIndex, fn] of typed.functions.entries()) {
    const own = engine.revision(result, { kind: 'function', functionIndex });
    assert.ok(own.ok);
    assert.equal(own.revision, sha(formatFunction(fn)));
    const semantic = engine.revision(result, { kind: 'semantic', functionIndex });
    assert.ok(semantic.ok);
    assert.equal(semantic.revision, semanticOracle(fn));
  }
  assert.deepEqual(result.state, state, 'formatting preserves private parser state');
  assert.deepEqual(result.specState, specs, 'formatting preserves private spec state');
}

async function graphOracle(sources: readonly string[]) {
  const paths = sources.map(
    (_, id) => `/authoring-controls/${id === sources.length - 1 ? 'entry' : `unit${id}`}.a0`,
  );
  const files = new Map(paths.map((path, id) => [path, sources[id] as string]));
  return linkSource(
    paths.at(-1) as string,
    async (path) => {
      const source = files.get(path);
      assert.notEqual(source, undefined, path);
      return source as string;
    },
    { root: '/authoring-controls', canonicalPath: async (path) => path },
  );
}

for (const [backend, factory] of factories) {
  test(`${backend}: structured authoring preserves every comment attachment, Unicode text and revision`, () => {
    const engine = factory(companion, diagnostic);
    try {
      const program = authoredProgram(),
        input = JSON.stringify(program),
        typed = validate(program);
      const result = engine.checkProgram(program, 100_000_000);
      assertOutputs(engine, result, program, typed);
      assert.equal(JSON.stringify(program), input, 'authoring never mutates input IR');
      assert.ok(result.ok);
      for (const target of ['c', 'js', 'wasm'] as const)
        assert.equal(compile(result.typed, target).text, compile(typed, target).text, target);
      const before = engine.format(result, { mapping: true });
      assert.ok(before.ok);
      (result.state as number[]).fill(0xffff_ffff);
      (result.specState as number[]).fill(0xffff_ffff);
      Object.assign(result.program, { functions: [] });
      Object.assign(program, { tailComments: ['# caller mutation'] });
      const after = engine.format(result, { mapping: true });
      assert.ok(after.ok);
      assert.equal(after.text, before.text, 'caller cannot forge encoded metadata');
      assert.deepEqual(after.events, before.events);
    } finally {
      engine.close();
    }
  });

  test(`${backend}: empty programs, strict declarations, uses and file-only tails retain source output`, () => {
    const engine = factory(companion);
    try {
      const programs: Program[] = [
        { functions: [] },
        { functions: [], tailComments: ['# only Ω', '# only 😀'] },
        { functions: [], profile: 'strict', profileComments: { trailing: '# strict only' } },
        {
          functions: [],
          profile: 'strict',
          profileComments: { leading: ['# empty profile'], trailing: '# empty strict' },
          uses: ['empty/λ.a0'],
          useComments: [{ leading: ['# empty import'], trailing: '# imported 😀' }],
          tailComments: ['# empty tail'],
        },
        { functions: [identity] },
      ];
      for (const program of programs)
        assertOutputs(engine, engine.checkProgram(program), program, validate(program));
    } finally {
      engine.close();
    }
  });

  test(`${backend}: composed ownership follows the independent linker and retains original origin sidecars`, async () => {
    const engine = factory(companion, diagnostic);
    try {
      for (const strict of [false, true]) {
        const profile = strict
          ? '# repeated Ω\n# profile Ω\nprofile strict # profile inline\n'
          : '';
        const sources = [
          `${profile}# repeated Ω\n# helper header\nfn helper\n# helper example\nex 3 -> 4 # example\na add A 1 # arithmetic\nret a # helper return\nend # helper end\n# repeated Ω\n# between Ω\n`,
          `${profile}# repeated Ω\n# wrapper import\nuse "unit0.a0" # wrapper inline\n# empty wrapper tail 😀\n# repeated Ω\n`,
          `${profile}# repeated Ω\n# entry import\nuse "unit1.a0" # entry inline\n# top header\nfn top\nex 3 -> 4 # top example\npre lt A 10 # top pre\npost gt r A # top post\nx helper A # top call\nret x # top return\nend # top end\n# final Ω\n# repeated Ω\n`,
        ];
        const expected = await graphOracle(sources);
        const units = sources.map((source) => engine.parseUnit(source));
        assert.ok(units.every((unit) => unit.ok));
        const result = engine.checkUnits(units, strict ? 'strict' : 'canonical', 100_000_000);
        assertOutputs(engine, result, expected.program, expected.program);
        const mapped = engine.format(result, { mapping: true });
        assert.ok(mapped.ok);
        const repeated: number[] = [];
        for (let offset = 0; offset < mapped.events.length; offset += 6) {
          if (mapped.events[offset] !== 16) continue;
          const start = mapped.events[offset + 3] as number,
            count = mapped.events[offset + 4] as number;
          if (
            new TextDecoder().decode(mapped.bytes.subarray(start, start + count)) === '# repeated Ω'
          )
            repeated.push(mapped.events[offset + 1] as number);
        }
        assert.ok(repeated.length >= 6);
        assert.equal(
          new Set(repeated).size,
          repeated.length,
          'identical strings from distinct source occurrences keep distinct identities',
        );
        let byteStart = 0,
          firstLine = 1;
        for (const [index, source] of sources.entries()) {
          const lineCount = source.split('\n').length;
          assert.deepEqual(result.origins[index], {
            firstLine,
            lineCount,
            byteStart,
            byteLength: Buffer.byteLength(source),
          });
          firstLine += lineCount;
          byteStart += Buffer.byteLength(source) + (index + 1 < sources.length ? 1 : 0);
        }
        assert.deepEqual(
          result.origins.map(({ firstLine, lineCount }) => ({ firstLine, lineCount })),
          expected.sources.map(({ startLine, lineCount }) => ({ firstLine: startLine, lineCount })),
        );
      }
    } finally {
      engine.close();
    }
  });

  test(`${backend}: unsupported authoring metadata explicitly refuses formatting while checker semantics survive`, () => {
    let loads = 0;
    const engine = factory(
      {
        load: () => {
          loads++;
          return companion.load();
        },
      },
      diagnostic,
    );
    const plain = factory(undefined, diagnostic);
    try {
      const bytes: Node = { id: 'bytes', op: 'arr', args: [scalar(65)], text: 'A' };
      const rows = [
        {
          detail: 'intermediate-tail',
          program: {
            functions: [
              { ...identity, afterComments: ['# between'] },
              { ...identity, name: 'second' },
            ],
          },
          text: false,
        },
        {
          detail: 'empty-tail',
          program: { functions: [{ ...identity, afterComments: [] }] },
          text: false,
        },
        {
          detail: 'program-tail',
          program: { functions: [identity], tailComments: ['# extra'] },
          text: false,
        },
        {
          detail: 'unrepresentable-comment',
          program: { functions: [{ ...identity, comments: { trailing: '# \ud800' } }] },
          text: false,
        },
        {
          detail: 'unrepresentable-comment',
          program: { functions: [], tailComments: ['# \udfff'] },
          text: false,
        },
        {
          detail: 'text-mismatch',
          program: { functions: [{ ...identity, nodes: [{ ...bytes, text: 'B' }] }] },
          text: true,
        },
        {
          detail: 'unrepresentable-text',
          program: { functions: [{ ...identity, nodes: [{ ...bytes, text: '\ud800' }] }] },
          text: true,
        },
      ] satisfies readonly { detail: string; program: Program; text: boolean }[];
      for (const row of rows) {
        const typed = validate(row.program);
        const actual = engine.checkProgram(row.program),
          reference = plain.checkProgram(row.program);
        assert.ok(actual.ok && reference.ok, row.detail);
        assert.equal(formatProgram(actual.typed), formatProgram(reference.typed));
        assert.equal(formatSource(actual.program), formatSource(row.program));
        const refusal = { ok: false, reason: 'authoring-metadata', detail: row.detail };
        assert.deepEqual(engine.format(actual, { scope: 'source' }), refusal);
        for (const scope of ['program', 'function'] as const) {
          if (scope === 'function' && !typed.functions.length) continue;
          const formatted = engine.format(actual, { scope });
          if (row.text) assert.deepEqual(formatted, refusal);
          else {
            assert.ok(formatted.ok);
            assert.equal(formatted.text, flat(row.program, scope, 0));
          }
        }
        for (const kind of ['program', 'function', 'semantic'] as const) {
          if (kind !== 'program' && !typed.functions.length) continue;
          const revision = engine.revision(actual, { kind });
          if (row.text) assert.deepEqual(revision, refusal);
          else {
            assert.ok(revision.ok);
            const fn = typed.functions[0];
            assert.equal(
              revision.revision,
              kind === 'program'
                ? sha(formatProgram(typed))
                : kind === 'function'
                  ? sha(formatFunction(fn as TypedFunc))
                  : semanticOracle(fn as TypedFunc),
            );
          }
        }
        assert.deepEqual(plain.format(reference), { ok: false, reason: 'unavailable' });
      }
      assert.equal(loads, 1, 'all supported calls reuse one lazy optional formatter');
    } finally {
      engine.close();
      plain.close();
    }
  });

  test(`${backend}: metadata refusals never replace ordered checker errors or Unicode diagnostic JSON`, () => {
    const engine = factory(companion, diagnostic);
    try {
      const program: Program = {
        functions: [{ ...identity, name: 'λ😀', comments: { trailing: '# \ud800' } }],
      };
      let expected: ReturnType<A0Error['toJSON']> | undefined;
      try {
        validate(program);
      } catch (error) {
        assert.ok(error instanceof A0Error);
        expected = error.toJSON();
      }
      assert.ok(expected);
      const result = engine.checkProgram(program);
      assert.ok(!result.ok && result.diagnostic && 'packet' in result.diagnostic);
      assert.ok(result.diagnostic.rendered.ok);
      assert.deepEqual(result.diagnostic.rendered.error.toJSON(), expected);
      const formatted = engine.format(result);
      assert.ok(!formatted.ok && 'status' in formatted);
      assert.equal(
        formatted.status,
        result.status,
        'native first error wins over metadata refusal',
      );
      assert.deepEqual(engine.revision(result), { ok: false, status: result.status });
      const earlier = engine.parseUnit('fn helper\nex 1 -> 9\na add A 1\nret a\nend\n');
      const later = engine.parseUnit('profile strict\nfn top -> bool\nret 1\nend\n');
      assert.ok(earlier.ok && later.ok);
      const graph = engine.checkUnits([earlier, later], 'strict');
      assert.ok(!graph.ok);
      const retained = [...graph.state.slice(0, 6)];
      const whole = engine.parse(
        'profile strict\nfn helper\nex 1 -> 9\na add A 1\nret a\nend\nfn top -> bool\nret 1\nend\n',
      );
      assert.ok(!whole.ok);
      assert.equal(retained[0], whole.state[0]);
      assert.equal(
        retained[1],
        whole.state[1],
        'earlier dependency spec precedes later type error',
      );
    } finally {
      engine.close();
    }
  });

  test(`${backend}: global function-limit diagnostics keep their public lack of synthetic location`, () => {
    const engine = factory(companion, diagnostic);
    try {
      const program: Program = {
        functions: Array<Func>(65_537).fill({ ...identity, comments: { leading: ['# global Ω'] } }),
      };
      let expected: ReturnType<A0Error['toJSON']> | undefined;
      try {
        validate(program);
      } catch (error) {
        assert.ok(error instanceof A0Error);
        expected = error.toJSON();
      }
      assert.equal(expected?.id, 'A0029');
      const result = engine.checkProgram(program, 100_000_000);
      assert.ok(!result.ok && result.diagnostic && 'packet' in result.diagnostic);
      assert.equal(result.state[1], 29);
      assert.ok(result.diagnostic.rendered.ok);
      assert.deepEqual(result.diagnostic.rendered.error.toJSON(), expected);
      assert.equal(result.diagnostic.rendered.location.path, undefined);
    } finally {
      engine.close();
    }
  });
}
