/** Sentinel expectations are geometry/host-state assertions at its public frame IO boundary. */
import assert from 'node:assert/strict';
import { COMMAND_WORDS, FLAG, H, OP, parseHostCommands, toQ16 } from '../site/live/words.js';
import type { TypedProgram } from '../src/core.js';
import type { ApplicationIoResult, applicationRuntime } from './app-edit-application-runtime.js';

type Point = readonly [number, number];
type Box = readonly [number, number, number, number];
interface Row {
  readonly id: number;
  readonly box: Box;
  readonly kind: number;
}
interface EdgeCase {
  readonly id: string;
  readonly box: Box;
  readonly tip: Point;
  readonly pointer: Point;
  readonly scroll: Point;
  readonly unchanged: boolean;
}
interface TapCase {
  readonly id: string;
  readonly rows: readonly Row[];
  readonly target: Box | null;
  readonly expectedId: number;
  readonly tap?: Point;
  readonly scroll?: Point;
  readonly seq?: number;
  readonly oldSeq?: number;
  readonly unchanged: boolean;
}
export interface SentinelCases {
  readonly edge: readonly EdgeCase[];
  readonly tap: readonly TapCase[];
}
type Runtime = Awaited<ReturnType<typeof applicationRuntime>>;

function frameInput(
  state: readonly number[],
  rows: readonly Row[],
  {
    scroll = [0, 0],
    pointer = [150, 70],
    tap = [20, 20],
    seq = 1,
    target = null,
    first = false,
  }: {
    readonly scroll?: Point;
    readonly pointer?: Point;
    readonly tap?: Point;
    readonly seq?: number;
    readonly target?: Box | null;
    readonly first?: boolean;
  } = {},
): number[] {
  const header = Array<number>(32).fill(0);
  header[H.version] = 1;
  header[H.dt] = 1;
  header[H.flags] = FLAG.pointer | (first ? FLAG.first : 0);
  header[H.vw] = 1000;
  header[H.vh] = 800;
  header[H.scrollX] = scroll[0];
  header[H.scrollY] = scroll[1];
  header[H.dpr] = 100;
  header[H.pointerX] = toQ16(pointer[0]);
  header[H.pointerY] = toQ16(pointer[1]);
  header[H.pointerType] = 1;
  header[H.tapSeq] = seq;
  header[H.tapX] = toQ16(tap[0]);
  header[H.tapY] = toQ16(tap[1]);
  header[H.costUs] = 800;
  header[H.intervalUs] = 16667;
  header[H.docHeight] = 5000;
  header[H.rows] = rows.length;
  header[H.generation] = 1;
  if (target) header.splice(H.tapRect, 4, ...target);
  const table = Array<number>(672).fill(0);
  rows.forEach((row, index) => {
    table.splice(index * 7, 7, row.id, ...row.box, row.kind | 256, 0);
  });
  assert.ok(state.length === 0 || state.length === 1024, 'persisted state shape');
  return [...header, ...table, state.length, ...state].map((word) => word >>> 0);
}

function equalFrame(
  actual: ApplicationIoResult | undefined,
  expected: ApplicationIoResult | undefined,
) {
  assert.ok(actual && expected, 'complete frame reply');
  assert.equal(actual.value, expected.value, 'frame return');
  assert.equal(actual.position, expected.position, 'frame position');
  assert.equal(actual.inputUnchanged, expected.inputUnchanged, 'frame input ownership');
  assert.equal(actual.output.length, expected.output.length, 'complete frame output length');
  const different = actual.output.findIndex((word, at) => word !== expected.output[at]);
  if (different >= 0)
    assert.equal(
      actual.output[different],
      expected.output[different],
      `complete frame output word ${different}`,
    );
}

export function sentinelState(result: ApplicationIoResult, consumed = 1729): number[] {
  assert.equal(result.value, 0, 'frame return');
  assert.equal(result.position, consumed, 'frame input consumption');
  assert.equal(result.inputUnchanged, true, 'frame input ownership');
  assert.ok(result.output.length <= 16384, 'frame output capacity');
  // The browser decoder tolerates truncated streams. The oracle first proves exact framing.
  let at = 0;
  let states = 0;
  while (at < result.output.length) {
    const op = result.output[at];
    if (op === OP.state) {
      const length = result.output[at + 1];
      assert.equal(length, 1024, 'declared state length');
      assert.ok(at + 2 + length <= result.output.length, 'complete declared state');
      states += 1;
      at += 2 + length;
    } else if (op === OP.watch) {
      const length = result.output[at + 2];
      assert.ok(length !== undefined && at + 3 + length <= result.output.length, 'complete watch');
      const bytes = result.output.slice(at + 3, at + 3 + length);
      assert.ok(
        bytes.every((word) => word <= 255),
        'watch byte range',
      );
      new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
      at += 3 + length;
    } else if (op === OP.quality || op === OP.cadence) {
      assert.ok(at + 2 <= result.output.length, 'complete host setting');
      at += 2;
    } else break;
  }
  assert.equal(states, 1, 'one state command');
  const host = parseHostCommands(result.output, result.output.length);
  assert.equal(host.stateLength, 1024, 'frame state length');
  assert.ok(host.stateStart + 1024 <= result.output.length, 'complete state payload');
  let pos = host.drawStart;
  while (pos < result.output.length) {
    const op = result.output[pos] as number;
    const count = op === OP.path ? 4 + 2 * (result.output[pos + 1] as number) : COMMAND_WORDS[op];
    assert.ok(
      count !== undefined && count > 0 && pos + count <= result.output.length,
      'draw framing',
    );
    pos += count;
  }
  return result.output.slice(host.stateStart, host.stateStart + 1024);
}

