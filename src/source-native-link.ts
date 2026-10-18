/** Candidate native source reader using the existing dependency and storage policy. */
import type { Program } from './core.js';
import type { A0Error } from './diagnostics.js';
import { type Linked, linkProject, type ProjectLinkOptions, type ReadSource } from './linker.js';
import type { NativeSourceResult, NativeUnitResult, nativeSource } from './source-native.js';
import { type NativeDiagnosticOrigin, nativeDiagnostic } from './source-native-diagnostic.js';
import type { NativeLiveDiagnostic } from './source-native-render.js';

type Frontend = ReturnType<typeof nativeSource>;
type Failure = Extract<NativeSourceResult, { readonly ok: false }>;

/** Raw failure facts plus the existing A0 renderer's complete diagnostic, when supported. */
export class NativeSourceError extends Error {
  readonly status: number;
  readonly diagnostic: number;
  readonly a0Error: A0Error | undefined;
  readonly rendered: NativeLiveDiagnostic['rendered'] | undefined;
  constructor(
    readonly result: Failure,
    readonly path?: string,
    readonly line?: number,
    origins: readonly NativeDiagnosticOrigin[] = [],
  ) {
    const diagnostic = result.state[1] ?? 0;
    const id = diagnostic ? `A${String(diagnostic).padStart(4, '0')}` : 'native frontend';
    const snapshot = result.diagnostic;
    const rendered =
      snapshot !== undefined && 'packet' in snapshot
        ? nativeDiagnostic(snapshot.packet, origins)
        : snapshot?.rendered;
    super(
      rendered?.ok
        ? rendered.error.message
        : `${path === undefined ? '' : `${path}${line ? `:${line}` : ''}: `}${id}: status ${result.status}`,
    );
    this.name = 'NativeSourceError';
    this.status = result.status;
    this.diagnostic = diagnostic;
    this.rendered = rendered;
    this.a0Error = rendered?.ok ? rendered.error : undefined;
  }
}

export function linkNativeSource(
  entry: string,
  read: ReadSource,
  frontend: Frontend,
  options: ProjectLinkOptions = {},
): Promise<Linked> {
  const units = new WeakMap<Program, { unit: NativeUnitResult; path: string; text: string }>();
  return linkProject(
    entry,
    read,
    {
      acceptsPath: (path) => path.endsWith('.a0'),
      prepare(text, path) {
        const unit = frontend.parseUnit(text);
        if (!unit.ok)
          throw new NativeSourceError(unit, path, unit.state[2] || undefined, [
            {
              path,
              firstLine: 1,
              lineCount: text.split('\n').length,
              byteStart: 0,
              byteLength: new TextEncoder().encode(text).length,
              utf16Start: 0,
            },
          ]);
        units.set(unit.program, { unit, path, text });
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
          let utf16Start = 0;
          const diagnosticOrigins = result.origins.map((source, at) => {
            const owner = ordered[at];
            if (owner === undefined) throw new Error('missing native source origin');
            const mapped = { ...source, path: owner.path, utf16Start };
            utf16Start += owner.text.length + 1;
            return mapped;
          });
          throw new NativeSourceError(
            result,
            ordered[index]?.path,
            origin === undefined ? undefined : line - origin.firstLine + 1,
            diagnosticOrigins,
          );
        }
        return { ...result.program, ...result.typed };
      },
    },
    options,
  );
}
