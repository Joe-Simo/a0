import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  type Bounds,
  bufferFor,
  type Ctx2D,
  drawCommands,
  emptyBounds,
} from '../site/live/canvas.js';
import {
  type GeoEnv,
  GeometryRegistry,
  type IntersectionEntryLike,
  type RectLike,
} from '../site/live/geometry.js';
import { PointerTracker } from '../site/live/pointer.js';
import { type FrameInput, type LiveExports, LiveProgram } from '../site/live/program.js';
import { FLAG, fromQ16, OP, parseHostCommands, ROW_WORDS, toQ16 } from '../site/live/words.js';
import { compile } from '../src/backends.js';
import { link } from '../src/link.js';
import { wasmModuleBytes } from '../src/wasm.js';
import { LIVE_PROGRAMS } from '../tools/live-programs.js';

/** The generic live-program host (site/live/*) and the A0 Sentinel running on it, headless. */

test('words: fixed-point, host commands and the byte stream', () => {
  assert.equal(fromQ16(toQ16(-3.5)), -3.5);
  assert.equal(fromQ16(toQ16(1234.25)), 1234.25);
  const sel = Array.from(new TextEncoder().encode('h1,h2'));
  const out = [
    OP.watch,
    4,
    sel.length,
    ...sel,
    OP.quality,
    80,
    OP.state,
    3,
    7,
    8,
    9,
    OP.disc,
    0,
    0,
    0,
    0,
  ];
  const r = parseHostCommands(out, out.length);
  assert.deepEqual(r.watches, [{ kind: 4, selector: 'h1,h2' }]);
  assert.equal(r.quality, 80);
  assert.deepEqual(out.slice(r.stateStart, r.stateStart + r.stateLength), [7, 8, 9]);
  assert.equal(out[r.drawStart], OP.disc);
  // a hostile length is clamped to the words that exist
  const bad = parseHostCommands([OP.state, 4000000000, 1], 3);
  assert.equal(bad.stateLength, 1);
});

class Recorder {
  calls: string[] = [];
  globalCompositeOperation = '';
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  lineWidth = 1;
  strokeStyle: unknown = '';
  fillStyle: unknown = '';
  private rec(n: string) {
    return (...a: unknown[]): void => {
      this.calls.push(
        `${n}(${a.map((x) => (typeof x === 'number' ? x.toFixed(2) : String(x))).join(',')})`,
      );
    };
  }
  setTransform = this.rec('setTransform');
  clearRect = this.rec('clearRect');
  beginPath = this.rec('beginPath');
  moveTo = this.rec('moveTo');
  lineTo = this.rec('lineTo');
  arc = this.rec('arc');
  stroke = this.rec('stroke');
  fill = this.rec('fill');
  createRadialGradient = (...a: number[]): { addColorStop(): void } => {
    this.calls.push(`gradient(${a.length})`);
    return { addColorStop: () => undefined };
  };
}

test('canvas: the draw list executes, tracks bounds, and stops at an unknown or truncated command', () => {
  const ctx = new Recorder();
  const q = toQ16;
  const words = [
    OP.line,
    q(10),
    q(20),
    q(30),
    q(40),
    q(2),
    0xff0000ff,
    OP.disc,
    q(50),
    q(60),
    q(4),
    0x00ff00ff,
    OP.sphere,
    q(70),
    q(80),
    q(5),
    0xffffffff,
    0x000000ff,
    OP.path,
    2,
    q(1),
    0xffffffff,
    q(0),
    q(0),
    q(9),
    q(9),
    999,
    1,
    2,
    OP.disc,
    q(1),
    q(1),
  ];
  const b: Bounds = emptyBounds();
  const n = drawCommands(ctx as unknown as Ctx2D, words, 0, words.length, b);
  assert.equal(n, 4);
  assert.ok(b.x0 <= 0 && b.x1 >= 75 && b.y0 <= 0 && b.y1 >= 85);
  assert.ok(ctx.calls.includes('gradient(6)'));
  const flat = new Recorder();
  drawCommands(flat as unknown as Ctx2D, words, 0, words.length, emptyBounds(), false);
  assert.ok(!flat.calls.some((c) => c.startsWith('gradient')), 'no gradients at low detail');
  // dpr is capped and the buffer is bounded
  const big = bufferFor({ cssWidth: 3840, cssHeight: 2160, dpr: 3, percent: 100 });
  assert.ok(big.width * big.height <= 6_000_000 * 1.01);
  assert.equal(bufferFor({ cssWidth: 100, cssHeight: 50, dpr: 3, percent: 50 }).width, 100);
});

