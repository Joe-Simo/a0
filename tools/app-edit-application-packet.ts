/** The selected four-case packet: full applications, fixed IO backend, one study loop. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatType, type TypedProgram } from '../src/core.js';
import { loadNativeSourcePackage } from '../src/source-native-package.js';
import { applicationRuntime } from './app-edit-application-runtime.js';
import {
  APPLICATION_PACKET_DIRECTORY,
  type ApplicationName,
  applicationSHA256,
  approvedApplicationSources,
} from './app-edit-application-sources.js';
import type { A0Surface, ApplicationEvaluationPacket, Programs } from './app-edit-bench.js';
import { appEditServiceSources, nativeAppEditLanguage } from './app-edit-native.js';
import { type SentinelCases, sentinelOracle } from './app-edit-sentinel-oracle.js';
import {
  APPLICATION_GENERATOR_BATCH_CALLS,
  type SitegenCases,
  sitegenOracle,
} from './app-edit-sitegen-oracle.js';
import type { AppTask } from './app-edit-tasks.js';

export const APPLICATION_CASE_MANIFEST_SHA256 =
  '1c7f51073f0489923df05dedf4a80e2d7a0173a94e290a29fb01975e08022192';
interface CaseDescription {
  readonly id: string;
  readonly application: ApplicationName;
  readonly oracle: 'edge' | 'tap' | 'g1' | 'g2';
  readonly summary: string;
  readonly instruction: string;
  readonly a0Targets: readonly string[];
  readonly reference: string;
  readonly wrong: string;
  readonly wrongWhy: string;
  readonly wrongWitness: string;
}

async function caseFiles(directory: string) {
  const manifest = await readFile(join(directory, 'case-manifest.json'));
  if (applicationSHA256(manifest) !== APPLICATION_CASE_MANIFEST_SHA256)
    throw new Error('application case manifest differs from selected controls');
  const parsed = JSON.parse(manifest.toString('utf8')) as {
    readonly files: readonly {
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
    }[];
  };
  const files = new Map<string, string>();
  for (const file of parsed.files) {
    const bytes = await readFile(join(directory, file.path));
    if (bytes.length !== file.bytes || applicationSHA256(bytes) !== file.sha256)
      throw new Error(`application case differs from selected controls: ${file.path}`);
    files.set(file.path, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  return (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw new Error(`unknown application control file: ${path}`);
    return text;
  };
}

/** Both historical readers are confined to this explicit, digest-approved packet. The fixed
 * native package also checks generated page source for Canonical and Dense trials. */
