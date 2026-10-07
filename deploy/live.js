/**
 * Generic host for live A0 programs (see docs/LIVE-PROGRAMS.md). A page asks for one with
 * data attributes on its root element:
 *
 *   data-live="/sentinel.wasm"   the program (an A0 io program exporting `frame`)
 *   data-live-in="2048"          input words it was built with (ioInputCapacity)
 *   data-live-out="16384"        output words (ioOutputCapacity)
 *   data-live-rows="96"         geometry rows it reads
 *
 * This module knows nothing about what the program draws. It runs one animation-frame loop,
 * feeds the program pointer, scroll, viewport, reduced-motion, visibility and frame-cost data
 * plus a cached table of page geometry, and paints the draw list it returns on a fixed overlay
 * canvas that is aria-hidden and takes no pointer events. The loop stops while the page is
 * hidden; with prefers-reduced-motion it runs only to draw (once, and on resize).
 */
import { Surface } from './live/canvas.js';
import { browserGeoEnv, GeometryRegistry } from './live/geometry.js';
import { PointerTracker } from './live/pointer.js';
import { LiveProgram } from './live/program.js';
import { FLAG, POINTER_TYPE } from './live/words.js';
async function load(url) {
    let instance;
    try {
        ({ instance } = await WebAssembly.instantiateStreaming(await fetch(url), {}));
    }
    catch {
        // a server that does not send application/wasm: instantiate from bytes
        const bytes = await (await fetch(url)).arrayBuffer();
        ({ instance } = await WebAssembly.instantiate(bytes, {}));
    }
    return instance.exports;
}
/** Mount the live program a page asked for, if any. Failures leave the page as it was. */
export async function mountLive(root, config = root.dataset) {
    const url = config.live;
    if (url === undefined || url === '')
        return undefined;
    const inputWords = Number(config.liveIn ?? '2048');
    const outputWords = Number(config.liveOut ?? '16384');
    const rows = Number(config.liveRows ?? '96');
    let exp;
    try {
        exp = await load(url);
    }
    catch {
        return undefined;
    }
    const program = new LiveProgram(exp, { inputWords, outputWords, rows });
    const win = window;
    const doc = document;
    const surface = new Surface(doc, 15);
    doc.body.appendChild(surface.canvas);
    const geometry = new GeometryRegistry(browserGeoEnv(win, root), { max: rows });
    let sx = win.scrollX;
    let sy = win.scrollY;
    let vw = win.innerWidth;
    let vh = win.innerHeight;
    const pointer = new PointerTracker(win, doc.documentElement, () => [sx, sy]);
    pointer.attach();
    const onScroll = () => {
        sx = win.scrollX;
        sy = win.scrollY;
    };
    win.addEventListener('scroll', onScroll, { passive: true });
    const reducedQuery = win.matchMedia('(prefers-reduced-motion: reduce)');
    const coarseQuery = win.matchMedia('(pointer: coarse)');
    let percent = 100;
    const dprNow = () => win.devicePixelRatio || 1;
    const fit = () => {
        surface.resize({ cssWidth: vw, cssHeight: vh, dpr: dprNow(), percent }, percent > 70);
    };
    fit();
    let raf = 0;
    let running = false;
    let first = true;
    let resumed = false;
    let lastNow = 0;
    let carry = 0;
    let costEma = 1;
    let intervalEma = 16.7;
    let quality;
    let frames = 0;
    const ring = new Float32Array(120);
    let ringAt = 0;
    let costMax = 0;
    let lastGeneration = -1;
    const frame = (now) => {
        raf = 0;
        const t0 = performance.now();
        let dt = lastNow === 0 ? 16 : now - lastNow;
        if (resumed)
            dt = 16;
        if (dt > 50)
            dt = 16.7;
        lastNow = now;
        if (!first && !resumed)
            intervalEma += (Math.min(dt, 100) - intervalEma) * 0.1;
        const dtInt = Math.max(1, Math.round(dt + carry));
        carry = dt + carry - dtInt;
        carry = Math.max(-1, Math.min(1, carry));
        geometry.update(now);
        const snap = pointer.snapshot();
        const reduced = reducedQuery.matches;
        let flags = 0;
        if (reduced)
            flags |= FLAG.reduced;
        if (coarseQuery.matches)
            flags |= FLAG.coarse;
        if (snap.present && snap.type !== POINTER_TYPE.none)
            flags |= FLAG.pointer;
        if (snap.down)
            flags |= FLAG.down;
        if (geometry.generation !== lastGeneration)
            flags |= FLAG.geometry;
        if (first)
            flags |= FLAG.first;
        if (resumed)
            flags |= FLAG.resumed;
        if (snap.cancelled)
            flags |= FLAG.cancel;
        lastGeneration = geometry.generation;
        const input = {
            dt: dtInt,
            flags,
            vw,
            vh,
            scrollX: sx,
            scrollY: sy,
            dpr: dprNow(),
            pointerX: snap.x,
            pointerY: snap.y,
            pointerType: snap.type,
            tapSeq: snap.tapSeq,
            tapX: snap.tapX,
            tapY: snap.tapY,
            tapRect: snap.tapRect,
            costUs: costEma * 1000,
            intervalUs: intervalEma * 1000,
            docHeight: geometry.docHeight,
            timeMs: Math.floor(now),
            generation: geometry.generation,
        };
        first = false;
        resumed = false;
        const res = program.frame(input, geometry.table, geometry.count);
        for (const w of res.watches)
            geometry.watch(w.kind, w.selector);
        if (res.quality !== undefined && res.quality !== percent) {
            percent = Math.max(25, Math.min(100, res.quality));
            quality = res.quality;
            fit();
        }
        surface.paint(program.words, res.drawFrom, res.drawTo);
        const cost = performance.now() - t0;
        frames += 1;
        costEma += (cost - costEma) * 0.08;
        costMax = Math.max(costMax, cost);
        ring[ringAt % ring.length] = cost;
        ringAt += 1;
        // keep the loop going only while running and motion is allowed
        if (running && !reduced)
            raf = requestAnimationFrame(frame);
    };
    const start = () => {
        if (running || doc.hidden)
            return;
        running = true;
        if (!reducedQuery.matches)
            raf = requestAnimationFrame(frame);
        else
            requestDraw();
    };
    const halt = () => {
        running = false;
        if (raf !== 0)
            cancelAnimationFrame(raf);
        raf = 0;
    };
    /** Reduced motion: one frame to paint, not a loop. */
    const requestDraw = () => {
        if (raf !== 0)
            return;
        raf = requestAnimationFrame(frame);
    };
    const onVisibility = () => {
        if (doc.hidden)
            halt();
        else {
            resumed = true;
            lastNow = 0;
            start();
        }
    };
    let resizeTimer = 0;
    const onResize = () => {
        vw = win.innerWidth;
        vh = win.innerHeight;
        fit();
        if (reducedQuery.matches) {
            win.clearTimeout(resizeTimer);
            resizeTimer = win.setTimeout(requestDraw, 150);
        }
    };
    const onMotion = () => {
        halt();
        surface.clearAll();
        first = true;
        start();
    };
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('resize', onResize, { passive: true });
    reducedQuery.addEventListener('change', onMotion);
    geometry.start();
    start();
    const handle = {
        stop: () => {
            halt();
            geometry.stop();
            pointer.detach();
            win.removeEventListener('scroll', onScroll);
            win.removeEventListener('resize', onResize);
            doc.removeEventListener('visibilitychange', onVisibility);
            reducedQuery.removeEventListener('change', onMotion);
            surface.canvas.remove();
        },
        stats: () => {
            const n = Math.min(ringAt, ring.length);
            const sorted = Array.from(ring.subarray(0, n)).sort((a, b) => a - b);
            return {
                frames,
                running,
                costAvgMs: costEma,
                costP95Ms: sorted[Math.max(0, Math.floor(n * 0.95) - 1)] ?? 0,
                costMaxMs: costMax,
                intervalAvgMs: intervalEma,
                quality,
                rows: geometry.count,
                generation: geometry.generation,
                scans: geometry.stats.scans,
                measures: geometry.stats.measures,
                rebuilds: geometry.stats.rebuilds,
            };
        },
    };
    window.a0Live = handle;
    return handle;
}