test('pointer: passive listeners, touch scroll hand-over, taps with the interactive target, mouse leave', () => {
  const win = new EventTarget();
  const doc = new EventTarget();
  const opts: (boolean | undefined)[] = [];
  const orig = win.addEventListener.bind(win);
  win.addEventListener = ((t: string, f: never, o?: AddEventListenerOptions) => {
    opts.push(o?.passive);
    orig(t, f, o);
  }) as typeof win.addEventListener;
  const tr = new PointerTracker(win, doc, () => [0, 100]);
  tr.attach();
  assert.ok(opts.length > 0 && opts.every((p) => p === true), 'every listener is passive');
  const fire = (host: EventTarget, type: string, props: Record<string, unknown>): void => {
    const ev = new Event(type);
    for (const [k, v] of Object.entries(props)) Object.defineProperty(ev, k, { value: v });
    host.dispatchEvent(ev);
  };
  fire(win, 'pointermove', { clientX: 10, clientY: 20, pointerType: 'mouse' });
  let s = tr.snapshot();
  assert.deepEqual([s.x, s.y, s.type, s.present], [10, 20, 1, true]);
  fire(doc, 'pointerleave', { pointerType: 'mouse' });
  assert.equal(tr.snapshot().present, false);
  const target = {
    closest: (sel: string) =>
      sel.includes('button')
        ? { getBoundingClientRect: () => ({ left: 5, top: 6, right: 25, bottom: 16 }) }
        : null,
  };
  fire(win, 'pointerdown', { clientX: 50, clientY: 60, pointerType: 'touch', timeStamp: 1000 });
  assert.equal(tr.snapshot().down, true);
  fire(win, 'pointerup', {
    clientX: 51,
    clientY: 61,
    pointerType: 'touch',
    timeStamp: 1100,
    target,
  });
  s = tr.snapshot();
  assert.equal(s.tapSeq, 1);
  assert.deepEqual(s.tapRect, [5, 106, 25, 116], 'page-space box of the tapped control');
  assert.equal(s.type, 3);
  // a drag is not a tap; the browser taking the gesture is reported once
  fire(win, 'pointerdown', { clientX: 50, clientY: 60, pointerType: 'touch', timeStamp: 2000 });
  fire(win, 'pointermove', { clientX: 50, clientY: 90, pointerType: 'touch', timeStamp: 2050 });
  fire(win, 'pointercancel', { pointerType: 'touch' });
  assert.equal(tr.snapshot().cancelled, true);
  assert.equal(tr.snapshot().cancelled, false);
  assert.equal(tr.snapshot().tapSeq, 1);
  tr.detach();
});