export async function applicationEditPacket(options: {
  readonly directory: string;
  readonly manifestSHA256: string;
  readonly packetDirectory?: string;
}) {
  const directory = options.packetDirectory ?? APPLICATION_PACKET_DIRECTORY;
  const controls = await caseFiles(directory);
  const sources = await approvedApplicationSources(directory);
  const packageBytes = await readFile(join(options.directory, 'manifest.json'));
  const packaged = await loadNativeSourcePackage(packageBytes, options.manifestSHA256, (name) =>
    readFile(join(options.directory, name)),
  );
  const releases: (() => void | Promise<void>)[] = [];
  let closed = false;
  const dispose = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const release of releases.splice(0).reverse()) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'application packet cleanup failed');
  };
  try {
    const frontend = packaged.instantiate();
    releases.push(() => frontend.close());
    const generatedFrontend = packaged.instantiate();
    releases.push(() => generatedFrontend.close());
    const runtime = await applicationRuntime();
    releases.push(() => runtime.close());
    const language = nativeAppEditLanguage(frontend);
    const applications = new Map<
      ApplicationName,
      {
        readonly historical: TypedProgram;
        readonly native: TypedProgram;
        readonly historicalPrograms: Programs;
        readonly nativePrograms: Programs;
        readonly modules: readonly {
          readonly path: string;
          readonly bytes: number;
          readonly sha256: string;
        }[];
        readonly revision: string;
      }
    >();
    for (const name of ['sentinel', 'sitegen'] as const) {
      const before = await sources.historical(name);
      const after = await sources.native(name, before, frontend);
      applications.set(name, {
        historical: before.program,
        native: after.linked.program,
        historicalPrograms: { a0: after.historicalSource, ts: '' },
        nativePrograms: { a0: after.nativeSource, ts: '' },
        modules: after.modules,
        revision: after.revision,
      });
    }
    const descriptions = JSON.parse(controls('tasks.json')) as CaseDescription[];
    const taskDescriptions = new Map<AppTask, CaseDescription>();
    const tasks = descriptions.map((description): AppTask => {
      const task = Object.freeze({
        id: description.id,
        summary: description.summary,
        instruction: description.instruction,
        a0Targets: Object.freeze([...description.a0Targets]),
        tests: [],
        reference: Object.freeze({ a0: controls(description.reference), ts: '' }),
        wrong: Object.freeze({
          a0: controls(description.wrong),
          ts: '',
          why: description.wrongWhy,
        }),
      });
      taskDescriptions.set(task, description);
      return task;
    });
    const select = (task: AppTask) => {
      if (closed) throw new Error('application packet is closed');
      const description = taskDescriptions.get(task);
      const application = description && applications.get(description.application);
      if (!description || !application)
        throw new Error('task is outside approved application packet');
      return { description, application };
    };
    const sentinelCases = JSON.parse(controls('fixtures/sentinel-cases.json')) as SentinelCases;
    const sitegenCases = JSON.parse(controls('fixtures/sitegen-cases.json')) as SitegenCases;
    const oracleRuns: Record<string, unknown>[] = [];
    const packet: ApplicationEvaluationPacket = {
      tasks,
      metadata: {
        id: 'applications-v1',
        serviceSources: await appEditServiceSources([
          'tools/app-edit-application-packet.ts',
          'tools/app-edit-application-runtime.ts',
          'tools/app-edit-application-sources.ts',
          'tools/app-edit-sentinel-oracle.ts',
          'tools/app-edit-sitegen-oracle.ts',
          'tools/site-gen.ts',
          'tools/site-render.ts',
          'site/live/words.ts',
        ]),
        status: 'pre-sealing-controls',
        sourceManifestSHA256: sources.manifestSHA256,
        caseManifestSHA256: APPLICATION_CASE_MANIFEST_SHA256,
        sourceManifest: sources.manifest,
        applications: Object.fromEntries(
          [...applications].map(([name, app]) => [
            name,
            {
              functions: app.native.functions.length,
              historicalSHA256: applicationSHA256(app.historicalPrograms.a0),
              nativeSHA256: applicationSHA256(app.nativePrograms.a0),
              revision: app.revision,
              modules: app.modules,
            },
          ]),
        ),
        package: {
          manifestSHA256: packaged.manifestSHA256,
          manifest: packaged.manifest,
          artifactBytes: packaged.artifactBytes,
        },
        runtimeLimits: runtime.limits,
        generatorBatchCalls: APPLICATION_GENERATOR_BATCH_CALLS,
        runtimeRuns: runtime.runs,
        oracleRuns,
        historicalReaderUse: [
          'approved module import',
          'approved reference/wrong control derivation',
        ],
        generatedSourceAuthority: 'same packaged native graph parser/checker in all source arms',
      },
      initial(task, surface) {
        const { application } = select(task);
        return {
          programs:
            surface === 'native' ? application.nativePrograms : application.historicalPrograms,
          historical: application.historicalPrograms,
          ...(surface === 'native' ? { services: language.services } : {}),
        };
      },
      starter(task, source, surface: A0Surface) {
        const { application } = select(task);
        const expected =
          surface === 'native' ? application.nativePrograms : application.historicalPrograms;
        if (source !== expected.a0)
          throw new Error('application starter is outside approved module graph');
        return surface === 'native' ? application.native : application.historical;
      },
      approveControl(task, source, reply) {
        const { application } = select(task);
        if (
          source !== application.historicalPrograms.a0 ||
          (reply !== task.reference.a0 && reply !== task.wrong.a0)
        )
          throw new Error('historical application control import is outside approved packet');
      },
      wrongWitness(task, result) {
        const { description } = select(task);
        return (
          result.error === undefined &&
          result.failures.some((failure) => failure.startsWith(description.wrongWitness)) &&
          result.failures.every(
            (failure) =>
              !/application execution refused|application JS process failed|malformed application response|invalid application IO/.test(
                failure,
              ),
          )
        );
      },
      async evaluate(program, task) {
        const { description, application } = select(task);
        const failures: string[] = [];
        for (const old of application.historical.functions) {
          const actual = program.byName.get(old.name);
          if (
            !actual ||
            formatType(actual.result) !== formatType(old.result) ||
            JSON.stringify(actual.params.map(formatType)) !==
              JSON.stringify(old.params.map(formatType))
          )
            failures.push(`missing/changed public signature ${old.name}`);
        }
        if (!failures.length) {
          let observed: string[];
          try {
            observed =
              description.oracle === 'edge' || description.oracle === 'tap'
                ? await sentinelOracle(
                    program,
                    description.oracle,
                    sentinelCases,
                    runtime,
                    application.historical,
                  )
                : await sitegenOracle(
                    program,
                    description.oracle,
                    sitegenCases,
                    runtime,
                    sources,
                    generatedFrontend,
                  );
          } catch (error) {
            observed = [
              `application execution refused: ${error instanceof Error ? error.message : String(error)}`,
            ];
          }
          failures.push(...observed);
        }
        oracleRuns.push({
          task: task.id,
          functions: program.functions.length,
          failures: [...failures],
        });
        return failures;
      },
    };
    return {
      packet,
      close: dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'application packet initialization and cleanup failed',
      );
    }
    throw error;
  }
}
