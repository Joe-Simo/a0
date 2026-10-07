/**
 * A cache of page geometry for a live program. The program names what it cares about as
 * (kind, CSS selector) pairs; this registry finds those elements, keeps their page-relative
 * boxes, and hands the program a flat table of the ones near the viewport.
 *
 * Geometry is separated from the frame loop. Boxes are measured on load, on window resize,
 * when an element enters or leaves the zone around the viewport (IntersectionObserver), when
 * an observed element changes size (ResizeObserver), when the document height changes (layout
 * moved something), and after DOM mutations (a throttled MutationObserver rescan). Scrolling
 * changes nothing here except which rows the program is told about; no per-frame layout read
 * happens, and a scroll alone only rebuilds the table (at most every `rebuildMs`).
 */

import { ROW_WORDS } from './words.js';

export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
export interface ElementLike {
  getBoundingClientRect(): RectLike;
}
export interface IntersectionEntryLike {
  readonly target: ElementLike;
  readonly isIntersecting: boolean;
  readonly boundingClientRect: RectLike;
}
export interface ObserverLike {
  observe(el: ElementLike): void;
  unobserve(el: ElementLike): void;
  disconnect(): void;
}

/** What the registry needs from the browser; the tests supply a fake. */
export interface GeoEnv {
  query(selector: string): ArrayLike<ElementLike>;
  scroll(): readonly [number, number];
  viewport(): readonly [number, number];
  docHeight(): number;
  intersection(cb: (entries: readonly IntersectionEntryLike[]) => void, marginPx: number): ObserverLike;
  resize(cb: (targets: readonly ElementLike[]) => void): ObserverLike;
  mutation(cb: () => void): { disconnect(): void };
  onViewportResize(cb: () => void): () => void;
  observeDocument(cb: () => void): { disconnect(): void };
}

export interface GeometryOptions {
  /** Rows handed to the program at most. */
  readonly max?: number;
  /** Distance around the viewport, in px, inside which elements are tracked. */
  readonly margin?: number;
  /** Least time between table rebuilds, ms. */
  readonly rebuildMs?: number;
  /** Least time between DOM rescans after mutations, ms. */
  readonly rescanMs?: number;
}

interface Entry {
  readonly id: number;
  kind: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  hasBox: boolean;
  near: boolean;
}

export class GeometryRegistry {
  private readonly specs: { kind: number; selector: string }[] = [];
  private entries = new Map<ElementLike, Entry>();
  private nextId = 1;
  private io: ObserverLike | undefined;
  private ro: ObserverLike | undefined;
  private mo: { disconnect(): void } | undefined;
  private doc: { disconnect(): void } | undefined;
  private offResize: (() => void) | undefined;
  private scanAt = Infinity;
  private relayoutAt = Infinity;
  private dirty = false;
  private lastBuild = -Infinity;
  private lastSx = 0;
  private lastSy = 0;
  private readonly max: number;
  private readonly margin: number;
  private readonly rebuildMs: number;
  private readonly rescanMs: number;
  private firstDoc = true;
  /** The rows handed to the program: ROW_WORDS words each. */
  readonly table: Uint32Array;
  count = 0;
  /** Document height at the last table rebuild, px. */
  docHeight = 0;
  /** Bumped every time the table is rebuilt. */
  generation = 0;
  readonly stats = { scans: 0, measures: 0, rebuilds: 0 };

  constructor(
    private readonly env: GeoEnv,
    options: GeometryOptions = {},
  ) {
    this.max = options.max ?? 192;
    this.margin = options.margin ?? 320;
    this.rebuildMs = options.rebuildMs ?? 100;
    this.rescanMs = options.rescanMs ?? 150;
    this.table = new Uint32Array(this.max * ROW_WORDS);
  }

  /** Track the elements matching `selector` as `kind`; the first spec that matches an element wins. */
  watch(kind: number, selector: string): void {
    if (this.specs.some((s) => s.kind === kind && s.selector === selector)) return;
    this.specs.push({ kind, selector });
    this.scanAt = Math.min(this.scanAt, 0);
  }