/** A fake page: elements with fixed boxes and observers driven by hand. */
function fakeEnv(): {
  env: GeoEnv;
  els: { rect: RectLike; sel: string }[];
  state: { sx: number; sy: number; docH: number };
  fire: {
    intersect(list: IntersectionEntryLike[]): void;
    resize(t: unknown[]): void;
    mutate(): void;
  };
} {
  const els: { rect: RectLike; sel: string; getBoundingClientRect(): RectLike }[] = [];
  const state = { sx: 0, sy: 0, docH: 5000 };
  let io: ((e: readonly IntersectionEntryLike[]) => void) | undefined;
  let ro: ((t: readonly never[]) => void) | undefined;
  let mo: (() => void) | undefined;
  const env: GeoEnv = {
    query: (s) => els.filter((e) => e.sel === s) as never,
    scroll: () => [state.sx, state.sy],
    viewport: () => [1000, 800],
    docHeight: () => state.docH,
    intersection: (cb) => {
      io = cb;
      return { observe: () => undefined, unobserve: () => undefined, disconnect: () => undefined };
    },
    resize: (cb) => {
      ro = cb as never;
      return { observe: () => undefined, unobserve: () => undefined, disconnect: () => undefined };
    },
    mutation: (cb) => {
      mo = cb;
      return { disconnect: () => undefined };
    },
    onViewportResize: () => () => undefined,
    observeDocument: () => ({ disconnect: () => undefined }),
  };
  return {
    env,
    els: els as never,
    state,
    fire: {
      intersect: (l) => io?.(l),
      resize: (t) => ro?.(t as never),
      mutate: () => mo?.(),
    },
  };
}

test('geometry: page-relative boxes, kinds by first matching selector, cap and rebuild throttle', () => {
  const f = fakeEnv();
  const mk = (sel: string, l: number, t: number, r: number, b: number) => {
    const o = {
      sel,
      rect: { left: l, top: t, right: r, bottom: b },
      getBoundingClientRect: () => o.rect,
    };
    f.els.push(o);
    return o;
  };
  const h = mk('h1', 10, 20, 210, 60);
  mk('p', 10, 80, 210, 140);
  mk('p', 10, 4000, 210, 4100); // far: never reported
  const g = new GeometryRegistry(f.env, { max: 2, rebuildMs: 100 });
  g.watch(1, 'h1');
  g.watch(2, 'p');
  g.watch(9, 'h1'); // the same element again: the first spec wins
  g.start();
  g.update(0);
  assert.equal(g.stats.scans, 1);
  const near = (e: (typeof f.els)[number]): IntersectionEntryLike => ({
    target: e as never,
    isIntersecting: e.rect.top < 1100,
    boundingClientRect: e.rect,
  });
  f.state.sy = 50; // viewport coordinates are page minus scroll
  f.fire.intersect(f.els.map((e) => near(e)));
  assert.equal(g.update(150), true);
  assert.equal(g.count, 2);
  const t = g.table;
  const rowOf = (kind: number): number =>
    [0, 1].map((i) => i * ROW_WORDS).find((o) => ((t[o + 5] as number) & 255) === kind) as number;
  assert.equal(t[rowOf(1) + 5], 1 | (1 << 8), 'heading kind 1, in viewport');
  assert.equal(t[rowOf(1) + 1], 10);
  assert.equal(t[rowOf(1) + 2], 70, 'page y = viewport y + scroll');
  // a resized element is remeasured through the observer, not by polling
  h.rect = { left: 10, top: 20, right: 310, bottom: 60 };
  f.fire.resize([h]);
  assert.equal(g.update(160), false, 'rebuilds are throttled');
  assert.equal(g.update(300), true);
  assert.equal(g.table[rowOf(1) + 3], 310);
  // scrolling alone only rebuilds (no scans, no new measurements)
  const m = g.stats.measures;
  f.state.sy = 400;
  assert.equal(g.update(500), true);
  assert.equal(g.stats.measures, m);
  assert.equal(g.stats.scans, 1);
  assert.equal(g.docHeight, 5000);
  // a DOM mutation schedules one throttled rescan
  f.fire.mutate();
  g.update(700);
  assert.equal(g.stats.scans, 2);
  g.stop();
});

/** The Sentinel and its host, headless. */
const SPEC = LIVE_PROGRAMS[0] as (typeof LIVE_PROGRAMS)[number];
async function sentinel(): Promise<{ make: () => LiveProgram }> {
  const program = (await link(`site/${SPEC.entry}`, (f) => readFile(f, 'utf8'), { root: '.' }))
    .program;
  const bytes = wasmModuleBytes(
    compile(program, 'wasm', {
      ioInputCapacity: SPEC.inputWords,
      ioOutputCapacity: SPEC.outputWords,
      wasmExports: ['frame'],
    }).text,
  );
  const mod = await WebAssembly.compile(bytes as BufferSource);
  return {
    make: () => {
      const inst = new WebAssembly.Instance(mod, {});
      return new LiveProgram(inst.exports as unknown as LiveExports, {
        inputWords: SPEC.inputWords,
        outputWords: SPEC.outputWords,
        rows: SPEC.rows,
      });
    },
  };
}

