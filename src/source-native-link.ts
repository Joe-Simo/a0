/** Candidate native source reader using the existing dependency and storage policy. */
import type { Program } from './core.js';
import { type Linked, linkProject, type ProjectLinkOptions, type ReadSource } from './linker.js';
import type { NativeSourceResult, NativeUnitResult, nativeSource } from './source-native.js';

type Frontend = ReturnType<typeof nativeSource>;
type Failure = Extract<NativeSourceResult, { readonly ok: false }>;

/** Raw authoritative failure facts; full catalog wording/edit integration remains a cutover gate. */
export class NativeSourceError extends Error {
  readonly status: number;
  readonly diagnostic: number;
  constructor(
    readonly result: Failure,
    readonly path?: string,
    readonly line?: number,
  ) {
    const diagnostic = result.state[1] ?? 0;
    const id = diagnostic ? `A${String(diagnostic).padStart(4, '0')}` : 'native frontend';
    super(
      `${path === undefined ? '' : `${path}${line ? `:${line}` : ''}: `}${id}: status ${result.status}`,
    );
    this.name = 'NativeSourceError';
    this.status = result.status;
    this.diagnostic = diagnostic;
  }
}

export function linkNativeSource(
  entry: string,
  read: ReadSource,
  frontend: Frontend,
  options: ProjectLinkOptions = {},
): Promise<Linked> {
  const units = new WeakMap<Program, { unit: NativeUnitResult; path: string }>();
  return linkProject(
    entry,
    read,
    {
      acceptsPath: (path) => path.endsWith('.a0'),
      prepare(text, path) {
        const unit = frontend.parseUnit(text);
        if (!unit.ok) throw new NativeSourceError(unit, path, unit.state[2] || undefined);
        units.set(unit.program, { unit, path });
        return {
          uses: unit.program.uses ?? [],
          async complete() {
            return { program: unit.program, text };
          },
        };
      },
      check(programs, profile) {
        const ordered = programs.map((program) => {
          const source = units.get(program);
          if (source === undefined) throw new Error('native source unit was not retained');
          return source;
        });
        const result = frontend.checkUnits(
          ordered.map((source) => source.unit),
          profile,
        );
        if (!result.ok) {
          const line = result.state[2] ?? 0;
          const index = result.origins.findIndex(
            (origin) => line >= origin.firstLine && line < origin.firstLine + origin.lineCount,
          );
          const origin = result.origins[index];
          throw new NativeSourceError(
            result,
            ordered[index]?.path,
            origin === undefined ? undefined : line - origin.firstLine + 1,
          );
        }
        return { ...result.program, ...result.typed };
      },
    },
    options,
  );
}
