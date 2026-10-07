/**
 * The 2D drawing surface of a live program: an overlay canvas that never takes pointer events,
 * and the executor of the program's draw list. Coordinates are CSS pixels (Q16.16 words); the
 * surface scales them to the canvas buffer. Each frame only the region the previous frame drew
 * in is cleared, so a small drawing over a large viewport stays cheap.
 */
import { COMMAND_WORDS, fromQ16, OP, rgbaCss } from './words.js';
export function emptyBounds() {
    return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}
function grow(b, x, y, r) {
    if (x - r < b.x0)
        b.x0 = x - r;
    if (y - r < b.y0)
        b.y0 = y - r;
    if (x + r > b.x1)
        b.x1 = x + r;
    if (y + r > b.y1)
        b.y1 = y + r;
}
/**
 * Execute the draw commands in `words[from, to)` on `ctx` and grow `bounds` by what they touch.
 * An unknown opcode stops the walk (the stream is untrusted data, never an instruction), and a
 * count that would run past `to` is cut at `to`. Returns the number of commands executed.
 */
export function drawCommands(ctx, words, from, to, bounds, detail = true) {
    let i = from;
    let n = 0;
    const w = (k) => words[k];
    const q = (k) => fromQ16(w(k));
    while (i < to) {
        const op = w(i);
        if (op === OP.path) {
            const m = Math.min(w(i + 1), Math.max(0, Math.floor((to - i - 4) / 2)));
            ctx.beginPath();
            ctx.lineWidth = q(i + 2);
            ctx.strokeStyle = rgbaCss(w(i + 3));
            const pad = q(i + 2);
            for (let k = 0; k < m; k += 1) {
                const x = q(i + 4 + 2 * k);
                const y = q(i + 5 + 2 * k);
                if (k === 0)
                    ctx.moveTo(x, y);
                else
                    ctx.lineTo(x, y);
                grow(bounds, x, y, pad);
            }
            ctx.stroke();
            i += 4 + 2 * m;
            n += 1;
            continue;
        }
        const len = COMMAND_WORDS[op];
        if (len === undefined || i + len > to)
            break;
        switch (op) {
            case OP.clear:
                break;
            case OP.line: {
                const x1 = q(i + 1);
                const y1 = q(i + 2);
                const x2 = q(i + 3);
                const y2 = q(i + 4);
                const lw = q(i + 5);
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.lineWidth = lw;
                ctx.strokeStyle = rgbaCss(w(i + 6));
                ctx.stroke();
                grow(bounds, x1, y1, lw);
                grow(bounds, x2, y2, lw);
                break;
            }
            case OP.disc: {
                const x = q(i + 1);
                const y = q(i + 2);
                const r = q(i + 3);
                ctx.beginPath();
                ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
                ctx.fillStyle = rgbaCss(w(i + 4));
                ctx.fill();
                grow(bounds, x, y, r + 1);
                break;
            }
            case OP.ring: {
                const x = q(i + 1);
                const y = q(i + 2);
                const r = q(i + 3);
                const lw = q(i + 4);
                ctx.beginPath();
                ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
                ctx.lineWidth = lw;
                ctx.strokeStyle = rgbaCss(w(i + 5));
                ctx.stroke();
                grow(bounds, x, y, r + lw);
                break;
            }
            case OP.glow: {
                const x = q(i + 1);
                const y = q(i + 2);
                const r = Math.max(0.5, q(i + 3));
                const c = w(i + 4);
                if (detail) {
                    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
                    g.addColorStop(0, rgbaCss(c));
                    g.addColorStop(1, rgbaCss(c & 0xffffff00));
                    ctx.fillStyle = g;
                }
                else
                    ctx.fillStyle = rgbaCss((c & 0xffffff00) | ((c & 255) >> 1));
                ctx.beginPath();
                ctx.arc(x, y, detail ? r : r * 0.5, 0, Math.PI * 2);
                ctx.fill();
                grow(bounds, x, y, r + 1);
                break;
            }
            case OP.sphere: {
                const x = q(i + 1);
                const y = q(i + 2);
                const r = Math.max(0.5, q(i + 3));
                if (detail) {
                    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r);
                    g.addColorStop(0, rgbaCss(w(i + 4)));
                    g.addColorStop(1, rgbaCss(w(i + 5)));
                    ctx.fillStyle = g;
                }
                else
                    ctx.fillStyle = rgbaCss(w(i + 5));
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
                grow(bounds, x, y, r + 1);
                break;
            }
            case OP.quad: {
                // a filled four-point polygon (repeat a point for a triangle): tapered limb segments, claws, plates
                ctx.beginPath();
                for (let k = 0; k < 4; k += 1) {
                    const x = q(i + 1 + 2 * k);
                    const y = q(i + 2 + 2 * k);
                    if (k === 0)
                        ctx.moveTo(x, y);
                    else
                        ctx.lineTo(x, y);
                    grow(bounds, x, y, 1);
                }
                ctx.closePath();
                ctx.fillStyle = rgbaCss(w(i + 9));
                ctx.fill();
                break;
            }
            case OP.brackets: {
                const x0 = q(i + 1);
                const y0 = q(i + 2);
                const x1 = q(i + 3);
                const y1 = q(i + 4);
                const l = Math.min(q(i + 5), (x1 - x0) / 2, (y1 - y0) / 2);
                ctx.beginPath();
                for (const [cx, cy, sx, sy] of [
                    [x0, y0, 1, 1],
                    [x1, y0, -1, 1],
                    [x0, y1, 1, -1],
                    [x1, y1, -1, -1],
                ]) {
                    ctx.moveTo(cx + sx * l, cy);
                    ctx.lineTo(cx, cy);
                    ctx.lineTo(cx, cy + sy * l);
                }
                ctx.lineWidth = q(i + 6);
                ctx.strokeStyle = rgbaCss(w(i + 7));
                ctx.stroke();
                grow(bounds, x0, y0, 2);
                grow(bounds, x1, y1, 2);
                break;
            }
            default:
                break;
        }
        i += len;
        n += 1;
    }
    return n;
}
/** Buffer size and context scale for a surface size: dpr capped at `dprCap`, at most `maxPixels`. */
export function bufferFor(size, dprCap = 2, maxPixels = 6_000_000) {
    let scale = Math.min(size.dpr, dprCap) * (size.percent / 100);
    const px = size.cssWidth * size.cssHeight * scale * scale;
    if (px > maxPixels)
        scale *= Math.sqrt(maxPixels / px);
    scale = Math.max(0.25, scale);
    return {
        width: Math.max(1, Math.round(size.cssWidth * scale)),
        height: Math.max(1, Math.round(size.cssHeight * scale)),
        scale,
    };
}
/** The overlay canvas element and its context. */
export class Surface {
    canvas;
    ctx;
    bounds = emptyBounds();
    scale = 1;
    detail = true;
    constructor(doc, zIndex) {
        this.canvas = doc.createElement('canvas');
        this.canvas.setAttribute('aria-hidden', 'true');
        this.canvas.setAttribute('role', 'presentation');
        const s = this.canvas.style;
        s.position = 'fixed';
        s.left = '0';
        s.top = '0';
        s.width = '100%';
        s.height = '100%';
        s.pointerEvents = 'none';
        s.zIndex = String(zIndex);
        s.contain = 'strict';
        const ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
        if (ctx === null)
            throw new Error('2d canvas unavailable');
        this.ctx = ctx;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
    }
    /** Resize the buffer for `size`; returns true when the buffer changed. */
    resize(size, detail) {
        this.detail = detail;
        const b = bufferFor(size);
        this.scale = b.scale;
        if (this.canvas.width === b.width && this.canvas.height === b.height)
            return false;
        this.canvas.width = b.width;
        this.canvas.height = b.height;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.bounds = { x0: 0, y0: 0, x1: size.cssWidth, y1: size.cssHeight };
        return true;
    }
    /** Clear what the last frame drew and execute this frame's draw list. */
    paint(words, from, to) {
        const ctx = this.ctx;
        ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
        const b = this.bounds;
        if (b.x1 >= b.x0) {
            const pad = 3;
            ctx.clearRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad);
        }
        this.bounds = emptyBounds();
        return drawCommands(ctx, words, from, to, this.bounds, this.detail);
    }
    /** Clear everything (used when the program is paused or removed). */
    clearAll() {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.bounds = emptyBounds();
    }
}
