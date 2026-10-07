/**
 * Unified pointer input for live programs: mouse, pen and touch through Pointer Events, as
 * data. Every listener is passive; nothing here calls preventDefault, captures a pointer, or
 * changes the page, so scrolling, selection, focus and links behave exactly as without it.
 * Positions are CSS pixels in the viewport. A tap is a short press without travel; the host
 * reports the interactive element under it (the first ancestor that is a link, button, form
 * control, summary or has a tabindex or button role), measured once at the tap, so a program can
 * react to it visually without ever handling it.
 */
import { POINTER_TYPE } from './words.js';
const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role="button"],[tabindex]';
function typeCode(t) {
    if (t === 'touch')
        return POINTER_TYPE.touch;
    if (t === 'pen')
        return POINTER_TYPE.pen;
    return POINTER_TYPE.mouse;
}
/** Tracks the primary pointer. Create, `attach`, read `snapshot()` once per frame, `detach`. */
export class PointerTracker {
    win;
    doc;
    scroll;
    x = 0;
    y = 0;
    type = POINTER_TYPE.none;
    present = false;
    down = false;
    cancelled = false;
    tapSeq = 0;
    tapX = 0;
    tapY = 0;
    tapRect = null;
    downX = 0;
    downY = 0;
    downAt = 0;
    moved = false;
    listeners = [];
    constructor(win, doc, scroll) {
        this.win = win;
        this.doc = doc;
        this.scroll = scroll;
    }
    attach() {
        const on = (host, type, fn) => {
            host.addEventListener(type, fn, { passive: true });
            this.listeners.push([type, fn]);
        };
        on(this.win, 'pointermove', ((ev) => this.onMove(ev)));
        on(this.win, 'pointerdown', ((ev) => this.onDown(ev)));
        on(this.win, 'pointerup', ((ev) => this.onUp(ev)));
        on(this.win, 'pointercancel', ((ev) => this.onCancel(ev)));
        on(this.doc, 'pointerleave', ((ev) => this.onLeave(ev)));
    }
    detach() {
        for (const [type, fn] of this.listeners) {
            this.win.removeEventListener(type, fn);
            this.doc.removeEventListener(type, fn);
        }
        this.listeners.length = 0;
    }
    place(ev) {
        if (ev.isPrimary === false)
            return;
        this.x = ev.clientX;
        this.y = ev.clientY;
        this.type = typeCode(ev.pointerType);
        this.present = true;
    }
    onMove(ev) {
        if (ev.isPrimary === false)
            return;
        this.place(ev);
        if (this.down && Math.hypot(ev.clientX - this.downX, ev.clientY - this.downY) > 10)
            this.moved = true;
    }
    onDown(ev) {
        if (ev.isPrimary === false)
            return;
        this.place(ev);
        this.down = true;
        this.moved = false;
        this.downX = ev.clientX;
        this.downY = ev.clientY;
        this.downAt = ev.timeStamp ?? 0;
    }
    onUp(ev) {
        if (ev.isPrimary === false)
            return;
        this.place(ev);
        const quick = (ev.timeStamp ?? 0) - this.downAt < 500;
        if (this.down && !this.moved && quick)
            this.tap(ev);
        this.down = false;
    }
    onCancel(ev) {
        if (ev.isPrimary === false)
            return;
        // The browser takes a touch gesture over for scrolling and cancels the pointer.
        this.down = false;
        this.cancelled = true;
    }
    onLeave(ev) {
        if (typeCode(ev.pointerType) === POINTER_TYPE.mouse)
            this.present = false;
    }
    tap(ev) {
        this.tapSeq = (this.tapSeq + 1) >>> 0;
        this.tapX = ev.clientX;
        this.tapY = ev.clientY;
        this.tapRect = null;
        const target = ev.target;
        const el = target?.closest?.(INTERACTIVE);
        if (el) {
            const r = el.getBoundingClientRect();
            const [sx, sy] = this.scroll();
            this.tapRect = [
                Math.round(r.left + sx),
                Math.round(r.top + sy),
                Math.round(r.right + sx),
                Math.round(r.bottom + sy),
            ];
        }
    }
    /** The state for this frame. `cancelled` is reported once. */
    snapshot() {
        const s = {
            x: this.x,
            y: this.y,
            type: this.type,
            present: this.present,
            down: this.down,
            cancelled: this.cancelled,
            tapSeq: this.tapSeq,
            tapX: this.tapX,
            tapY: this.tapY,
            tapRect: this.tapRect,
        };
        this.cancelled = false;
        return s;
    }
}
