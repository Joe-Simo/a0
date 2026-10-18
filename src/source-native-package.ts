/** Source-bound release assets. Loading needs no compiler checkout or source parser. */
import { nativeSource } from './source-native.js';
import { decodeSourceUtf8 } from './source-utf8.js';

export const SOURCE_PACKAGE_FILES = Object.freeze([
  'frontend.wasm',
  'format.wasm',
  'diagnostic.wasm',
] as const);
export type SourcePackageFile = (typeof SOURCE_PACKAGE_FILES)[number];
export interface SourcePackageComponent {
  readonly bytes: number;
  readonly sha256: string;
  readonly buildSHA256: string;
  readonly sourceSHA256: string;
}
export interface SourcePackageManifest {
  readonly schema: 1;
  readonly compilerVersion: string;
  readonly frontendABI: 3;
  readonly formatCapability: 'arena-format-v2';
  readonly diagnosticCapability: 'arena-v1';
  readonly verificationWords: 768;
  readonly components: Readonly<Record<SourcePackageFile, SourcePackageComponent>>;
}

const hash = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

async function manifestFrom(
  bytes: Uint8Array<ArrayBuffer>,
  expectedSHA256: string,
): Promise<SourcePackageManifest> {
  if (!digest(expectedSHA256) || (await hash(bytes)) !== expectedSHA256)
    throw new Error('source package manifest identity differs');
  const manifest: unknown = JSON.parse(decodeSourceUtf8(bytes));
  if (
    !object(manifest) ||
    manifest.schema !== 1 ||
    typeof manifest.compilerVersion !== 'string' ||
    !/^a0c-\d+\.\d+\.\d+$/.test(manifest.compilerVersion) ||
    manifest.frontendABI !== 3 ||
    manifest.formatCapability !== 'arena-format-v2' ||
    manifest.diagnosticCapability !== 'arena-v1' ||
    manifest.verificationWords !== 768 ||
    !object(manifest.components) ||
    Object.keys(manifest.components).sort().join() !== [...SOURCE_PACKAGE_FILES].sort().join()
  )
    throw new Error('unsupported source package manifest');
  for (const file of SOURCE_PACKAGE_FILES) {
    const component = manifest.components[file];
    if (
      !object(component) ||
      !Number.isSafeInteger(component.bytes) ||
      (component.bytes as number) <= 0 ||
      !digest(component.sha256) ||
      !digest(component.buildSHA256) ||
      !digest(component.sourceSHA256)
    )
      throw new Error(`invalid source package component: ${file}`);
  }
  for (const file of SOURCE_PACKAGE_FILES) Object.freeze(manifest.components[file]);
  Object.freeze(manifest.components);
  return Object.freeze(manifest) as unknown as SourcePackageManifest;
}

/** The expected manifest digest belongs to the release, not to an untrusted asset directory.
 * Every byte snapshot is detached and verified before returning. Companions compile lazily;
 * each instantiate() owns a separate frontend arena and shares only immutable modules. */
export async function loadNativeSourcePackage(
  manifestBytes: Uint8Array,
  expectedSHA256: string,
  read: (file: SourcePackageFile) => Promise<Uint8Array>,
) {
  const manifest = await manifestFrom(Uint8Array.from(manifestBytes), expectedSHA256);
  const snapshots = await Promise.all(
    SOURCE_PACKAGE_FILES.map(async (file) => {
      const bytes = Uint8Array.from(await read(file));
      const component = manifest.components[file];
      if (bytes.length !== component.bytes || (await hash(bytes)) !== component.sha256)
        throw new Error(`source package artifact identity differs: ${file}`);
      return bytes;
    }),
  );
  const modules = new Map<SourcePackageFile, WebAssembly.Module>();
  const load = (file: SourcePackageFile): WebAssembly.Module => {
    let module = modules.get(file);
    if (!module) {
      const bytes = snapshots[SOURCE_PACKAGE_FILES.indexOf(file)];
      if (!bytes) throw new Error(`missing source package snapshot: ${file}`);
      module = new WebAssembly.Module(bytes);
      modules.set(file, module);
    }
    return module;
  };
  const frontend = load('frontend.wasm');
  if (WebAssembly.Module.imports(frontend).length)
    throw new Error('source package frontend must be import-free');
  return {
    manifest,
    manifestSHA256: expectedSHA256,
    artifactBytes: snapshots.reduce((sum, bytes) => sum + bytes.length, 0),
    instantiate: () =>
      nativeSource(
        frontend,
        { load: () => load('diagnostic.wasm'), verification: true },
        { load: () => load('format.wasm') },
      ),
  };
}
