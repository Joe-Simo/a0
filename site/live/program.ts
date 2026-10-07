/**
 * One live A0 program in memory: the wasm instance, the io buffers and the per-frame exchange.
 * The host writes a header and the geometry table, hands back the state the program returned
 * last frame, calls `a0_frame`, and reads the program's host commands (STATE, WATCH, QUALITY)
 * and its draw list. No DOM access here, so the tests drive it with the real compiled program.
 *
 * Layout of the input words: header (32), geometry table (rows x 7), the state count, the state.
 * The io struct is the one every A0 wasm module uses: input[IN], ninput, position, output[OUT],
 * noutput, placed at `__heap_base`.
 */

import { H, HEADER_WORDS, parseHostCommands, ROW_WORDS, toQ16, type Watch } from './words.js';

export interface LiveExports {
  readonly memory: WebAssembly.Memory;
  readonly __heap_base: WebAssembly.Global;
  readonly a0_frame: (io: number) => number;
}

export interface ProgramShape {
  /** Capacity of the input block in words (the `ioInputCapacity` the program was built with). */
  readonly inputWords: number;
  /** Capacity of the output block in words. */
  readonly outputWords: number;
  /** Geometry rows the program reads (fixed by the program's reader). */
  readonly rows: number;
}

/** What the host knows at one frame. */
export interface FrameInput {
  dt: number;
  flags: number;
  vw: number;
  vh: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
  pointerX: number;
  pointerY: number;
  pointerType: number;
  tapSeq: number;
  tapX: number;
  tapY: number;
  tapRect: readonly [number, number, number, number] | null;
  costUs: number;
  intervalUs: number;
  docHeight: number;
  timeMs: number;
  generation: number;
}

export interface FrameResult {
  /** Offsets into `words` (the whole io block) of the draw list. */
  drawFrom: number;
  drawTo: number;
  watches: Watch[];
  quality: number | undefined;
  cadence: number | undefined;
  /** The program's own return value. */
  code: number;
  /** Words of output written. */
  outputLength: number;
}

export class LiveProgram {
  readonly words: Uint32Array;
  private readonly inWords: number;
  private readonly outBase: number;
  private readonly stateBase: number;
  private readonly base: number;
  private stateLength = 0;
  private lastGeneration = -1;
  private readonly exp: LiveExports;
  /** Words the table rows span. */
  private readonly tableWords: number;

  constructor(
    exp: LiveExports,
    private readonly shape: ProgramShape,
  ) {
    this.exp = exp;
    this.base = exp.__heap_base.value as number;
    const total = shape.inputWords + 2 + shape.outputWords + 1;
    const needed = this.base + total * 4;
    if (exp.memory.buffer.byteLength < needed)
      exp.memory.grow(Math.ceil((needed - exp.memory.buffer.byteLength) / 65536));
    this.words = new Uint32Array(exp.memory.buffer, this.base, total);
    this.inWords = shape.inputWords;
    this.outBase = shape.inputWords + 2;
    this.tableWords = shape.rows * ROW_WORDS;
    this.stateBase = HEADER_WORDS + this.tableWords + 1;
    if (this.stateBase >= shape.inputWords) throw new Error('live program: input block too small');
  }

  /** Run one frame. `table` holds `count` rows; it is copied only when `generation` changed. */
  frame(inp: FrameInput, table: Uint32Array, count: number): FrameResult {
    const w = this.words;
    w[H.version] = 1;
    w[H.dt] = inp.dt >>> 0;
    w[H.flags] = inp.flags >>> 0;
    w[H.vw] = inp.vw >>> 0;
    w[H.vh] = inp.vh >>> 0;
    w[H.scrollX] = Math.round(inp.scrollX) >>> 0;
    w[H.scrollY] = Math.round(inp.scrollY) >>> 0;
    w[H.dpr] = Math.round(inp.dpr * 100) >>> 0;
    w[H.pointerX] = toQ16(inp.pointerX);
    w[H.pointerY] = toQ16(inp.pointerY);
    w[H.pointerType] = inp.pointerType >>> 0;
    w[H.tapSeq] = inp.tapSeq >>> 0;
    w[H.tapX] = toQ16(inp.tapX);
    w[H.tapY] = toQ16(inp.tapY);
    const r = inp.tapRect;
    for (let k = 0; k < 4; k += 1) w[H.tapRect + k] = r === null ? 0 : (r[k] as number) >>> 0;
    w[H.costUs] = Math.round(inp.costUs) >>> 0;
    w[H.intervalUs] = Math.round(inp.intervalUs) >>> 0;
    w[H.docHeight] = Math.round(inp.docHeight) >>> 0;
    w[H.rows] = count;
    w[H.timeMs] = inp.timeMs >>> 0;
    w[H.generation] = inp.generation >>> 0;
    if (inp.generation !== this.lastGeneration) {
      this.lastGeneration = inp.generation;
      const n = Math.min(this.tableWords, count * ROW_WORDS);
      w.set(table.subarray(0, n), HEADER_WORDS);
    }
    w[this.stateBase - 1] = this.stateLength;
    w[this.inWords] = this.stateBase + this.stateLength;
    w[this.inWords + 1] = 0; // read position
    w[this.outBase + this.shape.outputWords] = 0; // words written
    const code = this.exp.a0_frame(this.base) >>> 0;
    const n = Math.min(w[this.outBase + this.shape.outputWords] as number, this.shape.outputWords);
    const out = w.subarray(this.outBase, this.outBase + n);
    const host = parseHostCommands(out, n);
    if (host.stateLength > 0 && host.stateStart + host.stateLength <= n) {
      const len = Math.min(host.stateLength, this.inWords - this.stateBase);
      w.copyWithin(
        this.stateBase,
        this.outBase + host.stateStart,
        this.outBase + host.stateStart + len,
      );
      this.stateLength = len;
    }
    return {
      drawFrom: this.outBase + host.drawStart,
      drawTo: this.outBase + n,
      watches: host.watches,
      quality: host.quality,
      cadence: host.cadence,
      code,
      outputLength: n,
    };
  }

  /** The state words the program handed back last frame (a copy, for the tests). */
  stateWords(): Uint32Array {
    return this.words.slice(this.stateBase, this.stateBase + this.stateLength);
  }
}

/** Instantiate a live program from wasm bytes. */
export async function instantiateProgram(
  bytes: BufferSource,
  shape: ProgramShape,
): Promise<LiveProgram> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return new LiveProgram(instance.exports as unknown as LiveExports, shape);
}
