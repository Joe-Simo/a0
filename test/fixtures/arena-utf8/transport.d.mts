import type { DecoderCase } from './cases.mjs';
export interface ReplyChecks {
  readonly outputSHA256: string;
  readonly copiedRelations: number;
  readonly replacementRelations: number;
  readonly relationRows: number;
}
export function runCase(
  exe: string,
  dir: string,
  item: DecoderCase,
  index: number,
): Promise<ReplyChecks>;
