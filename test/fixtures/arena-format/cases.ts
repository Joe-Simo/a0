import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  A0Error,
  ALL_OPS,
  type Func,
  formatFunction,
  formatProgram,
  type Node,
  type Program,
  parse,
  parseAndValidate,
  type TypedFunc,
} from '../../../src/core.js';
import { semanticRevision } from '../../../src/edit.js';
import { programRevision, revision } from '../../../src/revision.js';
import { formatSource } from '../../../src/source.js';
import { withoutSpec } from '../../../src/spec.js';
import { KERNELS } from '../../../tools/exec-bench-kernels.js';
import { fixturesFor } from '../arena-js/fixtures.js';
import { cases } from '../arena-js/verifier-cases.js';

export interface Request {
  readonly operation: 0 | 1;
  readonly mode: number;
  readonly id: number;
  readonly skip: boolean;
  readonly mapping: boolean;
  readonly fault: number;
  readonly budget: number;
  readonly status: number;
  readonly expected?: string;
  readonly largeOperandMap?: number;
  readonly literalMapCount?: number;
  readonly expectedEvents?: readonly {
    readonly kind: number;
    readonly subject: number;
    readonly field: number;
    readonly spelling: string;
  }[];
}
export interface SourceCase {
  readonly name: string;
  readonly source: string;
  readonly checked: boolean;
  readonly initial: number;
  readonly diagnostic?: number;
  readonly requests: readonly Request[];
  readonly roundTrip?: boolean;
}
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const bareNode = (node: Node): Node => ({
  id: node.id,
  op: node.op,
  args: node.args,
  ...(node.callee === undefined ? {} : { callee: node.callee }),
  ...(node.pred === undefined ? {} : { pred: node.pred }),
  ...(node.text === undefined ? {} : { text: node.text }),
});
function bareFunction(fn: Func): Func {
  return {
    name: fn.name,
    params: fn.params,
    result: fn.result,
    nodes: fn.nodes.map(bareNode),
    ret: fn.ret,
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
/** Scope selection only: all spelling comes from the independent flat source oracle. */
function flatComponent(program: Program, mode: number, id: number): string {
  if (mode === 2) return formatSource(program);
  const functions = mode === 0 ? [program.functions[id] as Func] : program.functions;
  const text = formatSource({
    functions: functions.map(bareFunction),
    ...(mode !== 0 && program.profile === 'strict' ? { profile: 'strict' as const } : {}),
  });
  return mode === 0 ? text.slice(0, -1) : text;
}
const format = (
  mode: number,
  id: number,
  skip: boolean,
  mapping: boolean,
  expected: string,
): Request => ({
  operation: 0,
  mode,
  id,
  skip,
  mapping,
  fault: 0,
  budget: 0xffffffff,
  status: 0,
  expected,
});
const hash = (mode: number, id: number, expected: string): Request => ({
  operation: 1,
  mode,
  id,
  skip: false,
  mapping: false,
  fault: 0,
  budget: 0xffffffff,
  status: 0,
  expected,
});

const extras = [
  '# profile\r\nprofile strict # end\r\nuse "Ω # path.a0" # u\r\n# f\r\nfn go -> u32\r\nret 7 # r\r\nend # done\r\n# tail\r\n',
  '\ufeff# initialBOM\nfn f -> u32x1\na text "\ufeffΩ\t\ra # \\" \\\\"\nret a\nend\n',
  'fn f -> u32\np0001 mov 7\nx udiv p0001 2\ny urem x 3\nret y\nend\n',
  'fn f -> u32\nex ([1 2,3];(true,);false) -> ([1;2;3];(true;);false)\nret 7\nend\n',
  'fn first -> u32\npre eq 1 1\nret 7\nend\nfn absent -> u32\nret 8\nend\nfn third -> u32\npost eq r 9\nex -> 9\nret 9\nend\n',
];
for (const operand of [
  'p0',
  'p0001',
  'p4294967295',
  'p4294967296',
  'p9007199254740993',
  'p999999999999999999999',
  'p1000000000000000000000',
  `p${'9'.repeat(308)}`,
  `p${'9'.repeat(309)}`,
])
  extras.push(`fn f -> u32\nx mov ${operand}\nret ${operand}\nend\n`);
for (const gap of [
  ' ',
  '\t',
  '\v',
  '\f',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\ufeff',
])
  extras.push(
    `fn${gap}f${gap}u32${gap}->${gap}u32\na${gap}add${gap}p0${gap}1 # gap\nret${gap}a\nend\n`,
  );
for (let depth = 1; depth <= 12; depth++) {
  const t = `${'('.repeat(depth)}u32${')'.repeat(depth)}`,
    lit = `${'('.repeat(depth)}7${';)'.repeat(depth)}`;
  extras.push(`fn nested ${t} -> ${t}\nex ${lit} -> ${lit}\nret p0\nend\n`);
}
const MATRIX_SOURCES = [
  ...new Set([
    ...KERNELS.map((k) => k.a0),
    ...fixturesFor().map((f) => f.source),
    ...cases.map((x) => x.source),
    ...extras,
  ]),
];

const MANUAL_SOURCES = [
  '',
  '# only Ω\n# tail\t\n',
  'profile strict\n',
  'use "a Ω#x.a0" # imported\n',
  '# before\nprofile strict # p\n# u\nuse "x.a0" # u2\n# remaining\n',
  'fn f -> u32\nret 7\nend\n',
  '# header\nfn f u32 boolx2x3 (u32) -> (u32,bool) # h\n# n\nx add p0 1 # a\nr rec x true\n# rt\nret r # r\n# en\nend # e\n# after1\n# after2\n',
  'fn f (u32,boolx2) -> (u32)\n# post first\npost eq r p0 # p\n# example1\nex (1;[true,false]) -> (1;) # e\npre eq p0 p0 # pre\n# body\nr rec 1\nex (2;[false,true]) -> (1;) # late\nret r\nend\n',
  'fn a u32 -> u32\nret add p0 2 # inline\nend\n\n# between\nfn b u32 -> u32\nx a p0\ny loop a a 2 x\nret y\nend\n# last\n',
  'fn text_example -> u32x11\na text "é\\t\\n\\"\\\\#Ω" # text\nret a\nend\n',
  'fn wide -> u32\nx mov p4294967296\ny mov p1000000000000000000000000000000\nret p' +
    '9'.repeat(400) +
    '\nend\n',
];
const FLAT_SOURCES = [
  'fn unused u32 u32 -> u32\nret p0\nend\n',
  'fn contracts u32 u32 u32 -> u32\npre lt p2 10\npost eq p0 r\nret p0\nend\n',
  'fn holes u32 u32 u32 -> u32\nx add p2 1\nret x\nend\n',
  `fn params ${Array(64).fill('u32').join(' ')} -> u32\na add p0 p25\nb add p26 p63\nc add a b\nret c\nend\n`,
  'fn examples u32 -> u32\nex 7 -> 7\nret 7\nend\n',
  'fn literals -> (u32x3,(u32),u32x2)\nex -> ([7;7;7];(2;);[8;8])\na arr 7 7 7\nb rec 2\nc arr 8 8\nd rec a b c\nret d\nend\n',
  'fn nested -> u32\nex -> [(1;[2;2;2]);(1;[2;2;2]);(1;[2;2;2])]\nex -> [(1;[2;2;2]);(1;[2;2;3]);(1;[2;2;2])]\nret 0\nend\n',
  'fn rounded -> u32\na arr p9007199254740992 p9007199254740993 p9007199254740992\nb arr p4294967296 p4294967297 p4294967296\nret 0\nend\n',
  'fn aliases u32 -> u32\na shl p0 1\nb shr a 2\nret b\nend\n',
  ...[...ALL_OPS, 'udiv', 'urem', 'text', 'pre', 'profile', 'p0'].map(
    (name) =>
      `fn ${name} u32 -> u32\nret p0\nend\nfn caller u32 -> u32\nx call ${name} p0\nret x\nend\n`,
  ),
];

function revisionSources(): string[] {
  const ident = (name: string, value = 1) =>
    `fn ${name} u32 -> u32\nx add p0 ${value}\nret x\nend\n`;
  const samples = [
    '',
    '# only a comment\n',
    'profile strict\n',
    ident('leaf'),
    `profile strict\n${ident('leaf')}`,
    ident('z', 3) +
      ident('aa_', 4) +
      ident('aa0', 5) +
      ident('aa', 6) +
      `fn entry u32 -> u32\na z p0\nb aa_ a\nc aa0 b\nd aa c\ne z d\nret e\nend\n`,
    ident('z', 3) +
      ident('aa_', 4) +
      ident('aa0', 5) +
      ident('aa', 6) +
      `fn entry u32 -> u32\na aa p0\nb z a\nc aa0 b\nd aa_ c\ne z d\nret e\nend\n`,
    `${ident('leaf', 2)}${ident('unrelated', 7)}fn caller u32 -> u32\nx leaf p0\nret x\nend\n`,
    `${ident('leaf', 3)}${ident('unrelated', 7)}fn caller u32 -> u32\nx leaf p0\nret x\nend\n`,
    `${ident('leaf', 2)}${ident('unrelated', 9)}fn caller u32 -> u32\nx leaf p0\nret x\nend\n`,
    `fn leaf u32 -> u32\nex 2 -> 3\npost eq r 3\nx add p0 1\nret x\nend\n`,
    `fn leaf u32 -> u32\nex 2 -> 3\npost eq r 3\nx add p0 1\nret x\nend\nfn with_spec u32 -> u32\npre eq p0 p0\npost leaf p0\nret 1\nend\n`,
    `fn step u32 u32 -> u32\nx add p0 p1\nret x\nend\nfn pred u32 u32 -> bool\nx lt p0 100\nret x\nend\nfn entry u32 -> u32\na fold step 3 p0\nb loop pred step 2 a\nret b\nend\n`,
    `# leading\nuse "unused.a0"\nfn text_fn -> u32x4\na text "é\\n#"\nret a\nend\n# trailing\n`,
  ];
  // A contract call must type as bool and does not enter the body's dependency map.
  samples[11] = `fn truth u32 -> bool\nx eq p0 p0\nret x\nend\nfn with_spec u32 -> u32\npre truth p0\npost eq r 1\nret 1\nend\n`;
  samples.push(
    `fn step bool u32 -> bool\nx xor p0 true\nret x\nend\nfn entry bool -> bool\na fold step 2 p0\nb loop step step 3 a\nret b\nend\n`,
  );
  return [...samples, ...KERNELS.map((k) => k.a0)];
}

/** Existing independent source corpora plus formatter-specific byte grammar cases. */
export function formattingCases(): SourceCase[] {
  return [...MATRIX_SOURCES, ...MANUAL_SOURCES, ...FLAT_SOURCES].map((source, index) => {
    let program: ReturnType<typeof parse>;
    try {
      program = parse(source);
    } catch (error) {
      assert.ok(error instanceof A0Error);
      assert.ok(error.id);
      return {
        name: `matrix invalid ${index}`,
        source,
        checked: false,
        initial: 6,
        diagnostic: Number(error.id.slice(1)),
        requests: [],
      };
    }
    const requests: Request[] = [];
    for (const skip of [false, true])
      for (const mode of [0, 1, 2]) {
        const selected = skip
          ? { ...program, functions: program.functions.map(withoutSpec) }
          : program;
        for (const id of mode === 0 ? selected.functions.map((_, i) => i) : [0]) {
          const text = flatComponent(selected, mode, id);
          requests.push(format(mode, id, skip, true, text));
        }
      }
    return {
      name: `matrix ${index}`,
      source,
      checked: false,
      initial: program.functions.some((fn) => fn.spec !== undefined) ? 7 : 0,
      requests,
      ...(FLAT_SOURCES.includes(source) ? { roundTrip: true } : {}),
    };
  });
}

/** Node crypto is independent of both the A0 SHA implementation and reference SHA helpers. */
function semanticOracle(fn: TypedFunc, memo = new WeakMap<TypedFunc, string>()): string {
  const cached = memo.get(fn);
  if (cached !== undefined) return cached;
  const own = sha(formatFunction(withoutSpec(fn)));
  let text = fn.profile === 'strict' ? `profile strict|${own}` : own;
  for (const name of [...fn.calls.keys()].sort()) {
    const callee = fn.calls.get(name);
    assert.ok(callee);
    text += `|${name}=${semanticOracle(callee, memo)}`;
  }
  const result = sha(text);
  memo.set(fn, result);
  return result;
}

export function revisionCases(): SourceCase[] {
  return revisionSources().map((source, index) => {
    const program = parseAndValidate(source),
      requests: Request[] = [];
    const whole = sha(formatProgram(program));
    assert.equal(programRevision(program), whole);
    requests.push(hash(1, 0, whole));
    for (const [id, fn] of program.functions.entries()) {
      const own = sha(formatFunction(fn)),
        semantic = semanticOracle(fn);
      assert.equal(revision(fn), own);
      assert.equal(semanticRevision(fn), semantic);
      requests.push(hash(0, id, own), hash(2, id, semantic));
    }
    return {
      name: `revisions ${index}`,
      source,
      checked: true,
      initial: 0,
      requests,
    };
  });
}

const SIMPLE = '# leading\nfn f u32 -> u32\nx add p0 1\nret x\nend\n';
const SPEC = 'fn f u32 -> u32\nex 2 -> 3\nx add p0 1\nret x\nend\n';
function control(
  name: string,
  options: {
    readonly source?: string;
    readonly checked?: boolean;
    readonly operation?: 0 | 1;
    readonly mode?: number;
    readonly id?: number;
    readonly fault?: number;
    readonly budget?: number;
    readonly status: number;
  },
): SourceCase {
  const { source = SIMPLE, checked = false } = options;
  return {
    name: `control ${name}`,
    source,
    checked,
    initial: !checked && source === SPEC ? 7 : 0,
    requests: [
      {
        operation: options.operation ?? 0,
        mode: options.mode ?? 0,
        id: options.id ?? 0,
        skip: false,
        mapping: true,
        fault: options.fault ?? 0,
        budget: options.budget ?? 0xffffffff,
        status: options.status,
      },
    ],
  };
}
export function resourceCases(): SourceCase[] {
  const rows = [
    control('allocation', { budget: 0, status: 4 }),
    control('mode', { mode: 3, status: 6 }),
    control('function', { id: 0xffffffff, status: 6 }),
    control('schema', { fault: 1, status: 6 }),
    control('parser failure', { fault: 13, status: 6 }),
    control('pending', { fault: 2, status: 7 }),
    control('source handle', { mode: 2, fault: 3, status: 2 }),
    control('node handle', { fault: 4, status: 2 }),
    control('node bounds', { fault: 5, status: 3 }),
    control('node vector range', { fault: 14, status: 7 }),
    ...[1, 2, 3, 4, 5].map((status) =>
      control(`runtime ${status}`, { fault: 20 + status, status }),
    ),
    control('spec missing', { source: SPEC, fault: 6, status: 7 }),
    control('spec mismatch', { source: SPEC, fault: 7, status: 7 }),
    control('spec handle', { source: SPEC, fault: 8, status: 2 }),
    control('spec range', { source: SPEC, fault: 9, status: 7 }),
    control('revision mode', { operation: 1, mode: 3, status: 6 }),
    control('revision function', { operation: 1, id: 0xffffffff, status: 6 }),
    control('revision allocation', { operation: 1, budget: 0, status: 4 }),
    control('semantic unchecked', { operation: 1, mode: 2, status: 7 }),
    control('semantic unverified specs', {
      operation: 1,
      mode: 2,
      source: SPEC,
      status: 7,
    }),
    control('semantic shape', {
      operation: 1,
      mode: 2,
      checked: true,
      fault: 10,
      status: 7,
    }),
    control('semantic allocation', {
      operation: 1,
      mode: 2,
      checked: true,
      budget: 0,
      status: 4,
    }),
    control('unknown opcode', { fault: 11, status: 7 }),
    control('unknown text opcode', { fault: 12, status: 7 }),
  ];
  const expected = formatSource(parse(SPEC));
  rows.push({
    name: 'mapping off byte parity',
    source: SPEC,
    checked: false,
    initial: 7,
    requests: [
      {
        ...format(2, 0, false, true, expected),
        expectedEvents: [
          { kind: 21, subject: 0, field: 0, spelling: 'f' },
          { kind: 2, subject: 0, field: 0, spelling: '' },
          { kind: 3, subject: 0, field: 0, spelling: '' },
          { kind: 5, subject: 0, field: 0, spelling: 'x' },
          { kind: 6, subject: 0, field: 0, spelling: 'add' },
          { kind: 9, subject: 0, field: 0, spelling: 'A' },
          { kind: 9, subject: 1, field: 1, spelling: '1' },
          { kind: 11, subject: 2, field: 0, spelling: 'x' },
          { kind: 13, subject: 0, field: 0, spelling: '2' },
          { kind: 13, subject: 1, field: 0, spelling: '3' },
        ],
      },
      format(2, 0, false, false, expected),
    ],
  });
  const nested = 'fn nested -> u32\nex -> [(1;[2;2;2]);(1;[2;2;2]);(1;[2;2;2])]\nret 0\nend\n';
  const nestedText = formatSource(parse(nested));
  // PS appends each literal after its children. All three explicitly written records
  // have distinct AST IDs, including their nested repeated scalar children.
  const literalSpelling = [
    '1',
    '2',
    '2',
    '2',
    '[2*3]',
    '(1 [2*3])',
    '1',
    '2',
    '2',
    '2',
    '[2*3]',
    '(1 [2*3])',
    '1',
    '2',
    '2',
    '2',
    '[2*3]',
    '(1 [2*3])',
    '[(1 [2*3])*3]',
  ];
  rows.push({
    name: 'nested repetition retains every distinct literal origin',
    source: nested,
    checked: false,
    initial: 7,
    roundTrip: true,
    requests: [
      {
        ...format(2, 0, false, true, nestedText),
        literalMapCount: literalSpelling.length,
        expectedEvents: literalSpelling.map((spelling, subject) => ({
          kind: 13,
          subject,
          field: 0,
          spelling,
        })),
      },
      format(2, 0, false, false, nestedText),
    ],
  });
  for (const [target, source, initial] of [
    [1, nested, 7],
    [2, SIMPLE, 0],
    [3, 'fn f -> u32\nret p9007199254740993\nend\n', 0],
  ] as const)
    rows.push({
      name: `late storage failure at ${['', 'literal comparison', 'event close', 'parameter prefix'][target]}`,
      source,
      checked: false,
      initial,
      requests: [1, 2, 3, 4, 5].map((status) => ({
        ...format(2, 0, false, true, ''),
        fault: (target << 8) | status,
        status,
      })),
    });
  return rows;
}

export function pressureCases(): SourceCase[] {
  // Direct string construction avoids recursion in the reference parser/formatter oracle.
  const depth = 4096,
    type = `${'('.repeat(depth)}u32${')'.repeat(depth)}`;
  const literal = `${'('.repeat(depth)}7${';)'.repeat(depth)}`,
    count = 70017;
  const values = Array(count).fill('7').join(' '),
    name = `f${'a'.repeat(63)}`;
  const padding = `#${'x'.repeat(131100)}\n`;
  const inputs = [
    [
      '4096 nested record types',
      `fn deep ${type} -> ${type}\nret p0\nend\n`,
      `fn deep ${type} -> ${type}\nret p0\nend`,
      `fn deep ${type.replace('u32', '_')} -> ${type.replace('u32', '_')}\nret A\nend`,
      0,
    ],
    [
      '4096 nested singleton literals',
      `fn deep -> u32\nex -> ${literal}\nret 7\nend\n`,
      `fn deep -> u32\nex -> ${literal}\nret 7\nend`,
      `fn deep\nex -> ${literal.replaceAll(';)', ',)')}\nret 7\nend`,
      7,
    ],
    [
      '70017 operands and mapped row IDs',
      `fn wide -> u32\na arr ${values}\nret 7\nend\n`,
      `fn wide -> u32\na arr ${values}\nret 7\nend`,
      `fn wide\na [7*${count}]\nret 7\nend`,
      0,
    ],
    [
      '64 byte exact maximum legal symbol name',
      `fn ${name} -> u32\nret 7\nend\n`,
      `fn ${name} -> u32\nret 7\nend`,
      `fn ${name}\nret 7\nend`,
      0,
    ],
    [
      'oversized parameter span beyond 131072',
      `${padding}fn wide -> u32\nret p9007199254740993\nend\n`,
      'fn wide -> u32\nret p9007199254740992\nend',
      'fn wide -> _\nret p9007199254740992\nend',
      0,
    ],
  ] as const;
  return inputs.map(([name, source, historical, expected, initial]) => ({
    name: `pressure ${name}`,
    source,
    checked: false,
    initial,
    requests: [
      name.includes('70017')
        ? { ...format(0, 0, false, true, expected), largeOperandMap: count }
        : format(0, 0, false, true, expected),
      hash(0, 0, sha(historical)),
    ],
  }));
}
export function selfCase(source: string): SourceCase {
  return {
    name: 'self canonical compiler program',
    source,
    checked: false,
    initial: 0,
    roundTrip: true,
    requests: [
      format(1, 0, false, false, flatComponent(parse(source), 1, 0)),
      hash(1, 0, sha(source)),
    ],
  };
}
