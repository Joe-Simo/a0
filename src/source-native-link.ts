/** Candidate native source reader using the existing dependency and storage policy. */
import type { Profile, Program } from './core.js';
import type { A0Error } from './diagnostics.js';
import { type Linked, linkProject, type ProjectLinkOptions, type ReadSource } from './linker.js';
import type {
  NativeGraphResult,
  NativeSourceResult,
  NativeUnitFormatActivation,
  NativeUnitResult,
  nativeSource,
} from './source-native.js';
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

/** A real successful A0 graph check; unit formatting never creates this capability. */
export type NativeCheckedGraph = Extract<NativeGraphResult, { readonly ok: true }>;
declare const PROJECT_FILE: unique symbol;
/** Project-owned file identity; neither a parsed nor a checked Program is exposed by this handle. */
export interface NativeProjectFile {
  readonly [PROJECT_FILE]: true;
  readonly path: string;
}
export interface NativeSourceProject {
  readonly files: readonly NativeProjectFile[];
  readonly profile: Profile;
  /** Authentic initial result; any later frontend reset makes this formatting input stale. */
  readonly graph: NativeCheckedGraph;
  /** Reset the shared frontend by checking the privately retained units, without rereading/parsing. */
  checkGraph(budget?: number): NativeCheckedGraph;
  /** Reset that frontend to an authentic file only for formatting/content revisions. */
  activateFileForFormat(file: NativeProjectFile, budget?: number): NativeUnitFormatActivation;
  /** Release project retention/handles. The injected frontend remains owned by its caller. */
  close(): void;
}
export interface NativeLinkedSource extends Linked {
  readonly native: NativeSourceProject;
}
interface OwnedUnit {
  readonly unit: Extract<NativeUnitResult, { readonly ok: true }>;
  readonly path: string;
  readonly text: string;
}

function checkGraph(
  frontend: Frontend,
  ordered: readonly OwnedUnit[],
  profile: Profile,
  budget?: number,
): NativeCheckedGraph {
  const result = frontend.checkUnits(
    ordered.map((source) => source.unit),
    profile,
    budget,
  );
  if (result.ok) return result;
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

function sourceProject(
  frontend: Frontend,
  units: readonly OwnedUnit[],
  profile: Profile,
  graph: NativeCheckedGraph,
): NativeSourceProject {
  let retained: readonly OwnedUnit[] | undefined = [...units];
  let owners = new WeakMap<NativeProjectFile, OwnedUnit>();
  const files = Object.freeze(
    units.map((unit) => {
      const file = Object.freeze({ path: unit.path }) as NativeProjectFile;
      owners.set(file, unit);
      return file;
    }),
  );
  const assertOpen = (): readonly OwnedUnit[] => {
    if (retained === undefined) throw new Error('native source project is closed');
    return retained;
  };
  return Object.freeze({
    files,
    profile,
    graph,
    checkGraph(budget?: number) {
      return checkGraph(frontend, assertOpen(), profile, budget);
    },
    activateFileForFormat(file: NativeProjectFile, budget?: number) {
      assertOpen();
      const owned = owners.get(file);
      if (owned === undefined)
        throw new Error('expected a file owned by this native source project');
      return frontend.activateUnitForFormat(owned.unit, budget);
    },
    close() {
      retained = undefined;
      owners = new WeakMap();
    },
  });
}

async function loadNativeSource(
  entry: string,
  read: ReadSource,
  frontend: Frontend,
  options: ProjectLinkOptions,
): Promise<{
  linked: Linked;
  checked: { units: readonly OwnedUnit[]; profile: Profile; result: NativeCheckedGraph };
}> {
  const units = new WeakMap<Program, OwnedUnit>();
  let checked:
    | { units: readonly OwnedUnit[]; profile: Profile; result: NativeCheckedGraph }
    | undefined;
  const linked = await linkProject(
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
        const result = checkGraph(frontend, ordered, profile);
        checked = { units: ordered, profile, result };
        return { ...result.program, ...result.typed };
      },
    },
    options,
  );
  if (checked === undefined) throw new Error('native project was not checked');
  return { linked, checked };
}

/** One-shot native linking; parsed-unit snapshots have no retained project owner after return. */
export async function linkNativeSource(
  entry: string,
  read: ReadSource,
  frontend: Frontend,
  options: ProjectLinkOptions = {},
): Promise<Linked> {
  const { linked } = await loadNativeSource(entry, read, frontend, options);
  return linked;
}

/** Explicitly retain authentic units for later file formatting and complete graph rechecks. */
export async function openNativeSourceProject(
  entry: string,
  read: ReadSource,
  frontend: Frontend,
  options: ProjectLinkOptions = {},
): Promise<NativeLinkedSource> {
  const { linked, checked } = await loadNativeSource(entry, read, frontend, options);
  return {
    ...linked,
    native: sourceProject(frontend, checked.units, checked.profile, checked.result),
  };
}
