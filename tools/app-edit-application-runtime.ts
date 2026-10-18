/** One fixed application execution backend for every source arm: the existing JS compiler. */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { COMPILER_VERSION, compile } from '../src/backends.js';
import type { TypedProgram } from '../src/core.js';
import { applicationSHA256 } from './app-edit-application-sources.js';

export const APPLICATION_RUNTIME_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  heapMiB: 512,
  inputWords: 1 << 21,
  outputWords: 1 << 22,
  calls: 512,
  protocolBytes: 64 << 20,
});

export interface ApplicationIoResult {
  readonly value: number;
  readonly position: number;
  readonly output: readonly number[];
  readonly inputUnchanged: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const word = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;

/** Reject malformed child transport before any application assertion reads it. */
export function applicationReply(bytes: Uint8Array, inputs: readonly (readonly number[])[]) {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    !record(value) ||
    !Array.isArray(value.calls) ||
    value.calls.length !== inputs.length ||
    typeof value.node !== 'string' ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+/.test(value.node) ||
    typeof value.peakRssKiB !== 'number' ||
    !Number.isSafeInteger(value.peakRssKiB) ||
    value.peakRssKiB < 0
  )
    throw new Error('malformed application response');
  const calls: ApplicationIoResult[] = [];
  value.calls.forEach((call: unknown, index: number) => {
    if (
      !record(call) ||
      call.inputUnchanged !== true ||
      !word(call.value) ||
      !word(call.position) ||
      call.position > (inputs[index]?.length ?? 0) ||
      !Array.isArray(call.output) ||
      call.output.length > APPLICATION_RUNTIME_LIMITS.outputWords ||
      !call.output.every(word)
    )
      throw new Error('invalid application IO result');
    calls.push({
      value: call.value,
      position: call.position,
      output: call.output,
      inputUnchanged: true,
    });
  });
  return { calls, node: value.node, peakRssKiB: value.peakRssKiB };
}

// The child has no source reader. It executes the already compiled complete application.
const WORKER = `import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const {module,entry,inputs,limits} = JSON.parse(readFileSync(0, 'utf8'));
const app = await import(pathToFileURL(module).href);
if(typeof app[entry] !== 'function') throw new Error('missing application entry');
const prefix = [271828];
const calls = inputs.map(input => {
  if(input.length > limits.inputWords) throw new Error('application input limit');
  const io = app.a0_make_io(input);
  io.output.push(...prefix);
  const value = app[entry](io);
  if(io.output.length > limits.outputWords + prefix.length) throw new Error('application output limit');
  if(io.output[0] !== prefix[0]) throw new Error('application overwrote output prefix');
  return {value,position:io.position,output:io.output.slice(prefix.length),inputUnchanged:JSON.stringify(io.input) === JSON.stringify(input)};
});
process.stdout.write(JSON.stringify({calls,node:process.version,peakRssKiB:process.resourceUsage().maxRSS}));
`;

/** The caller owns this disposable workspace and closes it after all task evaluations. */
export async function applicationRuntime(parent = resolve('.a0-tmp')) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'application-runtime-'));
  const worker = join(directory, 'worker.mjs');
  try {
    await writeFile(worker, WORKER);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const modules = new Map<string, string>();
  const runs: Record<string, unknown>[] = [];
  let closed = false;
  return {
    limits: APPLICATION_RUNTIME_LIMITS,
    runs,
    async execute(program: TypedProgram, entry: string, inputs: readonly (readonly number[])[]) {
      if (closed) throw new Error('application runtime is closed');
      if (!inputs.length || inputs.length > APPLICATION_RUNTIME_LIMITS.calls)
        throw new Error('application call count limit');
      for (const input of inputs)
        if (
          input.length > APPLICATION_RUNTIME_LIMITS.inputWords ||
          input.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff_ffff)
        )
          throw new Error('invalid application input words');
      const code = compile(program, 'js').text;
      const codeSHA256 = applicationSHA256(code);
      let module = modules.get(codeSHA256);
      if (!module) {
        module = join(directory, `${codeSHA256}.mjs`);
        await writeFile(module, code, { flag: 'wx' });
        modules.set(codeSHA256, module);
      }
      const request = JSON.stringify({ module, entry, inputs, limits: APPLICATION_RUNTIME_LIMITS });
      if (Buffer.byteLength(request) > APPLICATION_RUNTIME_LIMITS.protocolBytes)
        throw new Error('application request byte limit');
      const runDirectory = await mkdtemp(join(directory, 'run-'));
      const inputPath = join(runDirectory, 'input.json');
      let fd: number | undefined;
      const started = performance.now();
      try {
        await writeFile(inputPath, request);
        fd = openSync(inputPath, 'r');
        const child = spawnSync(
          'node',
          [`--max-old-space-size=${APPLICATION_RUNTIME_LIMITS.heapMiB}`, worker],
          {
            stdio: [fd, 'pipe', 'pipe'],
            timeout: APPLICATION_RUNTIME_LIMITS.timeoutMs,
            maxBuffer: APPLICATION_RUNTIME_LIMITS.protocolBytes,
          },
        );
        if (child.status !== 0 || child.error)
          throw new Error(
            `application JS process failed (${child.status ?? child.signal}): ${child.error?.message ?? child.stderr.toString('utf8').slice(0, 2000)}`,
          );
        const response = applicationReply(child.stdout, inputs);
        runs.push({
          entry,
          compiler: COMPILER_VERSION,
          backend: 'js',
          codeSHA256,
          codeBytes: Buffer.byteLength(code),
          inputSHA256: applicationSHA256(JSON.stringify(inputs)),
          outputSHA256: applicationSHA256(JSON.stringify(response.calls)),
          calls: inputs.length,
          inputWords: inputs.map((input) => input.length),
          outputWords: response.calls.map((call) => call.output.length),
          node: response.node,
          peakRssKiB: response.peakRssKiB,
          elapsedMs: performance.now() - started,
        });
        return response.calls;
      } catch (error) {
        runs.push({
          entry,
          compiler: COMPILER_VERSION,
          backend: 'js',
          codeSHA256,
          inputSHA256: applicationSHA256(JSON.stringify(inputs)),
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: performance.now() - started,
        });
        throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
        await rm(runDirectory, { recursive: true, force: true });
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