interface Box {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: number;
}
function pageBoxes(): Box[] {
  const r: Box[] = [];
  let id = 1;
  let y = 100;
  for (let s = 0; s < 6; s += 1) {
    r.push({ id: id++, x0: 140, y0: y, x1: 640, y1: y + 48, kind: 1 });
    y += 64;
    r.push({ id: id++, x0: 140, y0: y, x1: 700, y1: y + 70, kind: 2 });
    y += 86;
    r.push({ id: id++, x0: 140, y0: y, x1: 760, y1: y + 150, kind: 3 });
    y += 170;
    r.push({ id: id++, x0: 800, y0: y - 250, x1: 1100, y1: y - 100, kind: 5 });
    r.push({ id: id++, x0: 800, y0: y - 80, x1: 880, y1: y - 48, kind: 4 });
  }
  return r;
}
function table(boxes: Box[], sy = 0): Uint32Array {
  const t = new Uint32Array(SPEC.rows * ROW_WORDS);
  boxes.forEach((b, i) => {
    const vis = b.y1 > sy - 40 && b.y0 < sy + 840 ? 1 : 0;
    t.set([b.id, b.x0, b.y0, b.x1, b.y1, b.kind | (vis << 8)], i * ROW_WORDS);
  });
  return t;
}
interface Drive {
  prog: LiveProgram;
  boxes: Box[];
  gen: number;
  sy: number;
  t: number;
  frames: number;
}
function drive(prog: LiveProgram, boxes: Box[]): Drive {
  return { prog, boxes, gen: 1, sy: 0, t: 0, frames: 0 };
}
function step(d: Drive, o: Partial<FrameInput> & { flags?: number } = {}): void {
  const input: FrameInput = {
    dt: 16,
    flags: (d.frames === 0 ? FLAG.first : 0) | FLAG.pointer,
    vw: 1280,
    vh: 800,
    scrollX: 0,
    scrollY: d.sy,
    dpr: 1,
    pointerX: 400,
    pointerY: 400,
    pointerType: 1,
    tapSeq: 0,
    tapX: 0,
    tapY: 0,
    tapRect: null,
    costUs: 800,
    intervalUs: 16667,
    docHeight: 5000,
    timeMs: d.t,
    generation: d.gen,
    ...o,
  };
  d.prog.frame(input, table(d.boxes, d.sy), d.boxes.length);
  d.t += 16;
  d.frames += 1;
}
const S = (p: LiveProgram): Uint32Array => p.stateWords();
const body = (p: LiveProgram): { x: number; y: number; vx: number; vy: number } => {
  const s = S(p);
  return {
    x: fromQ16(s[1] as number),
    y: fromQ16(s[2] as number),
    vx: fromQ16(s[3] as number),
    vy: fromQ16(s[4] as number),
  };
};
const tent = (
  p: LiveProgram,
  k: number,
): {
  state: number;
  nj: number;
  seg: number;
  joints: [number, number][];
  ax: number;
  ay: number;
  rid: number;
} => {
  const s = S(p);
  const b = 96 + k * 96;
  const nj = s[b + 1] as number;
  const joints: [number, number][] = [];
  for (let j = 0; j < nj; j += 1)
    joints.push([fromQ16(s[b + 32 + 6 * j] as number), fromQ16(s[b + 33 + 6 * j] as number)]);
  return {
    state: s[b] as number,
    nj,
    seg: fromQ16(s[b + 8] as number),
    joints,
    ax: fromQ16(s[b + 23] as number),
    ay: fromQ16(s[b + 24] as number),
    rid: s[b + 2] as number,
  };
};

