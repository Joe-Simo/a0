/** CLI graph loading with an injected source graph and the ordinary filesystem protection guard. */
import type { TypedProgram } from './core.js';
import type { ProjectLinkOptions, ReadSource } from './linker.js';
import { readBytes, readFile } from './node-fs.js';
import { protectionPolicy } from './protection-policy.js';
import type { SourceGraphLoader, sourceDiagnostic } from './source-graph.js';

/** Explicit native callers use fatal decoding; public historical routes supply their existing reader. */
export async function readUtf8Source(path: string): Promise<string> {
  const bytes = await readBytes(path);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

export async function loadCliProgram(
  path: string,
  load: SourceGraphLoader,
  options: ProjectLinkOptions = {},
  read: ReadSource = readUtf8Source,
): Promise<TypedProgram> {
  return (
    await load(
      path,
      (source) => {
        protectionPolicy(source);
        return read(source);
      },
      options,
    )
  ).program;
}

/** CLI JSON uses the renderer's physical source line; its diagnostic fields stay unchanged. */
export async function cliCheckDiagnostic(
  path: string,
  diagnostic: NonNullable<Awaited<ReturnType<typeof sourceDiagnostic>>>,
  read: ReadSource = (file) => readFile(file, 'utf8'),
) {
  let line = diagnostic.line ?? null;
  if (!diagnostic.native) {
    const source = await read(path).catch(() => '');
    const { diagnosticLine } = await import('./fix.js');
    line = diagnosticLine(source, diagnostic.error) ?? line;
  }
  return { ...diagnostic.error.toJSON(), line };
}
