/** Validated selections for the execution benchmark; no work starts on invalid input. */
export interface BenchmarkOptions {
  readonly langs: ReadonlySet<string> | null;
  readonly kernels: ReadonlySet<string> | null;
  readonly samples: number;
  readonly scale: number;
  readonly out: string;
  readonly help: boolean;
}

export function parseBenchmarkOptions(
  argv: readonly string[],
  known: {
    readonly languages: readonly string[];
    readonly kernels: readonly string[];
    readonly defaultOut: string;
  },
): BenchmarkOptions {
  let langs: Set<string> | null = null;
  let kernels: Set<string> | null = null;
  let samples = 7;
  let scale = 1;
  let out = known.defaultOut;
  const result = (help = false): BenchmarkOptions => ({
    langs,
    kernels,
    samples,
    scale,
    out,
    help,
  });
  const select = (
    value: string,
    allowed: readonly string[],
    label: string,
    empty: boolean,
  ): Set<string> => {
    if (value === '' && empty) return new Set();
    const names = value.split(',');
    for (const name of names)
      if (!allowed.includes(name))
        throw new Error(`${label}: unknown or empty selection ${JSON.stringify(name)}`);
    return new Set(names);
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return result(true);
    const split = arg.indexOf('=');
    const key = split < 0 ? arg : arg.slice(0, split);
    if (!['--langs', '--kernels', '--samples', '--scale', '--out'].includes(key))
      throw new Error(`unknown option ${key} (see --help)`);
    if (split < 0) throw new Error(`${key} requires a value after =`);
    const value = arg.slice(split + 1);
    if (key === '--langs') langs = select(value, known.languages, key, true);
    else if (key === '--kernels') kernels = select(value, known.kernels, key, false);
    else if (key === '--samples') {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1)
        throw new Error('--samples must be a positive safe integer');
      samples = number;
    } else if (key === '--scale') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 1)
        throw new Error('--scale must be finite and at least 1');
      scale = number;
    } else {
      if (value.trim().length === 0) throw new Error('--out must not be empty');
      out = value;
    }
  }
  return result();
}
