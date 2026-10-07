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
export class GeometryRegistry {
    env;
    specs = [];
    entries = new Map();
    nextId = 1;
    io;
    ro;
    mo;
    doc;
    offResize;
    scanAt = Infinity;
    relayoutAt = Infinity;
    dirty = false;
    lastBuild = -Infinity;
    lastSx = 0;
    lastSy = 0;
    max;
    margin;
    rebuildMs;
    rescanMs;
    firstDoc = true;
    /** The rows handed to the program: ROW_WORDS words each. */
    table;
    count = 0;
    /** Document height at the last table rebuild, px. */
    docHeight = 0;
    /** Bumped every time the table is rebuilt. */
    generation = 0;
    stats = { scans: 0, measures: 0, rebuilds: 0 };
    constructor(env, options = {}) {
        this.env = env;
        this.max = options.max ?? 192;
        this.margin = options.margin ?? 320;
        this.rebuildMs = options.rebuildMs ?? 100;
        this.rescanMs = options.rescanMs ?? 150;
        this.table = new Uint32Array(this.max * ROW_WORDS);
    }
    /** Track the elements matching `selector` as `kind`; the first spec that matches an element wins. */
    watch(kind, selector) {
        if (this.specs.some((s) => s.kind === kind && s.selector === selector))
            return;
        this.specs.push({ kind, selector });
        this.scanAt = Math.min(this.scanAt, 0);
    }
    start() {
        this.io = this.env.intersection((es) => this.onIntersect(es), this.margin);
        this.ro = this.env.resize((ts) => this.onResize(ts));
        this.mo = this.env.mutation(() => {
            this.scanAt = Math.min(this.scanAt, this.lastNow + this.rescanMs);
        });
        this.doc = this.env.observeDocument(() => {
            // The first callback is the initial size; later ones mean content moved.
            if (this.firstDoc)
                this.firstDoc = false;
            else
                this.relayoutAt = Math.min(this.relayoutAt, this.lastNow + 120);
        });
        this.offResize = this.env.onViewportResize(() => {
            this.relayoutAt = Math.min(this.relayoutAt, this.lastNow + 120);
            this.dirty = true;
        });
        this.scanAt = 0;
    }
    stop() {
        this.io?.disconnect();
        this.ro?.disconnect();
        this.mo?.disconnect();
        this.doc?.disconnect();
        this.offResize?.();
        this.entries.clear();
        this.count = 0;
    }
    lastNow = 0;
    /**
     * Called once per frame with the frame time. Does the due scan, remeasure and table rebuild;
     * returns true when the table changed.
     */
    update(now) {
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
        if (Math.abs(sx - this.lastSx) > 40 || Math.abs(sy - this.lastSy) > 40)
            this.dirty = true;
        if (this.dirty && now - this.lastBuild >= this.rebuildMs) {
            this.build(now, sx, sy);
            return true;
        }
        return false;
    }
    scan() {
        this.stats.scans += 1;
        const claimed = new Set();
        const next = new Map();
        const added = [];
        for (const spec of this.specs) {
            let list;
            try {
                list = this.env.query(spec.selector);
            }
            catch {
                continue; // an invalid selector from the program is ignored
            }
            for (let i = 0; i < list.length; i += 1) {
                const el = list[i];
                if (claimed.has(el))
                    continue;
                claimed.add(el);
                let e = this.entries.get(el);
                if (e === undefined) {
                    e = { id: this.nextId, kind: spec.kind, x0: 0, y0: 0, x1: 0, y1: 0, hasBox: false, near: false };
                    this.nextId += 1;
                    added.push(el);
                }
                else
                    e.kind = spec.kind;
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
        for (const el of added)
            this.io?.observe(el);
        this.dirty = true;
    }
    box(e, r, sx, sy) {
        e.x0 = Math.round(r.left + sx);
        e.y0 = Math.round(r.top + sy);
        e.x1 = Math.round(r.right + sx);
        e.y1 = Math.round(r.bottom + sy);
        e.hasBox = e.x1 > e.x0 && e.y1 > e.y0;
    }
    onIntersect(list) {
        const [sx, sy] = this.env.scroll();
        for (const it of list) {
            const e = this.entries.get(it.target);
            if (e === undefined)
                continue;
            e.near = it.isIntersecting;
            if (it.isIntersecting) {
                this.box(e, it.boundingClientRect, sx, sy);
                this.ro?.observe(it.target);
            }
            else
                this.ro?.unobserve(it.target);
        }
        this.dirty = true;
    }
    onResize(targets) {
        const [sx, sy] = this.env.scroll();
        for (const t of targets) {
            const e = this.entries.get(t);
            if (e === undefined)
                continue;
            this.stats.measures += 1;
            this.box(e, t.getBoundingClientRect(), sx, sy);
        }
        this.dirty = true;
    }
    /** Measure every tracked element near the viewport (one batch of reads). */
    remeasure() {
        const [sx, sy] = this.env.scroll();
        for (const [el, e] of this.entries) {
            if (!e.near)
                continue;
            this.stats.measures += 1;
            this.box(e, el.getBoundingClientRect(), sx, sy);
        }
        this.dirty = true;
    }
    build(now, sx, sy) {
        this.stats.rebuilds += 1;
        this.lastBuild = now;
        this.lastSx = sx;
        this.lastSy = sy;
        this.dirty = false;
        this.docHeight = this.env.docHeight();
        const [vw, vh] = this.env.viewport();
        const midY = sy + vh / 2;
        const midX = sx + vw / 2;
        const rows = [];
        for (const e of this.entries.values()) {
            if (!e.near || !e.hasBox)
                continue;
            const cy = (e.y0 + e.y1) / 2;
            const cx = (e.x0 + e.x1) / 2;
            rows.push({ e, key: Math.abs(cy - midY) + 0.35 * Math.abs(cx - midX) });
        }
        rows.sort((a, b) => a.key - b.key || a.e.id - b.e.id);
        const n = Math.min(rows.length, this.max);
        const t = this.table;
        for (let i = 0; i < n; i += 1) {
            const e = rows[i].e;
            const vis = e.x1 > sx - 40 && e.x0 < sx + vw + 40 && e.y1 > sy - 40 && e.y0 < sy + vh + 40 ? 1 : 0;
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
export function browserGeoEnv(win, root) {
    const doc = win.document;
    return {
        query: (s) => root.querySelectorAll(s),
        scroll: () => [win.scrollX, win.scrollY],
        viewport: () => [win.innerWidth, win.innerHeight],
        docHeight: () => doc.documentElement.scrollHeight,
        intersection: (cb, marginPx) => {
            const io = new IntersectionObserver((es) => cb(es), {
                rootMargin: `${marginPx}px 0px ${marginPx}px 0px`,
            });
            return {
                observe: (el) => io.observe(el),
                unobserve: (el) => io.unobserve(el),
                disconnect: () => io.disconnect(),
            };
        },
        resize: (cb) => {
            const ro = new ResizeObserver((es) => cb(es.map((e) => e.target)));
            return {
                observe: (el) => ro.observe(el),
                unobserve: (el) => ro.unobserve(el),
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