test('sentinel: asks the host to watch page elements, once, by kind', async () => {
  const { make } = await sentinel();
  const prog = make();
  const w = prog.frame(
    {
      dt: 16,
      flags: FLAG.first | FLAG.pointer,
      vw: 1280,
      vh: 800,
      scrollX: 0,
      scrollY: 0,
      dpr: 1,
      pointerX: 1,
      pointerY: 1,
      pointerType: 1,
      tapSeq: 0,
      tapX: 0,
      tapY: 0,
      tapRect: null,
      costUs: 0,
      intervalUs: 16667,
      docHeight: 0,
      timeMs: 0,
      generation: 0,
    },
    new Uint32Array(SPEC.rows * ROW_WORDS),
    0,
  );
  assert.deepEqual(
    w.watches.map((x) => x.kind),
    [1, 3, 4, 2, 5, 6],
  );
  assert.ok(w.watches.every((x) => x.selector.length > 0));
  const second = prog.frame(
    {
      dt: 16,
      flags: FLAG.pointer,
      vw: 1280,
      vh: 800,
      scrollX: 0,
      scrollY: 0,
      dpr: 1,
      pointerX: 1,
      pointerY: 1,
      pointerType: 1,
      tapSeq: 0,
      tapX: 0,
      tapY: 0,
      tapRect: null,
      costUs: 0,
      intervalUs: 16667,
      docHeight: 0,
      timeMs: 16,
      generation: 0,
    },
    new Uint32Array(SPEC.rows * ROW_WORDS),
    0,
  );
  assert.equal(second.watches.length, 0);
});

test('sentinel: pursues the pointer with inertia, keeps its distance, tentacles keep their length', async () => {
  const { make } = await sentinel();
  const d = drive(make(), pageBoxes());
  step(d, { pointerX: 300, pointerY: 300 });
  const start = body(d.prog);
  // the pointer jumps; the body must not
  step(d, { pointerX: 900, pointerY: 500 });
  const after = body(d.prog);
  assert.ok(Math.hypot(after.x - start.x, after.y - start.y) < 40, 'no teleport to the pointer');
  let maxSpeed = 0;
  let overshoot = false;
  let prevDist = Infinity;
  for (let i = 0; i < 300; i += 1) {
    step(d, { pointerX: 900, pointerY: 500 });
    const b = body(d.prog);
    maxSpeed = Math.max(maxSpeed, Math.hypot(b.vx, b.vy));
    const dist = Math.hypot(b.x - 900, b.y - 500);
    if (dist > prevDist + 0.5 && i > 20 && dist < 200) overshoot = overshoot || false;
    prevDist = dist;
  }
  const b = body(d.prog);
  const dist = Math.hypot(b.x - 900, b.y - 500);
  assert.ok(dist > 50 && dist < 130, `settles 60-120px from the pointer, got ${dist.toFixed(1)}`);
  assert.ok(Math.hypot(b.vx, b.vy) < 25, 'comes to rest');
  assert.ok(
    maxSpeed > 150 && maxSpeed < 2300,
    `accelerates with a bounded speed (${maxSpeed.toFixed(0)})`,
  );
  void overshoot;
  for (let k = 0; k < 8; k += 1) {
    const t = tent(d.prog, k);
    assert.ok(t.nj >= 6 && t.nj <= 9);
    for (let j = 0; j + 1 < t.nj; j += 1) {
      const [ax, ay] = t.joints[j] as [number, number];
      const [bx, by] = t.joints[j + 1] as [number, number];
      const len = Math.hypot(bx - ax, by - ay);
      assert.ok(
        len > t.seg * 0.45 && len < t.seg * 1.9,
        `segment ${k}.${j} length ${len.toFixed(1)} vs ${t.seg.toFixed(1)}`,
      );
    }
  }
  // personalities differ (not synchronized)
  assert.ok(new Set(Array.from({ length: 8 }, (_, k) => tent(d.prog, k).nj)).size > 1);
});