/** A valid warm frame supplies personality/chain fields. The other seven tentacles approach
 * the first row's left midpoint; they are unavailable for a tap without inventing planted feet. */
function poised(
  warm: readonly number[],
  tip: Point,
  rows: readonly Row[],
  oldSeq = 0,
  scroll: Point = [0, 0],
): number[] {
  const row = rows[0];
  assert.ok(row, 'approach fixture row');
  const state = [...warm];
  state[1] = toQ16(tip[0]);
  state[2] = toQ16(tip[1]);
  state[3] = 0;
  state[4] = 0;
  state[22] = oldSeq;
  state[30] = 0; // next search slot is 1; the selected free tentacle is 0
  for (let k = 0; k < 8; k += 1) {
    const base = 96 + 96 * k;
    state[base] = k === 0 ? 0 : 1;
    state[base + 2] = k === 0 ? 0 : row.id;
    state[base + 5] = 0;
    state[base + 6] = 10000;
    state[base + 22] = 0;
    if (k !== 0) {
      state[base + 3] = 0;
      state[base + 4] = toQ16((row.box[3] - row.box[1]) / 2);
      state[base + 23] = toQ16(row.box[0] - scroll[0]);
      state[base + 24] = toQ16((row.box[1] + row.box[3]) / 2 - scroll[1]);
      state[base + 25] = row.kind;
      const horizontal = row.box[2] > row.box[0] && row.box[3] > row.box[1];
      state[base + 29] = horizontal ? toQ16(-1) : 0;
      state[base + 30] = horizontal ? 0 : toQ16(1);
    }
    const last = (state[base + 1] as number) - 1;
    assert.ok(last >= 5 && last <= 8, 'warm chain count');
    if (k === 0) {
      for (const field of [0, 4]) state[base + 32 + 6 * last + field] = toQ16(tip[0]);
      for (const field of [1, 5]) state[base + 32 + 6 * last + field] = toQ16(tip[1]);
      state[base + 32 + 6 * last + 2] = 0;
      state[base + 32 + 6 * last + 3] = 0;
    }
  }
  return state;
}

/** Independent ordered-boundary oracle, using exact integer/half-pixel geometry here. */
function nearest(box: Box, point: Point): Point {
  const [x0, y0, x1, y1] = box;
  const [x, y] = point;
  if (x < x0 || x > x1 || y < y0 || y > y1)
    return [Math.max(x0, Math.min(x1, x)), Math.max(y0, Math.min(y1, y))];
  const choices: readonly [number, Point][] = [
    [x - x0, [x0, y]],
    [x1 - x, [x1, y]],
    [y - y0, [x, y0]],
    [y1 - y, [x, y1]],
  ];
  return choices.reduce((best, next) => (next[0] < best[0] ? next : best))[1];
}

