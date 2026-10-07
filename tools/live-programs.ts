/**
 * The live A0 programs of the site (programs run by the frame loop of site/live.ts rather than
 * rendered once like site/page.a0). One place gives each its source, its output name and the io
 * buffer sizes; tools/site-build.ts compiles from it and the tests check that the HTML shell
 * (data-live attributes) asks for the same sizes the program was built with.
 */

export interface LiveProgramSpec {
  /** Entry source under site/. */
  readonly entry: string;
  /** Output file: site/dist/<name>.wasm. */
  readonly name: string;
  /** ioInputCapacity: header 32 + geometry rows x 7 + state count 1 + state words, with room. */
  readonly inputWords: number;
  /** ioOutputCapacity: host commands, the state, and the draw list. */
  readonly outputWords: number;
  /** Geometry rows the program reads (a fixed table, see site/lib/frame.a0). */
  readonly rows: number;
}

export const LIVE_PROGRAMS: readonly LiveProgramSpec[] = [
  { entry: 'sentinel/main.a0', name: 'sentinel', inputWords: 4096, outputWords: 16384, rows: 192 },
];
