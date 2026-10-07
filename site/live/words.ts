/**
 * The live-program word protocol (see site/lib/frame.a0 and docs/LIVE-PROGRAMS.md): the
 * header the host writes each frame, the geometry row layout, the output command codes, and
 * the fixed-point helpers. Pure: no DOM access, so the tests and the host share it.
 */

/** Words in the header block. */
export const HEADER_WORDS = 32;
/** Words in one geometry row: id x0 y0 x1 y1 (page CSS px) kind | in-viewport << 8. */
export const ROW_WORDS = 7;

/** Header word indices. */
export const H = {
  version: 0,
  dt: 1,
  flags: 2,
  vw: 3,
  vh: 4,
  scrollX: 5,
  scrollY: 6,
  dpr: 7,
  pointerX: 8,
  pointerY: 9,
  pointerType: 10,
  tapSeq: 11,
  tapX: 12,
  tapY: 13,
  tapRect: 14,
  costUs: 18,
  intervalUs: 19,
  docHeight: 20,
  rows: 21,
  timeMs: 22,
  generation: 23,
} as const;

/** Header flag bits. */
export const FLAG = {
  reduced: 1,
  coarse: 2,
  pointer: 4,
  down: 8,
  geometry: 16,
  first: 32,
  resumed: 64,
  cancel: 128,
} as const;

/** Pointer type codes (header word 10). */
export const POINTER_TYPE = { none: 0, mouse: 1, pen: 2, touch: 3 } as const;

/** Output command codes. */
export const OP = {
  state: 1,
  watch: 2,
  quality: 3,
  cadence: 4,
  clear: 10,
  line: 11,
  disc: 12,
  ring: 13,
  glow: 14,
  sphere: 15,
  path: 16,
  brackets: 17,
  quad: 18,
} as const;

/** Words of each fixed-size drawing command, opcode included (PATH is variable). */
export const COMMAND_WORDS: Readonly<Record<number, number>> = {
  [OP.clear]: 1,
  [OP.line]: 7,
  [OP.disc]: 5,
  [OP.ring]: 6,
  [OP.glow]: 5,
  [OP.sphere]: 6,
  [OP.brackets]: 8,
  [OP.quad]: 10,
};

/** A number as a signed Q16.16 word. */
export function toQ16(n: number): number {
  return Math.round(n * 65536) >>> 0;
}

/** A signed Q16.16 word as a number. */
export function fromQ16(w: number): number {
  return (w | 0) / 65536;
}

/** CSS color for a packed 0xRRGGBBAA word. */
export function rgbaCss(w: number): string {
  return `rgba(${w >>> 24},${(w >>> 16) & 255},${(w >>> 8) & 255},${((w & 255) / 255).toFixed(3)})`;
}

/** The same color with its alpha multiplied by `k` (a fade that preserves the color). */
export function rgbaCssFaded(w: number, k: number): string {
  return `rgba(${w >>> 24},${(w >>> 16) & 255},${(w >>> 8) & 255},${(((w & 255) / 255) * k).toFixed(3)})`;
}

/** A WATCH request decoded from the output stream. */
export interface Watch {
  readonly kind: number;
  readonly selector: string;
}

/** What the host takes from one frame's output besides drawing. */
export interface FrameOutput {
  /** Index of the first word after the STATE block that is not a host command (the draw list). */
  stateStart: number;
  stateLength: number;
  watches: Watch[];
  quality: number | undefined;
  /** Run the program every n-th animation frame (1 = every frame); undefined = unchanged. */
  cadence: number | undefined;
  /** Where the draw list starts in the output words. */
  drawStart: number;
}

const decoder = new TextDecoder();

/**
 * Walk the leading host commands (STATE, WATCH, QUALITY) of an output block and stop at the
 * first drawing command. The program writes them first, so the draw list is what remains.
 */
export function parseHostCommands(out: ArrayLike<number>, length: number): FrameOutput {
  const res: FrameOutput = {
    stateStart: 0,
    stateLength: 0,
    watches: [],
    quality: undefined,
    cadence: undefined,
    drawStart: 0,
  };
  let i = 0;
  while (i < length) {
    const op = out[i] as number;
    if (op === OP.state) {
      const n = Math.min(out[i + 1] as number, Math.max(0, length - i - 2));
      res.stateStart = i + 2;
      res.stateLength = n;
      i += 2 + n;
    } else if (op === OP.watch) {
      const kind = out[i + 1] as number;
      const n = Math.min(out[i + 2] as number, Math.max(0, length - i - 3));
      const bytes = new Uint8Array(n);
      for (let k = 0; k < n; k += 1) bytes[k] = (out[i + 3 + k] as number) & 0xff;
      res.watches.push({ kind, selector: decoder.decode(bytes) });
      i += 3 + n;
    } else if (op === OP.quality) {
      res.quality = out[i + 1] as number;
      i += 2;
    } else if (op === OP.cadence) {
      res.cadence = Math.max(1, Math.min(8, out[i + 1] as number));
      i += 2;
    } else break;
  }
  res.drawStart = i;
  return res;
}
