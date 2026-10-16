/** Four-mode offline application benchmark; raw samples, byte parity and explicit budget failures. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { writeReport } from './scrub-results.js';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const equal = a.indexOf('=');
    return [a.slice(2, equal < 0 ? undefined : equal), equal < 0 ? '' : a.slice(equal + 1)];
  }),
);
const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    total += e.isDirectory() ? await treeBytes(path) : (await stat(path)).size;
  }
  return total;
}
type Mode = 'old-off' | 'off' | 'source-only' | 'build-only' | 'combined';
interface Row {
  mode: Mode;
  fixture: string;
  load: number[];
  loadAtStart: number[];
  sourceHash: string;
  sourceViewHash: string;
  artifactHash: string;
  outputHash: string;
  cleanMs: number;
  warmMs: number;
  warmSamplesMs: number[];
  editMs: number;
  incrementalMs: number;
  startupMs: number;
  runtimeMs: number[];
  peakRssKiB: number;
  artifactBytes: number;
  storedBytes: number;
  storedBytesAfterRotation: number;
  identityMs: number;
  sealMs: number;
  rotateMs: number;
}
async function worker(): Promise<void> {
  const loadAtStart = loadavg();
  const mode = args.get('mode') as Mode;
  const fixture = args.get('fixture') as string;
  const root = await mkdtemp(join(tmpdir(), 'a0-protection-bench-'));
  const source = await readFile(fixture, 'utf8');
  const sealed = mode === 'source-only' || mode === 'combined';
  const protectedBuild = mode === 'build-only' || mode === 'combined';
  const moduleRoot =
    mode === 'old-off' ? resolve(args.get('baseline') as string, 'dist/src') : resolve('dist/src');
  const load = (name: string): Promise<unknown> =>
    import(pathToFileURL(join(moduleRoot, `${name}.js`)).href);
  const { link } = (await load('link')) as typeof import('../src/link.js');
  const { compileCached, DiskCache } = (await load('cache')) as typeof import('../src/cache.js');
  const { wasmModuleBytes } = (await load('wasm')) as typeof import('../src/wasm.js');
  const policy =
    mode === 'old-off' ? undefined : (await import('../src/protection-policy.js')).protectionPolicy;
  const adapter = protectedBuild
    ? (await import('../src/protection/artifact.js')).protectWasm
    : undefined;
  const compilerOptions = {
    ioInputCapacity: 256,
    ioOutputCapacity: fixture.includes('page') ? 262144 : 1024,
  };
  let project: import('../src/protection/vault.js').SealedProject | undefined;
  let sealedCompile: typeof import('../src/protection/build.js').compileSealed | undefined;
  let identityMs = 0,
    sealMs = 0,
    rotateMs = 0;
  const file = join(root, fixture);
  const original = await link(resolve(fixture), (path) => readFile(path, 'utf8'));
  for (const item of original.sources) {
    const destination = join(root, relative(process.cwd(), item.path));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(item.path));
  }
  if (sealed) {
    const crypto = await import('../src/protection/crypto.js');
    const { SealedProject } = await import('../src/protection/vault.js');
    const { DiskVaultStore, inventory, resumeMigration } = await import(
      '../src/protection/disk.js'
    );
    sealedCompile = (await import('../src/protection/build.js')).compileSealed;
    let start = performance.now();
    const pass = crypto.utf8.encode('owned offline benchmark identity only');
    const ownerFile = await crypto.createIdentity(pass);
    const owner = await crypto.unlockIdentity(ownerFile, pass);
    pass.fill(0);
    identityMs = performance.now() - start;
    start = performance.now();
    const store = new DiskVaultStore(root);
    const plan = await inventory(root);
    await store.initialize();
    project = await SealedProject.create(store, owner, {
      direction: 'on',
      stage: 'copy',
      items: plan.items,
    });
    await resumeMigration(project, root);
    sealMs = performance.now() - start;
  }
  const build = async (): Promise<Uint8Array> => {
    if (project && sealedCompile)
      return sealedCompile(project, fixture, 'wasm', {
        protect: protectedBuild,
        compilerOptions,
      });
    const program = (
      await link(
        file,
        async (path) => {
          policy?.(path);
          return readFile(path, 'utf8');
        },
        { root },
      )
    ).program;
    const emitted = await compileCached(
      program,
      'wasm',
      new DiskCache(join(root, '.a0-cache')),
      compilerOptions,
    );
    const bytes = wasmModuleBytes(emitted.text);
    return adapter ? adapter(bytes).bytes : bytes;
  };
  const views: { path: string; hash: string }[] = [];
  for (const item of original.sources) {
    const path = relative(process.cwd(), item.path).replaceAll('\\', '/');
    const expected = await readFile(item.path, 'utf8');
    const actual = project
      ? await project.sourceAccess('local-editor').read(path)
      : await readFile(join(root, path), 'utf8');
    assert.equal(actual, expected);
    views.push({ path, hash: hash(actual) });
  }
  try {
    let start = performance.now();
    const clean = await build();
    const cleanMs = performance.now() - start;
    const warmSamples: number[] = [];
    for (let k = 0; k < 7; k++) {
      start = performance.now();
      const warm = await build();
      warmSamples.push(performance.now() - start);
      assert.deepEqual(warm, clean);
    }
    const warmMs = median(warmSamples);
    const edited = `${source}\nfn protection_bench_edit -> u32\nret 42\nend\n`;
    start = performance.now();
    if (project) await project.sourceAccess('local-editor').write(fixture, edited);
    else {
      // Identical crash-safe editing contract on both sides; encrypted editing also persists a manifest.
      const { open, rename } = await import('node:fs/promises');
      const temp = join(dirname(file), 'edit.tmp');
      const fd = await open(temp, 'wx', 0o600);
      try {
        await fd.writeFile(edited);
        await fd.sync();
      } finally {
        await fd.close();
      }
      await rename(temp, file);
      if (process.platform !== 'win32') {
        const dir = await open(dirname(file), 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
    }
    const editMs = performance.now() - start;
    start = performance.now();
    await build();
    const incrementalMs = performance.now() - start;
    const artifactDir = args.get('artifacts');
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        join(artifactDir, `${fixture.includes('page') ? 'page' : 'life'}-${mode}.wasm`),
        clean,
      );
    }
    start = performance.now();
    const module = new WebAssembly.Module(clean as BufferSource);
    const instance = new WebAssembly.Instance(module, {});
    const startupMs = performance.now() - start;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const ptr = Number((instance.exports.__heap_base as WebAssembly.Global).value);
    const capacity = compilerOptions.ioInputCapacity + compilerOptions.ioOutputCapacity + 3;
    if (ptr + capacity * 4 > memory.buffer.byteLength)
      memory.grow(Math.ceil((ptr + capacity * 4 - memory.buffer.byteLength) / 65536));
    const io = new Uint32Array(memory.buffer, ptr, capacity);
    const entry = instance.exports[fixture.includes('page') ? 'a0_session' : 'a0_life'] as (
      ptr: number,
    ) => number;
    const input = fixture.includes('page')
      ? [0]
      : [...Array.from({ length: 32 }, (_, i) => (0x9e3779b9 * (i + 1)) >>> 0), 0, 0, 0];
    const invoke = (): number => {
      io.set(input);
      io[256] = input.length;
      io[257] = 0;
      io[258 + compilerOptions.ioOutputCapacity] = 0;
      return entry(ptr) >>> 0;
    };
    let result = invoke();
    const count = io[258 + compilerOptions.ioOutputCapacity] as number;
    const outputHash = hash(new Uint8Array(io.buffer, io.byteOffset + 258 * 4, count * 4));
    for (let i = 0; i < 5; i++) invoke();
    const runtimeMs: number[] = [];
    for (let i = 0; i < 15; i++) {
      start = performance.now();
      for (let k = 0; k < 5; k++) result ^= invoke();
      runtimeMs.push((performance.now() - start) / 5);
    }
    assert.ok(Number.isInteger(result));
    const storedBytes = await treeBytes(root);
    if (project) {
      start = performance.now();
      await project.rotate();
      rotateMs = performance.now() - start;
    }
    const row: Row = {
      mode,
      fixture,
      load: loadavg(),
      loadAtStart,
      sourceHash: hash(original.text),
      sourceViewHash: hash(JSON.stringify(views)),
      artifactHash: hash(clean),
      outputHash,
      cleanMs,
      warmMs,
      warmSamplesMs: warmSamples,
      editMs,
      incrementalMs,
      startupMs,
      runtimeMs,
      peakRssKiB: process.resourceUsage().maxRSS,
      artifactBytes: clean.length,
      storedBytes,
      storedBytesAfterRotation: await treeBytes(root),
      identityMs,
      sealMs,
      rotateMs,
    };
    process.stdout.write(`${JSON.stringify(row)}\n`);
  } finally {
    project?.lock();
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const baseline = args.get('baseline');
  if (!baseline) throw new Error('--baseline=<metadata-free old checkout> is required');
  const samples = Number(args.get('samples') ?? 7);
  if (!Number.isSafeInteger(samples) || samples < 3) throw new Error('at least three samples');
  const modes: Mode[] = ['old-off', 'off', 'source-only', 'build-only', 'combined'];
  const fixtures = ['examples/life.a0', 'site/page.a0'];
  const rows: Row[] = [];
  const fingerprints = async (): Promise<Record<string, string>> => {
    const files = [
      'src/protection-policy.ts',
      'src/cache.ts',
      'src/backends.ts',
      'src/link.ts',
      'tools/protection-bench.ts',
      ...(await readdir('src/protection'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `src/protection/${f}`),
    ];
    const result: Record<string, string> = {};
    for (const file of files)
      for (const path of [file, `dist/${file.replace(/\.ts$/, '.js')}`])
        result[path] = hash(await readFile(path));
    return result;
  };
  const before = await fingerprints();
  for (let round = 0; round < samples; round++)
    for (const fixture of fixtures)
      for (let k = 0; k < modes.length; k++) {
        const mode = modes[(round + k) % modes.length] as Mode;
        if ((loadavg()[0] as number) > 10) throw new Error('loaded machine: discard and rerun');
        const command = [
          process.argv[1] as string,
          '--worker',
          `--mode=${mode}`,
          `--fixture=${fixture}`,
          `--baseline=${baseline}`,
        ];
        if (round === 0 && args.has('artifacts'))
          command.push(`--artifacts=${args.get('artifacts')}`);
        const result = spawnSync(process.execPath, command, {
          encoding: 'utf8',
          timeout: 180000,
          maxBuffer: 4 << 20,
        });
        if (result.status !== 0) throw new Error(`${mode} ${fixture}: ${result.stderr}`);
        const row = JSON.parse(result.stdout) as Row;
        if ((row.load[0] as number) > 10 || (row.loadAtStart[0] as number) > 10)
          throw new Error('Loaded worker; discard and rerun');
        rows.push(row);
        process.stderr.write(`${round + 1}/${samples} ${fixture} ${mode}\n`);
      }
  assert.deepEqual(await fingerprints(), before, 'benchmark inputs changed while measuring');
  const summaries = fixtures.map((fixture) => {
    const selected = rows.filter((r) => r.fixture === fixture);
    const expected = selected[0] as Row;
    for (const row of selected) {
      assert.equal(row.sourceHash, expected.sourceHash);
      assert.equal(row.sourceViewHash, expected.sourceViewHash);
      assert.equal(row.artifactHash, expected.artifactHash);
      assert.equal(row.outputHash, expected.outputHash);
    }
    const stats = modes.map((mode) => {
      const arm = selected.filter((r) => r.mode === mode);
      const runtimes = arm.flatMap((r) => r.runtimeMs).sort((a, b) => a - b);
      return {
        mode,
        cleanMs: median(arm.map((r) => r.cleanMs)),
        warmMs: median(arm.map((r) => r.warmMs)),
        editBuildMs: median(arm.map((r) => r.editMs + r.incrementalMs)),
        startupMs: median(arm.map((r) => r.startupMs)),
        runtimeMs: median(runtimes),
        runtimeP95Ms: runtimes[Math.ceil(runtimes.length * 0.95) - 1] as number,
        peakRssKiB: median(arm.map((r) => r.peakRssKiB)),
        storedBytes: median(arm.map((r) => r.storedBytes)),
        artifactBytes: expected.artifactBytes,
        sealMs: median(arm.map((r) => r.sealMs)),
        identityMs: median(arm.map((r) => r.identityMs)),
        rotateMs: median(arm.map((r) => r.rotateMs)),
      };
    });
    const old = stats[0] as (typeof stats)[number],
      off = stats[1] as (typeof stats)[number];
    const budgets = stats.slice(1).map((s) => ({
      mode: s.mode,
      comparisons: (
        [
          'cleanMs',
          'warmMs',
          'editBuildMs',
          'startupMs',
          'runtimeMs',
          'runtimeP95Ms',
          'peakRssKiB',
          'artifactBytes',
        ] as const
      ).map((metric) => {
        const baseline = s.mode === 'off' ? old : off;
        const ratio = s[metric] / baseline[metric] - 1;
        const target =
          s.mode === 'off'
            ? 0
            : metric === 'cleanMs'
              ? 0.1
              : ['warmMs', 'editBuildMs', 'peakRssKiB', 'artifactBytes'].includes(metric)
                ? 0.05
                : 0.02;
        return {
          metric,
          ratio,
          target,
          pointEstimatePass: ratio <= target,
          uncertainty:
            'Seven fresh-process rounds; warm build is a median of seven calls. No statistical no-regression claim; inspect raw outliers.',
        };
      }),
    }));
    return {
      fixture,
      sourceHash: expected.sourceHash,
      artifactHash: expected.artifactHash,
      outputHash: expected.outputHash,
      stats,
      budgets,
    };
  });
  const { getEncoding } = await import('js-tiktoken');
  const { link } = await import('../src/link.js');
  const tokenizers = {
    o200k_base: getEncoding('o200k_base'),
    cl100k_base: getEncoding('cl100k_base'),
  };
  const tokens = [];
  for (const fixture of fixtures) {
    const graph = await link(resolve(fixture), (path) => readFile(path, 'utf8'));
    const files = [];
    for (const item of graph.sources) {
      const source = await readFile(item.path, 'utf8');
      files.push({
        path: relative(process.cwd(), item.path),
        sha256: hash(source),
        o200k: tokenizers.o200k_base.encode(source).length,
        cl100k: tokenizers.cl100k_base.encode(source).length,
      });
    }
    tokens.push({
      fixture,
      files,
      sealedView:
        'Every worker checks exact source equality before measurement; identical bytes produce identical tokenizer input.',
    });
  }
  const report = {
    schema: 'a0-protection-benchmark-1',
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: cpus().length,
    },
    samples,
    scope:
      'Fresh processes, rotating arm order; existing optimized compiler and identical per-function cache keys; disk encryption and durable writes. Identity/seal/rotation separate. Memory is whole-process peak including setup, not isolated application memory.',
    limitations: [
      'No weak-device measurements.',
      'Linux only.',
      'No external model calls: source byte/token identity only; provider cache/billing and accepted-edit rates unmeasured.',
      'Point estimates; no statistical no-regression claim.',
      'Storage includes retained ciphertext generations; no garbage collection.',
      'Artifact bytes are identical in these fixtures, so this adapter provides no demonstrated reconstruction gain.',
    ],
    baselineSourceHash: hash(await readFile(join(baseline, 'src/cli-main.ts'))),
    candidateSourceHash: hash(await readFile('src/cli-main.ts')),
    fingerprints: before,
    tokens,
    summaries,
    raw: rows,
  };
  const out = args.get('out') ?? 'results/protection-benchmark.json';
  await mkdir(dirname(out), { recursive: true });
  await writeReport(out, report);
  process.stdout.write(`${out}\n`);
}
if (args.has('worker')) await worker();
else await main();
