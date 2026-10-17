import type { Value } from '../../../src/core.js';

export interface StrictObservation {
  readonly fn: string;
  readonly args: readonly Value[];
  readonly input?: readonly number[];
  readonly expected?: Value;
  readonly trap?: {
    readonly kind: 'bounds' | 'divzero' | 'input';
    readonly fn: string;
    readonly at: string | null;
    readonly trip: number | null;
    readonly chain: readonly string[];
  };
  readonly position?: number;
  readonly output?: readonly number[];
}

// Separate from the frozen canonical corpus. In particular, the inline return nodes
// must receive fresh retval2/retval3 IDs rather than colliding with existing source IDs.
export const STRICT_SUPPLEMENT_SOURCE = `profile strict
fn sf_step u32 u32 -> u32
a arr 10 20
v get a p1
r add p0 v
ret r
end
fn sf_pred u32 u32 -> bool
r lt p1 4294967295
ret r
end
fn sf_inline u32 -> u32
retval mov p0
ret fold sf_step retval 0
end
fn sf_inline_three u32 -> u32
retval mov p0
retval2 add retval 0
ret loop sf_pred sf_step retval2 0
end
fn sf_inner_pred u32 u32 io -> bool
rd read p2
v at rd 0
t at rd 1
w write t v
a arr 1 2
unused get a p1
ret true
end
fn sf_inner_step u32 u32 io -> u32
w write p2 p1
r add p0 1
ret r
end
fn sf_inner u32 u32 io -> u32
inner loop sf_inner_pred sf_inner_step 3 p0 p2
ret inner
end
fn sf_outer u32 io -> u32
outer fold sf_inner p0 0 p1
ret outer
end
fn sf_stop_pred u32 u32 u32 io -> bool
rd read p3
v at rd 0
t at rd 1
w write t v
r lt p1 p2
ret r
end
fn sf_stop_step u32 u32 u32 io -> u32
w write p3 p1
r add p0 1
ret r
end
fn sf_stop u32 u32 io -> u32
r loop sf_stop_pred sf_stop_step p0 0 p1 p2
ret r
end
fn sf_read_before_trap u32 io -> u32
rd read p1
v at rd 0
t at rd 1
w write t v
r div v p0
ret r
end
fn sf_safe_bounds u32 u32 -> u32
a arr 1 2 3
i rem p0 3
x get a i
r add p1 x
ret r
end
`;

export const STRICT_SUPPLEMENT_CASES: readonly StrictObservation[] = [
  { fn: 'sf_inline', args: [0], expected: 0 },
  { fn: 'sf_inline', args: [2], expected: 30 },
  {
    fn: 'sf_inline',
    args: [3],
    trap: {
      kind: 'bounds',
      fn: 'sf_step',
      at: 'sf_inline.retval2',
      trip: 2,
      chain: ['sf_inline', 'sf_step'],
    },
  },
  { fn: 'sf_inline_three', args: [0], expected: 0 },
  { fn: 'sf_inline_three', args: [2], expected: 30 },
  {
    fn: 'sf_inline_three',
    args: [3],
    trap: {
      kind: 'bounds',
      fn: 'sf_step',
      at: 'sf_inline_three.retval3',
      trip: 2,
      chain: ['sf_inline_three', 'sf_step'],
    },
  },
  { fn: 'sf_outer', args: [0], input: [], expected: 0, position: 0, output: [] },
  {
    fn: 'sf_outer',
    args: [1],
    input: [7, 11, 13],
    trap: {
      kind: 'bounds',
      fn: 'sf_inner_pred',
      at: 'sf_inner.inner',
      trip: 2,
      chain: ['sf_outer', 'sf_inner', 'sf_inner_pred'],
    },
    position: 3,
    output: [7, 0, 11, 1, 13],
  },
  {
    fn: 'sf_outer',
    args: [1],
    input: [7, 11],
    trap: {
      kind: 'input',
      fn: 'sf_inner_pred',
      at: 'sf_inner.inner',
      trip: 2,
      chain: ['sf_outer', 'sf_inner', 'sf_inner_pred'],
    },
    position: 2,
    output: [7, 0, 11, 1],
  },
  { fn: 'sf_stop', args: [0, 1], input: [], expected: 0, position: 0, output: [] },
  { fn: 'sf_stop', args: [5, 1], input: [7, 11], expected: 1, position: 2, output: [7, 0, 11] },
  { fn: 'sf_stop', args: [5, 0], input: [7], expected: 0, position: 1, output: [7] },
  {
    fn: 'sf_stop',
    args: [5, 1],
    input: [7],
    trap: {
      kind: 'input',
      fn: 'sf_stop_pred',
      at: 'sf_stop.r',
      trip: 1,
      chain: ['sf_stop', 'sf_stop_pred'],
    },
    position: 1,
    output: [7, 0],
  },
  { fn: 'sf_read_before_trap', args: [2], input: [7], expected: 3, position: 1, output: [7] },
  {
    fn: 'sf_read_before_trap',
    args: [0],
    input: [7],
    trap: {
      kind: 'divzero',
      fn: 'sf_read_before_trap',
      at: null,
      trip: null,
      chain: ['sf_read_before_trap'],
    },
    position: 1,
    output: [7],
  },
  {
    fn: 'sf_read_before_trap',
    args: [0],
    input: [],
    trap: {
      kind: 'input',
      fn: 'sf_read_before_trap',
      at: null,
      trip: null,
      chain: ['sf_read_before_trap'],
    },
    position: 0,
    output: [],
  },
  { fn: 'sf_safe_bounds', args: [0xffffffff, 1], expected: 2 },
  { fn: 'sf_safe_bounds', args: [0xfffffffe, 0xffffffff], expected: 2 },
];
