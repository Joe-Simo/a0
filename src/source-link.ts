/** Candidate source frontend connected to the shared linker without text conversion. */
import { A0Error } from './core.js';
import {
  checkProgramUnits,
  type Linked,
  linkProject,
  type ProjectLinkOptions,
  type ReadSource,
} from './linker.js';
import { parseSourceUnit } from './source.js';

export function linkSource(
  entry: string,
  read: ReadSource,
  options: ProjectLinkOptions = {},
): Promise<Linked> {
  return linkProject(
    entry,
    read,
    {
      check: checkProgramUnits,
      acceptsPath: (path) => path.endsWith('.a0'),
      prepare(text, path) {
        try {
          const unit = parseSourceUnit(text);
          return {
            uses: unit.program.uses ?? [],
            async complete() {
              return { ...unit, text };
            },
          };
        } catch (e) {
          if (!(e instanceof A0Error) || e.line === undefined) throw e;
          throw e.rewrite(`${path}:${e.line}: ${e.detail}`);
        }
      },
    },
    options,
  );
}