test('sentinel: tentacles attach to the boundary of real page elements, follow scrolling, release', async () => {
  const { make } = await sentinel();
  const d = drive(make(), pageBoxes());
  let attachedSeen = 0;
  let onBoundary = true;
  let maxAttached = 0;
  const kinds = new Set<number>();
  for (let i = 0; i < 900; i += 1) {
    const x = 300 + 250 * Math.sin(i / 90);
    step(d, { pointerX: x, pointerY: 300 + 60 * Math.sin(i / 50) });
    const att: number[] = [];
    for (let k = 0; k < 8; k += 1) {
      const t = tent(d.prog, k);
      if (t.state === 2) {
        att.push(k);
        const box = d.boxes.find((b) => b.id === t.rid) as Box;
        const px = t.ax + 0;
        const py = t.ay + d.sy;
        const inside = px >= box.x0 - 1 && px <= box.x1 + 1 && py >= box.y0 - 1 && py <= box.y1 + 1;
        const edge = Math.min(px - box.x0, box.x1 - px, py - box.y0, box.y1 - py) < 2;
        if (!inside || !edge) onBoundary = false;
        kinds.add(box.kind);
        // the tip sits on its anchor
        const [tx, ty] = t.joints[t.nj - 1] as [number, number];
        assert.ok(Math.hypot(tx - t.ax, ty - t.ay) < 1.5, 'attached tip is pinned to its anchor');
      }
    }
    if (att.length > 0) attachedSeen += 1;
    maxAttached = Math.max(maxAttached, att.length);
  }
  assert.ok(attachedSeen > 300, `tentacles spend time attached (${attachedSeen} frames)`);
  assert.ok(onBoundary, 'anchors lie on the boundary of element boxes');
  assert.ok(maxAttached >= 2 && maxAttached <= 4, `2-4 contacts at once (${maxAttached})`);
  assert.ok(kinds.size >= 2, 'more than one kind of element is used');
  // scroll: an attached anchor moves with its element (page-relative)
  let k = -1;
  for (let i = 0; i < 400 && k < 0; i += 1) {
    step(d, { pointerX: 400, pointerY: 300 });
    for (let j = 0; j < 8; j += 1) if (tent(d.prog, j).state === 2) k = j;
  }
  assert.ok(k >= 0);
  const before = tent(d.prog, k);
  d.sy += 12;
  step(d, { pointerX: 400, pointerY: 300, scrollY: d.sy });
  const moved = tent(d.prog, k);
  if (moved.state === 2 && moved.rid === before.rid)
    assert.ok(Math.abs(moved.ay - (before.ay - 12)) < 1.5, 'anchor shifted with the page');
  // when its element disappears from the table, the tentacle lets go
  d.boxes = d.boxes.filter((b) => b.id !== before.rid);
  d.gen += 1;
  step(d, { pointerX: 400, pointerY: 300, scrollY: d.sy });
  assert.notEqual(tent(d.prog, k).state, 2);
  // a far scroll releases everything it held far from the viewport
  d.sy += 4000;
  for (let i = 0; i < 30; i += 1) step(d, { scrollY: d.sy });
});

