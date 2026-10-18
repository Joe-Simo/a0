/** Approved historical application bytes. No historical reader runs before the complete seal. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { formatProgram, formatSource } from '../src/core.js';
import { type Linked, link } from '../src/link.js';
import type { nativeSource } from '../src/source-native.js';
import { linkNativeSource } from '../src/source-native-link.js';
import { nativeAppEditLanguage } from './app-edit-native.js';

export const APPLICATION_SOURCE_MANIFEST_SHA256 =
  '60a2daeecbf74fba64a1c44b8c8f4c8e1b7d3726a0704bffdbdf39eabe87a1dd';
export const APPLICATION_PACKET_DIRECTORY = 'tools/app-edit-packets/applications-v1';
export const APPLICATION_ENTRIES = {
  sentinel: 'site/sentinel/main.a0',
  sitegen: 'site/gen/sitegen.a0',
} as const;
export type ApplicationName = keyof typeof APPLICATION_ENTRIES;
export const applicationSHA256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

interface SourceManifest {
  readonly schema: 1;
  readonly id: 'applications-v1';
  readonly baselineCommit: string;
  readonly applications: Readonly<
    Record<
      string,
      {
        readonly modules: readonly string[];
        readonly functions: number;
        readonly sourceBytes: number;
      }
    >
  >;
  readonly files: readonly {
    readonly path: string;
    readonly bytes?: number;
    readonly sha256?: string;
    readonly missing?: boolean;
  }[];
}

/** All reads below return detached verified snapshots, including declared missing data fixtures.
 * A directory is only a location; the approved digest, member digests and exact paths grant import. */
export async function approvedApplicationSources(directory = APPLICATION_PACKET_DIRECTORY) {
  const manifestBytes = await readFile(join(directory, 'source-manifest.json'));
  if (applicationSHA256(manifestBytes) !== APPLICATION_SOURCE_MANIFEST_SHA256)
    throw new Error('application source manifest differs from approved packet');
  const manifest = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
  ) as SourceManifest;
  const files = new Map<string, Uint8Array | undefined>();
  for (const member of manifest.files) {
    if (member.missing) {
      files.set(member.path, undefined);
      continue;
    }
    const bytes = Uint8Array.from(await readFile(join(directory, 'source', member.path)));
    if (bytes.length !== member.bytes || applicationSHA256(bytes) !== member.sha256)
      throw new Error(`application source differs from approved packet: ${member.path}`);
    files.set(member.path, bytes);
  }
  const root = resolve(directory, 'source');
  const imports = new WeakMap<Linked, ApplicationName>();
  const bytes = (path: string): Uint8Array | undefined => {
    if (!files.has(path)) throw new Error(`file is outside approved application packet: ${path}`);
    const value = files.get(path);
    return value === undefined ? undefined : Uint8Array.from(value);
  };
  const text = (path: string): string => {
    const value = bytes(path);
    if (value === undefined) throw new Error(`missing approved application source: ${path}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  };
  const read = async (path: string) => text(relative(root, path).replaceAll('\\', '/'));
  const canonicalPath = async (path: string) => resolve(path);
  return {
    manifest,
    manifestSHA256: APPLICATION_SOURCE_MANIFEST_SHA256,
    bytes,
    text,
    /** The only historical application reader boundary. Every source was verified above. */
    async historical(name: ApplicationName): Promise<Linked> {
      const imported = await link(resolve(root, APPLICATION_ENTRIES[name]), read, {
        root,
        canonicalPath,
        includeUnits: true,
      });
      imports.set(imported, name);
      return imported;
    },
    async native(name: ApplicationName, before: Linked, frontend: ReturnType<typeof nativeSource>) {
      const entry = APPLICATION_ENTRIES[name];
      const members = manifest.applications[entry]?.modules;
      if (
        imports.get(before) !== name ||
        members === undefined ||
        before.units === undefined ||
        before.units.length !== members.length ||
        before.units.some(
          (unit, index) => relative(root, unit.path).replaceAll('\\', '/') !== members[index],
        )
      )
        throw new Error('historical import is not the approved application graph');
      const language = nativeAppEditLanguage(frontend);
      const migrated = new Map<string, string>();
      for (const unit of before.units) {
        const path = relative(root, unit.path).replaceAll('\\', '/');
        const output = language.formatSource(unit.program);
        const parsed = frontend.parseUnit(output);
        if (!parsed.ok) throw new Error(`native application unit refused: ${path}`);
        if (formatSource(parsed.program) !== formatSource(unit.program))
          throw new Error(`native application migration changed source metadata: ${path}`);
        migrated.set(path, output);
      }
      const after = await linkNativeSource(
        resolve(root, entry),
        async (path) => {
          const key = relative(root, path).replaceAll('\\', '/');
          const value = migrated.get(key);
          if (value === undefined) throw new Error('native graph escaped migrated source snapshot');
          return value;
        },
        frontend,
        { root, canonicalPath },
      );
      if (formatSource(after.program) !== formatSource(before.program))
        throw new Error('native application graph migration changed program or comments');
      return {
        linked: after,
        modules: [...migrated].map(([path, source]) => ({
          path,
          bytes: Buffer.byteLength(source),
          sha256: applicationSHA256(source),
        })),
        historicalSource: formatProgram(before.program),
        nativeSource: after.text,
        revision: language.revision(after.program, 'program'),
      };
    },
  };
}
