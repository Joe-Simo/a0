/** Storage-independent graph-loading ports; callers retain the frontend and storage ownership. */
import { A0Error } from './diagnostics.js';
import type { Linked, ProjectLinkOptions, ReadSource } from './linker.js';

export type SourceGraphLoader = (
  entry: string,
  read: ReadSource,
  options?: ProjectLinkOptions,
) => Promise<Linked>;

/** Dependency inventory parses source only; it does not accept or check a complete program. */
export interface SourceDependencyReader {
  acceptsPath(path: string): boolean;
  uses(bytes: Uint8Array, path: string): readonly string[];
  isSourceError(error: unknown): boolean;
}
export interface SourceGraphServices {
  readonly load?: SourceGraphLoader;
  readonly dependencies?: SourceDependencyReader;
}

/** Hydrate only an already-rendered native rejection; no source reader/checker is called here. */
export async function sourceDiagnostic(error: unknown) {
  if (error instanceof A0Error) return { error, native: false as const, line: error.line };
  const { NativeSourceError } = await import('./source-native-link.js');
  if (!(error instanceof NativeSourceError) || !error.rendered?.ok) return undefined;
  return {
    error: error.rendered.error,
    native: true as const,
    line: error.rendered.location.localLine ?? error.rendered.location.line ?? undefined,
  };
}