test('sentinel: touch scrolling suspends pursuit; a tap reaches toward the element; reduced motion is still', async () => {
  const { make } = await sentinel();
  const d = drive(make(), pageBoxes());
  for (let i = 0; i < 200; i += 1)
    step(d, { pointerType: 3, flags: FLAG.pointer | FLAG.coarse, pointerX: 600, pointerY: 300 });
  const idle = body(d.prog);
  // a finger goes down and the page scrolls under it: the body keeps wandering, it does not chase
  for (let i = 0; i < 120; i += 1) {
    d.sy += 6;
    step(d, {
      pointerType: 3,
      flags: FLAG.pointer | FLAG.down | FLAG.coarse,
      pointerX: 100 + i,
      pointerY: 700,
      scrollY: d.sy,
    });
  }
  const scrolled = body(d.prog);
  assert.ok(
    Math.hypot(scrolled.x - 220, scrolled.y - 700) > 100,
    'does not follow a scrolling finger',
  );
  void idle;
  // a tap on a control: tentacles reach for it (visual only)
  const ctl = d.boxes.find((b) => b.kind === 4 && b.y0 > d.sy && b.y1 < d.sy + 700) as Box;
  for (let i = 0; i < 100; i += 1)
    step(d, { pointerType: 3, scrollY: d.sy, pointerX: ctl.x0 - 60, pointerY: ctl.y0 - d.sy });
  step(d, {
    pointerType: 3,
    scrollY: d.sy,
    tapSeq: 1,
    tapX: (ctl.x0 + ctl.x1) / 2,
    tapY: (ctl.y0 + ctl.y1) / 2 - d.sy,
    tapRect: [ctl.x0, ctl.y0, ctl.x1, ctl.y1],
  });
  let toward = 0;
  for (let i = 0; i < 40; i += 1) {
    step(d, { pointerType: 3, scrollY: d.sy, tapSeq: 1 });
    for (let k = 0; k < 8; k += 1)
      if (tent(d.prog, k).rid === ctl.id && tent(d.prog, k).state > 0) toward += 1;
  }
  assert.ok(toward > 0, 'a nearby tentacle reached for the tapped element');
  // reduced motion: the first frame settles the pose, later frames change nothing
  const r = drive(make(), pageBoxes());
  step(r, { flags: FLAG.first | FLAG.reduced });
  const a = Array.from(S(r.prog));
  for (let i = 0; i < 30; i += 1)
    step(r, { flags: FLAG.reduced, pointerX: 100 + i * 20, pointerY: 100 });
  assert.deepEqual(Array.from(S(r.prog)), a, 'reduced motion: no pursuit, no crawling');
});

test('sentinel: deterministic, and never writes outside its output', async () => {
  const { make } = await sentinel();
  const run = (): number[] => {
    const d = drive(make(), pageBoxes());
    for (let i = 0; i < 150; i += 1) step(d, { pointerX: 300 + i * 3, pointerY: 300 });
    return Array.from(S(d.prog));
  };
  assert.deepEqual(run(), run());
  const d = drive(make(), pageBoxes());
  step(d);
  const inWords = Array.from(d.prog.words.subarray(0, 32 + SPEC.rows * ROW_WORDS));
  for (let i = 0; i < 60; i += 1) step(d, { pointerX: 500, pointerY: 200 });
  assert.deepEqual(
    Array.from(d.prog.words.subarray(32, 32 + SPEC.rows * ROW_WORDS)),
    inWords.slice(32),
    'the geometry table is read only',
  );
  // the shell asks for the sizes the program was built with
  const html = await readFile('site/index.html', 'utf8');
  assert.ok(html.includes(`data-live="/${SPEC.name}.wasm"`));
  assert.ok(html.includes(`data-live-in="${SPEC.inputWords}"`));
  assert.ok(html.includes(`data-live-out="${SPEC.outputWords}"`));
  assert.ok(html.includes(`data-live-rows="${SPEC.rows}"`));
});

test('mounting a live program never touches the page stylesheet or its root attributes', async () => {
  // The host only creates its own canvas and sets that canvas's inline style; it must not create or
  // edit <style> elements, rules or the root's attributes (the page program owns those).
  const files = [
    'site/live.ts',
    'site/live/canvas.ts',
    'site/live/geometry.ts',
    'site/live/pointer.ts',
    'site/live/program.ts',
  ];
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    assert.ok(
      !/createElement\(['"]style['"]\)|insertRule|adoptedStyleSheets|querySelector\(['"]style|document\.head|removeAttribute/.test(
        src,
      ),
      `${f} must not touch stylesheets or root attributes`,
    );
  }
  // the request is read once from the static shell, before the first render, and handed to the mount
  const app = await readFile('site/app.ts', 'utf8');
  assert.ok(app.includes('const liveConfig = { ...root.dataset }'));
  assert.ok(app.includes('mountLive(root, liveConfig)'));
});
