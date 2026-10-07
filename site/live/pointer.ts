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

/** What a program sees of the pointer at one frame. */
export interface PointerSnapshot {
  x: number;
  y: number;
  /** 0 none, 1 mouse, 2 pen, 3 touch. */
  type: number;
  /** A pointer position is known (and, for a mouse, it is inside the window). */
  present: boolean;
  down: boolean;
  /** The browser took the touch gesture (a scroll): true once, then cleared by `snapshot`. */
  cancelled: boolean;
  tapSeq: number;
  tapX: number;
  tapY: number;
  /** Page-space box of the tapped interactive element: x0 y0 x1 y1, or null. */
  tapRect: readonly [number, number, number, number] | null;
}

/** The event target surface the tracker needs (the tests pass a plain EventTarget). */
export interface PointerHost {
  addEventListener(type: string, listener: (ev: Event) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (ev: Event) => void): void;
}

interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerType?: string;
  readonly target?: unknown;
  readonly isPrimary?: boolean;
  readonly timeStamp?: number;
}

const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role="button"],[tabindex]';

function typeCode(t: string | undefined): number {
  if (t === 'touch') return POINTER_TYPE.touch;
  if (t === 'pen') return POINTER_TYPE.pen;
  return POINTER_TYPE.mouse;
}

/** Tracks the primary pointer. Create, `attach`, read `snapshot()` once per frame, `detach`. */
export class PointerTracker {
  private x = 0;
  private y = 0;
  private type: number = POINTER_TYPE.none;
  private present = false;
  private down = false;
  private cancelled = false;
  /** Counts every pointer event; a host that skips frames wakes when it changes. */
  activity = 0;
  private tapSeq = 0;
  private tapX = 0;
  private tapY = 0;
  private tapRect: readonly [number, number, number, number] | null = null;
  private downX = 0;
  private downY = 0;
  private downAt = 0;
  private moved = false;
  private readonly listeners: [string, (ev: Event) => void][] = [];

  constructor(
    private readonly win: PointerHost,
    private readonly doc: PointerHost,
    private readonly scroll: () => readonly [number, number],
  ) {}

  attach(): void {
    const on = (host: PointerHost, type: string, fn: (ev: Event) => void): void => {
      host.addEventListener(type, fn, { passive: true });
      this.listeners.push([type, fn]);
    };
    on(this.win, 'pointermove', ((ev: PointerLike) => this.onMove(ev)) as unknown as (ev: Event) => void);
    on(this.win, 'pointerdown', ((ev: PointerLike) => this.onDown(ev)) as unknown as (ev: Event) => void);
    on(this.win, 'pointerup', ((ev: PointerLike) => this.onUp(ev)) as unknown as (ev: Event) => void);
    on(this.win, 'pointercancel', ((ev: PointerLike) => this.onCancel(ev)) as unknown as (ev: Event) => void);
    on(this.doc, 'pointerleave', ((ev: PointerLike) => this.onLeave(ev)) as unknown as (ev: Event) => void);
  }

  detach(): void {
    for (const [type, fn] of this.listeners) {
      this.win.removeEventListener(type, fn);
      this.doc.removeEventListener(type, fn);
    }
    this.listeners.length = 0;
  }

  private place(ev: PointerLike): void {
    if (ev.isPrimary === false) return;
    this.x = ev.clientX;
    this.y = ev.clientY;
    this.type = typeCode(ev.pointerType);
    this.present = true;
  }

  private onMove(ev: PointerLike): void {
    if (ev.isPrimary === false) return;
    this.activity += 1;
    this.place(ev);
    if (this.down && Math.hypot(ev.clientX - this.downX, ev.clientY - this.downY) > 10)
      this.moved = true;
  }

  private onDown(ev: PointerLike): void {
    if (ev.isPrimary === false) return;
    this.activity += 1;
    this.place(ev);
    this.down = true;
    this.moved = false;
    this.downX = ev.clientX;
    this.downY = ev.clientY;
    this.downAt = ev.timeStamp ?? 0;
  }

  private onUp(ev: PointerLike): void {
    if (ev.isPrimary === false) return;
    this.activity += 1;
    this.place(ev);
    const quick = (ev.timeStamp ?? 0) - this.downAt < 500;
    if (this.down && !this.moved && quick) this.tap(ev);
    this.down = false;
  }

  private onCancel(ev: PointerLike): void {
    if (ev.isPrimary === false) return;
    // The browser takes a touch gesture over for scrolling and cancels the pointer.
    this.down = false;
    this.cancelled = true;
  }

  private onLeave(ev: PointerLike): void {
    if (typeCode(ev.pointerType) === POINTER_TYPE.mouse) this.present = false;
  }

  private tap(ev: PointerLike): void {
    this.tapSeq = (this.tapSeq + 1) >>> 0;
    this.tapX = ev.clientX;
    this.tapY = ev.clientY;
    this.tapRect = null;
    const target = ev.target as { closest?: (s: string) => unknown } | null | undefined;
    const el = target?.closest?.(INTERACTIVE) as
      | { getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } }
      | null
      | undefined;
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
  snapshot(): PointerSnapshot {
    const s: PointerSnapshot = {
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