export async function sentinelOracle(
  program: TypedProgram,
  kind: 'edge' | 'tap',
  cases: SentinelCases,
  runtime: Runtime,
  baseline: TypedProgram,
): Promise<string[]> {
  const failures: string[] = [];
  const capture = (label: string, check: () => void) => {
    try {
      check();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const warmInput = frameInput([], [], { first: true, seq: 0 });
  const initial = (await runtime.execute(program, 'frame', [warmInput]))[0];
  assert.ok(initial);
  const warm = sentinelState(initial, warmInput.length);
  const original = (await runtime.execute(baseline, 'frame', [warmInput]))[0];
  assert.ok(original);
  capture('preserve complete no-geometry initial frame', () => equalFrame(initial, original));

  const prepared =
    kind === 'edge'
      ? cases.edge.map((item) => {
          const rows: Row[] = [{ id: 77, box: item.box, kind: 4 }];
          const scroll = item.scroll;
          const tap: Point = [
            (item.box[0] + item.box[2]) / 2 - scroll[0],
            (item.box[1] + item.box[3]) / 2 - scroll[1],
          ];
          const box: Box = [
            item.box[0] - scroll[0],
            item.box[1] - scroll[1],
            item.box[2] - scroll[0],
            item.box[3] - scroll[1],
          ];
          const want = nearest(box, item.tip);
          return {
            label: item.id,
            unchanged: item.unchanged,
            rows,
            scroll,
            tap,
            tip: item.tip,
            pointer: item.pointer,
            target: null,
            seq: 1,
            expectedId: 77,
            offset: [toQ16(want[0] - box[0]), toQ16(want[1] - box[1])] as Point,
            input: frameInput(poised(warm, item.tip, rows, 0, scroll), rows, {
              scroll,
              pointer: item.pointer,
              tap,
            }),
          };
        })
      : cases.tap.map((item) => {
          const tip: Point = [150, 70];
          const scroll = item.scroll ?? [0, 0];
          const tap = item.tap ?? [20, 20];
          return {
            label: item.id,
            unchanged: item.unchanged,
            rows: item.rows,
            scroll,
            tap,
            tip,
            pointer: tip,
            target: item.target,
            seq: item.seq ?? 1,
            expectedId: item.expectedId,
            offset: undefined,
            input: frameInput(poised(warm, tip, item.rows, item.oldSeq, scroll), item.rows, {
              scroll,
              pointer: tip,
              tap,
              target: item.target,
              seq: item.seq ?? 1,
            }),
          };
        });
  const outputs = await runtime.execute(
    program,
    'frame',
    prepared.map((item) => item.input),
  );
  const preserve = prepared.flatMap((item, index) => (item.unchanged ? [index] : []));
  if (preserve.length) {
    const expected = await runtime.execute(
      baseline,
      'frame',
      preserve.map((index) => {
        const item = prepared[index];
        assert.ok(item);
        return item.input;
      }),
    );
    preserve.forEach((index, at) => {
      capture(`${prepared[index]?.label}/complete unaffected frame`, () => {
        equalFrame(outputs[index], expected[at]);
      });
    });
  }
  const followups: number[][] = [];
  outputs.forEach((output, index) => {
    const item = prepared[index];
    assert.ok(item);
    capture(item.label, () => {
      const state = sentinelState(output);
      assert.equal(state[98], item.expectedId, 'selected control ID');
      if (item.offset) assert.deepEqual([state[99], state[100]], item.offset, 'anchor page offset');
      if (item.expectedId) assert.equal((state[115] as number) & 1, 1, 'tap-forced flag');
      assert.equal(state[22], item.seq, 'tap sequence recorded');
      followups.push(
        frameInput(state, item.rows, {
          scroll: item.scroll,
          pointer: item.pointer,
          tap: item.tap,
          target: item.target,
          seq: item.seq,
        }),
      );
    });
  });
  // A followup consumes the persisted application output, and must not retrigger the same tap.
  if (followups.length === prepared.length) {
    const next = await runtime.execute(program, 'frame', followups);
    next.forEach((output, index) => {
      capture(`${prepared[index]?.label}/persisted followup`, () => {
        const state = sentinelState(output);
        assert.equal(state[22], prepared[index]?.seq);
        if (prepared[index]?.offset)
          assert.deepEqual([state[99], state[100]], prepared[index]?.offset);
      });
    });
  }
  // A second route uses only persisted outputs from ordinary host frames: no state surgery.
  let ordinary = warm;
  for (let turn = 0; turn < 8; turn += 1) {
    const input = frameInput(ordinary, [], { pointer: [500 + turn * 2, 400], seq: 0 });
    const result = (await runtime.execute(program, 'frame', [input]))[0];
    const original = (await runtime.execute(baseline, 'frame', [input]))[0];
    capture(`ordinary frame ${turn}/complete unaffected output`, () =>
      equalFrame(result, original),
    );
    assert.ok(result);
    ordinary = sentinelState(result);
  }
  const last = (ordinary[97] as number) - 1;
  const px = ((ordinary[128 + 6 * last] as number) | 0) / 65536;
  const py = ((ordinary[129 + 6 * last] as number) | 0) / 65536;
  const inner: Box = [
    Math.floor(px) - 5,
    Math.floor(py) - 5,
    Math.floor(px) + 5,
    Math.floor(py) + 5,
  ];
  const outer: Box = [
    Math.floor(px) - 20,
    Math.floor(py) - 20,
    Math.floor(px) + 20,
    Math.floor(py) + 20,
  ];
  const actualRows: Row[] = [
    { id: 101, box: inner, kind: 4 },
    { id: 202, box: outer, kind: 4 },
  ];
  const selected = (
    await runtime.execute(program, 'frame', [
      frameInput(ordinary, actualRows, {
        pointer: [px, py],
        tap: [px, py],
        target: kind === 'tap' ? outer : null,
      }),
    ])
  )[0];
  assert.ok(selected);
  capture('ordinary host warmup and tap', () => {
    const state = sentinelState(selected);
    assert.equal(state[98], kind === 'tap' ? 202 : 101, 'actual host tap target');
    if (kind === 'edge') {
      const point = nearest(inner, [px, py]);
      assert.deepEqual(
        [state[99], state[100]],
        [toQ16(point[0] - inner[0]), toQ16(point[1] - inner[1])],
      );
    }
  });
  return failures;
}
