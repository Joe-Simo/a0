export interface CaseOptions {
  readonly length?: number;
  readonly mode?: number;
  readonly code?: number;
  readonly padding?: number;
  readonly badHandle?: number;
  readonly noGrowth?: boolean;
  readonly extraBudget?: number;
  readonly lifecycle?: number;
  readonly slot?: number;
  readonly forgedLength?: number;
  readonly appendCount?: number;
  readonly fault?: {
    readonly op: number;
    readonly nth: number;
    readonly status?: number;
    readonly kind: number;
  };
  readonly unit?: {
    readonly bytes: readonly number[];
    readonly consumed: number;
    readonly units: number;
    readonly kind: number;
  };
}
export interface DecoderCase {
  readonly label: string;
  readonly raw: Uint32Array;
  readonly options: CaseOptions;
}
export function makeCases(): DecoderCase[];
