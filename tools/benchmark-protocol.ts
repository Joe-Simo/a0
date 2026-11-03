/** Fail closed when a benchmark process does not produce a usable measurement. */
export interface BenchmarkMeasurement {
  readonly ns: number;
  readonly checksum: string;
}

export function validateBenchmarkMeasurement(ns: number, checksum: string): BenchmarkMeasurement {
  if (!Number.isFinite(ns) || ns <= 0)
    throw new Error('benchmark time must be finite and positive');
  if (!/^(0|[1-9][0-9]*)$/.test(checksum) || Number(checksum) > 0xffffffff)
    throw new Error('benchmark checksum must be a canonical u32');
  return { ns, checksum };
}

export function readBenchmarkMeasurement(text: string, allowNoise = false): BenchmarkMeasurement {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates = allowNoise
    ? lines.filter((line) => /^[+-]?(?:[0-9.]|Infinity|NaN)\S*\s+[+-]?[0-9]+$/.test(line))
    : lines;
  if (candidates.length !== 1) throw new Error('expected exactly one benchmark measurement');
  const fields = candidates[0]?.split(/\s+/) ?? [];
  if (
    fields.length !== 2 ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(fields[0] ?? '')
  )
    throw new Error('malformed benchmark measurement');
  return validateBenchmarkMeasurement(Number(fields[0]), fields[1] ?? '');
}

export function requireStableBenchmarkChecksum(
  actual: string,
  expected: string,
  label: string,
): void {
  if (actual !== expected)
    throw new Error(`${label}: checksum changed between samples (${actual} vs ${expected})`);
}
