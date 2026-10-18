/** Historical project import whose output is printed and checked only by the shared A0 frontend. */
import { dirname, resolve } from 'node:path';
import { type MigrationCodec, type MigrationManifest, migrateWithCodec } from './migrate.js';
import type { nativeSource } from './source-native.js';
import { linkNativeSource, NativeSourceError } from './source-native-link.js';

type Frontend = ReturnType<typeof nativeSource>;

/**
 * Import explicitly selected historical source into flat .a0 files in a new directory.
 * The caller owns the frontend and its optional formatter capability. Formatting synthetic
 * file IR does not accept a program; the staged dependency closure must pass the same A0 checker.
 */
export function migrateNativeSourceProject(
  entry: string,
  destination: string,
  frontend: Frontend,
  root = dirname(resolve(entry)),
  legacyDense = false,
): Promise<MigrationManifest> {
  const codec: MigrationCodec = {
    extension: '.a0',
    print(program) {
      const active = frontend.activateProgramForFormat(program);
      if (!active.ok)
        throw new Error(
          `native migration formatting activation refused: ${'reason' in active ? active.reason : active.status}`,
        );
      const printed = frontend.format(active.input);
      if (!printed.ok)
        throw new Error(
          `native migration formatting refused: ${'reason' in printed ? printed.reason : printed.status}`,
        );
      return printed.text;
    },
    parse(text) {
      const unit = frontend.parseUnit(text);
      if (!unit.ok) throw new NativeSourceError(unit);
      return unit.program;
    },
    link: (entry, read, options) => linkNativeSource(entry, read, frontend, options),
  };
  return migrateWithCodec(entry, destination, root, legacyDense, codec);
}