  start(): void {
    this.io = this.env.intersection((es) => this.onIntersect(es), this.margin);
    this.ro = this.env.resize((ts) => this.onResize(ts));
    this.mo = this.env.mutation(() => {
      this.scanAt = Math.min(this.scanAt, this.lastNow + this.rescanMs);
    });
    this.doc = this.env.observeDocument(() => {
      // The first callback is the initial size; later ones mean content moved.
      if (this.firstDoc) this.firstDoc = false;
      else this.relayoutAt = Math.min(this.relayoutAt, this.lastNow + 120);
    });
    this.offResize = this.env.onViewportResize(() => {
      this.relayoutAt = Math.min(this.relayoutAt, this.lastNow + 120);
      this.dirty = true;
    });
    this.scanAt = 0;
  }

  stop(): void {
    this.io?.disconnect();
    this.ro?.disconnect();
    this.mo?.disconnect();
    this.doc?.disconnect();
    this.offResize?.();
    this.entries.clear();
    this.count = 0;
  }

  private lastNow = 0;

  /**
   * Called once per frame with the frame time. Does the due scan, remeasure and table rebuild;
   * returns true when the table changed.
   */
  update(now: number): boolean {
    this.lastNow = now;
    if (now >= this.scanAt) {
      this.scanAt = Infinity;
      this.scan();
    }
    if (now >= this.relayoutAt) {
      this.relayoutAt = Infinity;
      this.remeasure();
    }
    const [sx, sy] = this.env.scroll();
    if (Math.abs(sx - this.lastSx) > 40 || Math.abs(sy - this.lastSy) > 40) this.dirty = true;
    if (this.dirty && now - this.lastBuild >= this.rebuildMs) {
      this.build(now, sx, sy);
      return true;
    }
    return false;
  }

  private scan(): void {
    this.stats.scans += 1;
    const claimed = new Set<ElementLike>();
    const next = new Map<ElementLike, Entry>();
    const added: ElementLike[] = [];
    for (const spec of this.specs) {
      let list: ArrayLike<ElementLike>;
      try {
        list = this.env.query(spec.selector);
      } catch {
        continue; // an invalid selector from the program is ignored
      }
      for (let i = 0; i < list.length; i += 1) {
        const el = list[i] as ElementLike;
        if (claimed.has(el)) continue;
        claimed.add(el);
        let e = this.entries.get(el);
        if (e === undefined) {
          e = { id: this.nextId, kind: spec.kind, x0: 0, y0: 0, x1: 0, y1: 0, hasBox: false, near: false };
          this.nextId += 1;
          added.push(el);
        } else e.kind = spec.kind;
        next.set(el, e);
      }
    }
    for (const el of this.entries.keys()) {
      if (!next.has(el)) {
        this.io?.unobserve(el);
        this.ro?.unobserve(el);
      }
    }
    this.entries = next;
    for (const el of added) this.io?.observe(el);
    this.dirty = true;
  }

  private box(e: Entry, r: RectLike, sx: number, sy: number): void {
    e.x0 = Math.round(r.left + sx);
    e.y0 = Math.round(r.top + sy);
    e.x1 = Math.round(r.right + sx);
    e.y1 = Math.round(r.bottom + sy);
    e.hasBox = e.x1 > e.x0 && e.y1 > e.y0;
  }

  private onIntersect(list: readonly IntersectionEntryLike[]): void {
    const [sx, sy] = this.env.scroll();
    for (const it of list) {
      const e = this.entries.get(it.target);
      if (e === undefined) continue;
      e.near = it.isIntersecting;
      if (it.isIntersecting) {
        this.box(e, it.boundingClientRect, sx, sy);
        this.ro?.observe(it.target);
      } else this.ro?.unobserve(it.target);
    }
    this.dirty = true;
  }

