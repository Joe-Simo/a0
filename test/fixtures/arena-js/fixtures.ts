import assert from 'node:assert/strict';
import type { Value } from '../../../src/core.js';
import { BEHAVIOR_SPEC } from '../../../tools/behavior-spec.js';
import { BEHAVIOR_TABLE } from '../../../tools/behavior-table.js';
import { CHECKED_SOURCE, checkedCases } from '../checked-ops-fixtures.js';
import { CASES as DEEP_EXTRA_CASES, IO_EXTRA_CASES } from '../js-deep-extra.js';
import { CASES as DEEP_CASES, INPUTS } from '../js-deep-owned.js';
import { PREDICATE_BODIES, RECORD_CASES } from '../owned-programs.js';

export interface Invocation {
  readonly fn: string;
  readonly args: readonly Value[];
  readonly expected?: Value;
  readonly trapLine?: string;
  readonly input?: readonly number[];
  readonly output?: readonly number[];
}

export interface Fixture {
  readonly name: string;
  readonly group: 'checked' | 'behavior' | 'owned' | 'predicate';
  readonly source: string;
  readonly oracle:
    | 'independent integer'
    | 'recorded interpreter + BigInt'
    | 'reference interpreter';
  readonly cases: readonly Invocation[];
}

const checked = checkedCases();
assert.equal(checked.length, 2356, 'reuse the unchanged shared independent checked corpus');
const checkedRows: Invocation[] = checked.map((c) => ({
  fn: c.functionName,
  args: c.args,
  expected: c.expected,
}));

// Also observe whole records directly, so numeric booleans or reversed tuple fields fail.
// Their values/flags come from the existing independent fixture, not candidate emission.
const pairRows: Invocation[] = [];
for (const c of checked) {
  if (!/^(cadd|csub|cmul|cdiv|crem)_v$/.test(c.functionName) && c.functionName !== 'get_v')
    continue;
  const flag = checked.find(
    (x) =>
      x.functionName === c.functionName.replace(/_v$/, '_ok') &&
      JSON.stringify(x.args) === JSON.stringify(c.args),
  );
  assert.ok(flag && typeof flag.expected === 'boolean' && typeof c.expected === 'number');
  pairRows.push({
    fn: c.functionName === 'get_v' ? 'get_pair' : c.functionName.replace(/_v$/, '_pair'),
    args: c.functionName === 'get_v' ? [[0, 0xffffffff, 0x80000000], ...c.args] : c.args,
    expected: [c.expected, flag.expected],
  });
}
assert.equal(pairRows.length, 616);

const checkedFixtures: Fixture[] = [false, true].flatMap((strict) => {
  const source = `${strict ? 'profile strict\n' : ''}${CHECKED_SOURCE}`;
  return [
    {
      name: `checked-${strict ? 'strict' : 'canonical'}-2356`,
      group: 'checked' as const,
      source,
      oracle: 'independent integer' as const,
      cases: checkedRows,
    },
    {
      name: `checked-${strict ? 'strict' : 'canonical'}-whole-records`,
      group: 'checked' as const,
      source,
      oracle: 'independent integer' as const,
      cases: pairRows,
    },
  ];
});

const behaviorFixtures: Fixture[] = BEHAVIOR_SPEC.map((p) => {
  const rows = BEHAVIOR_TABLE[p.name];
  assert.ok(rows, `recorded behavior rows for ${p.name}`);
  return {
    name: `behavior-${p.name}`,
    group: 'behavior',
    source: p.source,
    oracle: 'recorded interpreter + BigInt',
    cases: rows.map((r) => ({
      fn: r.fn,
      args: r.args,
      expected: r.expected,
      ...(r.trap === undefined ? {} : { trapLine: r.trap }),
      ...(r.input === undefined ? {} : { input: r.input }),
      ...(r.output === undefined ? {} : { output: r.output }),
    })),
  };
});

const ownedFixtures: Fixture[] = [
  ...RECORD_CASES.map(([name, source]) => ({
    name: `owned-record-${name}`,
    group: 'owned' as const,
    source,
    oracle: 'reference interpreter' as const,
    cases: INPUTS.map((args) => ({ fn: 'probe', args })),
  })),
  ...[...DEEP_CASES, ...DEEP_EXTRA_CASES, ...IO_EXTRA_CASES].map((f) => ({
    name: `js-alias-${f.name}`,
    group: 'owned' as const,
    source: f.source,
    oracle: 'reference interpreter' as const,
    cases: (f.inputs ?? INPUTS).map((args) => ({ fn: f.entry ?? 'probe', args })),
  })),
];

const predicateFixtures: Fixture[] = PREDICATE_BODIES.map((body, i) => ({
  name: `predicate-${i}`,
  group: 'predicate',
  oracle: 'reference interpreter',
  source: `fn pred u32 u32 u32 u32 -> bool\n${body}\nend
fn step u32 u32 u32 u32 -> u32
r add p0 p2
ret r
end
fn probe u32 u32 -> u32
r loop pred step 5 p0 p1 p0
ret r
end
`,
  cases: INPUTS.map((args) => ({ fn: 'probe', args })),
}));

export const FIXTURES: readonly Fixture[] = [
  ...checkedFixtures,
  ...behaviorFixtures,
  ...ownedFixtures,
  ...predicateFixtures,
];

export const PUBLIC_SOURCE = `fn public_u32 u32 -> u32
ret p0
end
fn public_bool bool -> bool
ret p0
end
fn public_array u32x3 u32 u32 -> u32x3
r set p0 p1 p2
ret r
end
fn public_bool_array boolx3 u32 -> bool
r get p0 p1
ret r
end
fn public_bool_update boolx3 u32 bool -> boolx3
r set p0 p1 p2
ret r
end
fn public_record (u32x3,bool) -> (u32x3,bool)
ret p0
end
fn public_nested u32x3x2 -> u32x3x2
ret p0
end
fn public_io io -> u32
a read p0
v at a 0
t at a 1
w write t v
b read w
x at b 0
u at b 1
q write u x
ret x
end
`;

export const STRICT_IDENTITY_SOURCE =
  'profile strict\nfn strict_identity u32 -> u32\nret p0\nend\n';

/** A small first run is optional; full conformance must include every group. */
export function fixturesFor(
  groups: readonly Fixture['group'][] = ['checked', 'behavior', 'owned', 'predicate'],
): readonly Fixture[] {
  return FIXTURES.filter((f) => groups.includes(f.group));
}
