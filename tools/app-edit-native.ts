/** Native application-edit research arm. Historical readers only import sealed controls. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Func, Program, TypedProgram } from '../src/core.js';
import { parseAndValidate } from '../src/core.js';
import type { nativeSource } from '../src/source-native.js';
import { nativeEditFormats } from '../src/source-native-edit-context.js';
import { createNativeEditSession } from '../src/source-native-edit-session.js';
import { NativeSourceError } from '../src/source-native-link.js';
import { loadNativeSourcePackage } from '../src/source-native-package.js';
import type { A0ArmServices, Programs } from './app-edit-bench.js';
import { START_SHA256 } from './app-edit-tasks.js';

const sha = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Bind all host services as well as the native components, including execution of hidden tests. */
export async function appEditServiceSources(additional: readonly string[] = []) {
  const files = (await readdir('src', { recursive: true }))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `src/${file.replaceAll('\\', '/')}`)
    .concat([
      'tools/app-edit-bench.ts',
      'tools/app-edit-native.ts',
      'tools/app-edit-tasks.ts',
      'tools/ai-edit-apply.ts',
      'tools/measurement-checkout.ts',
      'tools/ref-parse.ts',
      'tools/scrub-results.ts',
      ...additional,
    ])
    .sort();
  const sources = await Promise.all(
    files.map(async (path) => ({ path, sha256: sha(await readFile(path)) })),
  );
  return { sha256: sha(JSON.stringify(sources)), files: sources };
}

const authoring = (program: Program) => ({
  profileComments: program.profileComments,
  useComments: program.useComments,
  tailComments: program.tailComments,
  functions: program.functions.map((fn) => ({
    name: fn.name,
    comments: fn.comments,
    retComments: fn.retComments,
    endComments: fn.endComments,
    afterComments: fn.afterComments,
    nodes: fn.nodes.map((node) => ({ id: node.id, comments: node.comments, text: node.text })),
    specComments: {
      examples: fn.spec?.examples.map((example) => example.comments) ?? [],
      pre: fn.spec?.pre?.comments,
      post: fn.spec?.post?.comments,
    },
  })),
});

/** The exact packaged language services shared by the sealed compiler and application packets.
 * Callers own the borrowed frontend; historical import policy belongs to each sealed packet. */
export function nativeAppEditLanguage(frontend: ReturnType<typeof nativeSource>) {
  const activate = (program: Program) => {
    const result = frontend.activateProgramForFormat(program);
    if (!result.ok)
      throw new Error(
        `native benchmark activation refused: ${'status' in result ? result.status : result.reason}`,
      );
    return result.input;
  };
  const revision = (program: Program, kind: 'function' | 'program') => {
    const result = frontend.revision(activate(program), { kind });
    if (!result.ok)
      throw new Error(
        `native benchmark revision refused: ${'status' in result ? result.status : result.reason}`,
      );
    return result.revision;
  };
  const parse = (source: string): TypedProgram => {
    const result = frontend.parse(source);
    if (!result.ok) throw new NativeSourceError(result);
    return result.typed;
  };

  const services: A0ArmServices = {
    parse,
    session: (program) => createNativeEditSession(program, frontend),
    revision: (fn) => revision({ functions: [fn] }, 'function'),
    formatControl(_program, changed) {
      return changed
        .map((fn: Func) => {
          const { signature, body } = nativeEditFormats(frontend, fn);
          // Complete declarations survive last-use removal; body bytes come from the same
          // authoritative formatter activation, never a host type/source printer.
          return signature.text + body.text.slice(body.text.indexOf('\n') + 1);
        })
        .join('\n');
    },
  };
  return {
    services,
    revision,
    formatSource(program: Program) {
      const output = frontend.format(activate(program), { scope: 'source' });
      if (!output.ok) throw new Error('native starter formatting refused');
      return output.text;
    },
  };
}

/** The caller owns this arm and closes it after all sessions. No checkout freshness is invented
 * for a frozen package: the manifest binds its actual native source/build/component identities. */
export async function nativeAppEditArm(
  historical: Programs,
  options: { readonly directory: string; readonly manifestSHA256: string },
) {
  if (sha(historical.a0) !== START_SHA256.a0 || sha(historical.ts) !== START_SHA256.ts)
    throw new Error('native application arm imports only the sealed historical starter');
  const manifestBytes = await readFile(join(options.directory, 'manifest.json'));
  const packaged = await loadNativeSourcePackage(manifestBytes, options.manifestSHA256, (name) =>
    readFile(join(options.directory, name)),
  );
  const frontend = packaged.instantiate();
  try {
    const { services, revision, formatSource } = nativeAppEditLanguage(frontend);

    // Explicit one-time migration of the sealed historical Canonical starter. This is not
    // available to the submitted-reply parser or edit acceptance pipeline.
    const original = parseAndValidate(historical.a0);
    const originalRevision = revision(original, 'program');
    const text = formatSource(original);
    const migrated = services.parse(text);
    const migratedRevision = revision(migrated, 'program');
    const authoringSHA256 = sha(JSON.stringify(authoring(original)));
    if (
      migratedRevision !== originalRevision ||
      sha(JSON.stringify(authoring(migrated))) !== authoringSHA256
    )
      throw new Error('native starter migration changed content or authoring metadata');

    return {
      services,
      programs: { a0: text, ts: historical.ts },
      metadata: {
        package: {
          manifestSHA256: packaged.manifestSHA256,
          manifest: packaged.manifest,
          artifactBytes: packaged.artifactBytes,
        },
        serviceSources: await appEditServiceSources(),
        starter: {
          historicalSHA256: sha(historical.a0),
          migratedSHA256: sha(text),
          contentRevision: migratedRevision,
          authoringSHA256,
          functions: migrated.functions.length,
        },
        historicalReaderUse: ['sealed starter import', 'sealed reference/wrong control derivation'],
        acceptance: 'raw reply -> shared EditSession kernels -> packaged A0 parser/checker',
      },
      close: () => frontend.close(),
    };
  } catch (error) {
    frontend.close();
    throw error;
  }
}