  private onResize(targets: readonly ElementLike[]): void {
    const [sx, sy] = this.env.scroll();
    for (const t of targets) {
      const e = this.entries.get(t);
      if (e === undefined) continue;
      this.stats.measures += 1;
      this.box(e, t.getBoundingClientRect(), sx, sy);
    }
    this.dirty = true;
  }

  /** Measure every tracked element near the viewport (one batch of reads). */
  private remeasure(): void {
    const [sx, sy] = this.env.scroll();
    for (const [el, e] of this.entries) {
      if (!e.near) continue;
      this.stats.measures += 1;
      this.box(e, el.getBoundingClientRect(), sx, sy);
    }
    this.dirty = true;
  }

  private build(now: number, sx: number, sy: number): void {
    this.stats.rebuilds += 1;
    this.lastBuild = now;
    this.lastSx = sx;
    this.lastSy = sy;
    this.dirty = false;
    this.docHeight = this.env.docHeight();
    const [vw, vh] = this.env.viewport();
    const midY = sy + vh / 2;
    const midX = sx + vw / 2;
    const rows: { e: Entry; key: number }[] = [];
    for (const e of this.entries.values()) {
      if (!e.near || !e.hasBox) continue;
      const cy = (e.y0 + e.y1) / 2;
      const cx = (e.x0 + e.x1) / 2;
      rows.push({ e, key: Math.abs(cy - midY) + 0.35 * Math.abs(cx - midX) });
    }
    rows.sort((a, b) => a.key - b.key || a.e.id - b.e.id);
    const n = Math.min(rows.length, this.max);
    const t = this.table;
    for (let i = 0; i < n; i += 1) {
      const e = (rows[i] as { e: Entry }).e;
      const vis =
        e.x1 > sx - 40 && e.x0 < sx + vw + 40 && e.y1 > sy - 40 && e.y0 < sy + vh + 40 ? 1 : 0;
      const o = i * ROW_WORDS;
      t[o] = e.id;
      t[o + 1] = e.x0 >>> 0;
      t[o + 2] = e.y0 >>> 0;
      t[o + 3] = e.x1 >>> 0;
      t[o + 4] = e.y1 >>> 0;
      t[o + 5] = (e.kind & 255) | (vis << 8);
      t[o + 6] = 0;
    }
    this.count = n;
    this.generation = (this.generation + 1) >>> 0;
  }
}

/** The real browser environment. */
export function browserGeoEnv(win: Window, root: Element): GeoEnv {
  const doc = win.document;
  return {
    query: (s) => root.querySelectorAll(s) as unknown as ArrayLike<ElementLike>,
    scroll: () => [win.scrollX, win.scrollY],
    viewport: () => [win.innerWidth, win.innerHeight],
    docHeight: () => doc.documentElement.scrollHeight,
    intersection: (cb, marginPx) => {
      const io = new IntersectionObserver((es) => cb(es as readonly IntersectionEntryLike[]), {
        rootMargin: `${marginPx}px 0px ${marginPx}px 0px`,
      });
      return {
        observe: (el) => io.observe(el as Element),
        unobserve: (el) => io.unobserve(el as Element),
        disconnect: () => io.disconnect(),
      };
    },
    resize: (cb) => {
      const ro = new ResizeObserver((es) => cb(es.map((e) => e.target as ElementLike)));
      return {
        observe: (el) => ro.observe(el as Element),
        unobserve: (el) => ro.unobserve(el as Element),
        disconnect: () => ro.disconnect(),
      };
    },
    mutation: (cb) => {
      const mo = new MutationObserver(() => cb());
      mo.observe(root, { childList: true, subtree: true });
      return mo;
    },
    onViewportResize: (cb) => {
      win.addEventListener('resize', cb, { passive: true });
      return () => win.removeEventListener('resize', cb);
    },
    observeDocument: (cb) => {
      const ro = new ResizeObserver(() => cb());
      ro.observe(doc.documentElement);
      return ro;
    },
  };
}
