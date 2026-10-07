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
import { H, HEADER_WORDS, parseHostCommands, ROW_WORDS, toQ16 } from './words.js';
export class LiveProgram {
    shape;
    words;
    inWords;
    outBase;
    stateBase;
    base;
    stateLength = 0;
    lastGeneration = -1;
    exp;
    /** Words the table rows span. */
    tableWords;
    constructor(exp, shape) {
        this.shape = shape;
        this.exp = exp;
        this.base = exp.__heap_base.value;
        const total = shape.inputWords + 2 + shape.outputWords + 1;
        const needed = this.base + total * 4;
        if (exp.memory.buffer.byteLength < needed)
            exp.memory.grow(Math.ceil((needed - exp.memory.buffer.byteLength) / 65536));
        this.words = new Uint32Array(exp.memory.buffer, this.base, total);
        this.inWords = shape.inputWords;
        this.outBase = shape.inputWords + 2;
        this.tableWords = shape.rows * ROW_WORDS;
        this.stateBase = HEADER_WORDS + this.tableWords + 1;
        if (this.stateBase >= shape.inputWords)
            throw new Error('live program: input block too small');
    }
    /** Run one frame. `table` holds `count` rows; it is copied only when `generation` changed. */
    frame(inp, table, count) {
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
        for (let k = 0; k < 4; k += 1)
            w[H.tapRect + k] = r === null ? 0 : r[k] >>> 0;
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
        const n = Math.min(w[this.outBase + this.shape.outputWords], this.shape.outputWords);
        const out = w.subarray(this.outBase, this.outBase + n);
        const host = parseHostCommands(out, n);
        if (host.stateLength > 0 && host.stateStart + host.stateLength <= n) {
            const len = Math.min(host.stateLength, this.inWords - this.stateBase);
            w.copyWithin(this.stateBase, this.outBase + host.stateStart, this.outBase + host.stateStart + len);
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
    stateWords() {
        return this.words.slice(this.stateBase, this.stateBase + this.stateLength);
    }
}
/** Instantiate a live program from wasm bytes. */
export async function instantiateProgram(bytes, shape) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new LiveProgram(instance.exports, shape);
}
