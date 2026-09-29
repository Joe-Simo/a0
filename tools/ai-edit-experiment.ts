/**
 * Gate A harness: the controlled 2x2 AI-edit experiment.
 *
 *   representation: A0 | TypeScript        x    protocol: conventional | structured
 *
 * Each cell gives the model the same task, the same acceptance tests, and an
 * equally capable edit protocol; whole-task accounting records setup (language
 * instructions + protocol instructions), view, output, tool calls, validation
 * failures, repairs, wall time, and provider-reported usage. Unknown reasoning
 * usage is recorded as null, never zero.
 *
 * Modes:
 *   default (dry run): builds every prompt, validates the reference solutions
 *     against the acceptance tests locally, and records local tokenizer counts.
 *     No model is called. Writes results/ai-edit-experiment.json with status
 *     "unrun".
 *   live: requires A0_ALLOW_PAID_MODEL_CALLS=1 AND Anthropic credentials. Calls
 *     claude-opus-5-5 (override with A0_EXPERIMENT_MODEL) for N trials per cell.
 *     Never runs implicitly.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Anthropic from '@anthropic-ai/sdk';
import { getEncoding } from 'js-tiktoken';
import { formatProgram, parseAndValidate, run, type TypedFunc, type Value } from '../src/core.js';
import { EditSession } from '../src/edit.js';
import { runTool, withTempDir } from '../src/toolchain.js';

type Representation = 'a0' | 'ts';
type Protocol = 'conventional' | 'structured';

interface AcceptanceCase {
  readonly fn: string;
  readonly args: readonly Value[];
  readonly expected: Value;
}

interface Task {
  readonly id: string;
  readonly kind: 'targeted-edit' | 'multi-node-edit' | 'comprehension-edit';
  readonly instruction: string;
  readonly a0Source: string;
  readonly tsSource: string;
  readonly tests: readonly AcceptanceCase[];
  /** Reference solutions, used only to validate the harness itself. */
  readonly reference: { readonly a0: string; readonly ts: string };
}

// --- Held-out style tasks (small; the harness, not the task set, is the deliverable) ---

const TASKS: readonly Task[] = [
  {
    id: 'affine-sign',
    kind: 'targeted-edit',
    instruction: 'Change affine so it subtracts the offset instead of adding it.',
    a0Source: 'fn affine u32 u32 u32 -> u32\na mul p0 p1\nb add a p2\nret b\nend\n',
    tsSource:
      'export function affine(x: number, scale: number, offset: number): number {\n  return (Math.imul(x, scale) + offset) >>> 0;\n}\n',
    tests: [
      { fn: 'affine', args: [10, 3, 7], expected: 23 },
      { fn: 'affine', args: [0, 0, 1], expected: 0xffff_ffff },
      { fn: 'affine', args: [0xffff_ffff, 2, 0], expected: 0xffff_fffe },
    ],
    reference: {
      a0: 'fn affine u32 u32 u32 -> u32\na mul p0 p1\nb sub a p2\nret b\nend\n',
      ts: 'export function affine(x: number, scale: number, offset: number): number {\n  return (Math.imul(x, scale) - offset) >>> 0;\n}\n',
    },
  },
  {
    id: 'clamp-both',
    kind: 'multi-node-edit',
    instruction:
      'clamp currently returns min(x, hi). Make it return x clamped into [lo, hi] where the new second parameter is lo and the third is hi (unsigned comparison). Keep the function name.',
    a0Source: 'fn clamp u32 u32 -> u32\nc lt p1 p0\nr select c p1 p0\nret r\nend\n',
    tsSource:
      'export function clamp(x: number, hi: number): number {\n  return hi < x ? hi : x;\n}\n',
    tests: [
      { fn: 'clamp', args: [5, 1, 10], expected: 5 },
      { fn: 'clamp', args: [0, 1, 10], expected: 1 },
      { fn: 'clamp', args: [0xffff_ffff, 1, 10], expected: 10 },
      { fn: 'clamp', args: [0x8000_0000, 0x7fff_ffff, 0x8000_0001], expected: 0x8000_0000 },
    ],
    reference: {
      a0: 'fn clamp u32 u32 u32 -> u32\nc lt p2 p0\nr select c p2 p0\nd lt r p1\ns select d p1 r\nret s\nend\n',
      ts: 'export function clamp(x: number, lo: number, hi: number): number {\n  const t = hi < x ? hi : x;\n  return t < lo ? lo : t;\n}\n',
    },
  },
  {
    id: 'rotl-fix',
    kind: 'comprehension-edit',
    instruction:
      'rotl is meant to rotate x left by n bits (n in 0..31) but currently computes something else. Fix it without changing the signature.',
    a0Source:
      'fn rotl u32 u32 -> u32\nl shl p0 p1\nn sub 32 p1\nr shl p0 n\no or l r\nret o\nend\n',
    tsSource:
      'export function rotl(x: number, n: number): number {\n  return ((x << n) | (x << (32 - n))) >>> 0;\n}\n',
    tests: [
      { fn: 'rotl', args: [0x8000_0000, 1], expected: 1 },
      { fn: 'rotl', args: [1, 31], expected: 0x8000_0000 },
      { fn: 'rotl', args: [0x1234_5678, 8], expected: 0x3456_7812 },
      { fn: 'rotl', args: [0xdead_beef, 0], expected: 0xdead_beef },
    ],
    reference: {
      a0: 'fn rotl u32 u32 -> u32\nl shl p0 p1\nn sub 32 p1\nr shr p0 n\no or l r\nret o\nend\n',
      ts: 'export function rotl(x: number, n: number): number {\n  return ((x << n) | (x >>> ((32 - n) & 31))) >>> 0;\n}\n',
    },
  },
];

// --- Instructions (counted as setup cost; identical across trials) ------------

const PROTOCOL_CONVENTIONAL =
  'Reply with the complete updated source file and nothing else, inside one ```code block.';
const PROTOCOL_STRUCTURED_A0 =
  'You are shown a view whose first line is an edit handle (e.g. e0). Reply with that handle line followed only by the instruction lines you replace (same ids, keep positions). Nothing else, inside one ```code block.';
const PROTOCOL_STRUCTURED_TS =
  'You are shown a view whose first line is an edit handle (e.g. e0) and whose remaining lines are numbered. Reply with that handle line followed only by replacement lines as `<number> <new text>` (one per line; a number may be given once). Nothing else, inside one ```code block.';
const TS_SEMANTICS =
  'Numbers are unsigned 32-bit integers: every arithmetic result must be normalized with >>> 0, use Math.imul for multiplication, and comparisons are unsigned.';

// --- Views and edit application -----------------------------------------------

function numbered(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((l, i) => `${i + 1} ${l}`)
    .join('\n');
}

function extractBlock(reply: string): string {
  const m = /```[a-z0-9]*\n([\s\S]*?)```/.exec(reply);
  return `${(m ? (m[1] ?? '') : reply).trimEnd()}\n`;
}

interface AppliedEdit {
  readonly source: string;
  readonly error?: string;
}

function applyA0(
  rep: Representation,
  protocol: Protocol,
  source: string,
  reply: string,
  session?: EditSession,
): AppliedEdit {
  void rep;
  const body = extractBlock(reply);
  if (protocol === 'conventional') {
    try {
      parseAndValidate(body);
      return { source: body };
    } catch (e) {
      return { source, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (session === undefined) return { source, error: 'no session' };
  try {
    const next = session.apply(body);
    return { source: formatProgram(next) };
  } catch (e) {
    return { source, error: e instanceof Error ? e.message : String(e) };
  }
}

function applyTs(protocol: Protocol, source: string, reply: string, handle: string): AppliedEdit {
  const body = extractBlock(reply);
  if (protocol === 'conventional') return { source: body };
  const lines = body.trimEnd().split('\n');
  if (lines[0] !== handle)
    return { source, error: `expected handle ${handle}, got '${lines[0] ?? ''}'` };
  const out = source.trimEnd().split('\n');
  const seen = new Set<number>();
  for (const l of lines.slice(1)) {
    const m = /^(\d+) ?(.*)$/.exec(l);
    if (!m) return { source, error: `bad replacement line: ${l}` };
    const n = Number(m[1]);
    if (seen.has(n) || n < 1 || n > out.length)
      return { source, error: `bad or duplicate line number ${n}` };
    seen.add(n);
    out[n - 1] = m[2] ?? '';
  }
  return { source: `${out.join('\n')}\n` };
}

// --- Acceptance -----------------------------------------------------------------

function fmt(v: Value): string {
  return typeof v === 'boolean' ? String(v) : String(v);
}

async function acceptA0(source: string, tests: readonly AcceptanceCase[]): Promise<string[]> {
  const failures: string[] = [];
  let program: ReturnType<typeof parseAndValidate>;
  try {
    program = parseAndValidate(source);
  } catch (e) {
    return [`invalid A0: ${e instanceof Error ? e.message : String(e)}`];
  }
  for (const t of tests) {
    const fn = program.byName.get(t.fn) as TypedFunc | undefined;
    if (fn === undefined) {
      failures.push(`missing function ${t.fn}`);
      continue;
    }
    try {
      const got = run(fn, t.args);
      if (got !== t.expected)
        failures.push(
          `${t.fn}(${t.args.map(fmt).join(',')}) = ${fmt(got)}, expected ${fmt(t.expected)}`,
        );
    } catch (e) {
      failures.push(`${t.fn}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failures;
}

async function acceptTs(source: string, tests: readonly AcceptanceCase[]): Promise<string[]> {
  // Type-check with tsc, then execute the checked JS in a separate Node process.
  return withTempDir(async (dir) => {
    const file = join(dir, 'mod.ts');
    await writeFile(file, source, 'utf8');
    const tsc = join(process.cwd(), 'node_modules', '.bin', 'tsc');
    // Self-contained project: no ambient @types, only the ES library.
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2022',
          module: 'es2022',
          moduleResolution: 'bundler',
          lib: ['es2022'],
          types: [],
          typeRoots: [],
          outDir: dir,
        },
        files: ['mod.ts'],
      }),
      'utf8',
    );
    const check = runTool(tsc, ['-p', join(dir, 'tsconfig.json')], { cwd: dir });
    if (!check.ok) return [`tsc: ${check.stdout.slice(0, 500)}`];
    const js = await readFile(join(dir, 'mod.js'), 'utf8');
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
    )) as Record<string, (...a: Value[]) => Value>;
    const failures: string[] = [];
    for (const t of tests) {
      const f = mod[t.fn];
      if (typeof f !== 'function') {
        failures.push(`missing export ${t.fn}`);
        continue;
      }
      try {
        const got = f(...t.args);
        if (got !== t.expected)
          failures.push(
            `${t.fn}(${t.args.map(fmt).join(',')}) = ${fmt(got)}, expected ${fmt(t.expected)}`,
          );
      } catch (e) {
        failures.push(`${t.fn}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return failures;
  });
}

// --- Cells ------------------------------------------------------------------------

interface Cell {
  readonly representation: Representation;
  readonly protocol: Protocol;
  readonly system: string;
  readonly view: string;
}

async function buildCell(
  task: Task,
  representation: Representation,
  protocol: Protocol,
  guide: string,
): Promise<{ cell: Cell; session?: EditSession; handle: string }> {
  const handle = 'e0';
  if (representation === 'a0') {
    const protocolText =
      protocol === 'conventional' ? PROTOCOL_CONVENTIONAL : PROTOCOL_STRUCTURED_A0;
    const system = `${guide}\n\n${protocolText}`;
    if (protocol === 'structured') {
      const session = new EditSession(parseAndValidate(task.a0Source));
      const fnName = parseAndValidate(task.a0Source).functions[0]?.name ?? '';
      const view = session.open(fnName).text;
      return { cell: { representation, protocol, system, view }, session, handle };
    }
    return { cell: { representation, protocol, system, view: task.a0Source }, handle };
  }
  const protocolText = protocol === 'conventional' ? PROTOCOL_CONVENTIONAL : PROTOCOL_STRUCTURED_TS;
  const system = `${TS_SEMANTICS}\n\n${protocolText}`;
  const view =
    protocol === 'conventional' ? task.tsSource : `${handle}\n${numbered(task.tsSource)}`;
  return { cell: { representation, protocol, system, view }, handle };
}

interface Trial {
  readonly task: string;
  readonly kind: Task['kind'];
  readonly representation: Representation;
  readonly protocol: Protocol;
  readonly trial: number;
  readonly setupTokensLocal: Record<string, number>;
  readonly viewTokensLocal: Record<string, number>;
  readonly outputTokensLocal: Record<string, number> | null;
  readonly providerUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
  readonly reasoningTokens: null;
  readonly modelCalls: number;
  readonly validationFailures: number;
  readonly accepted: boolean | null;
  readonly failures: readonly string[];
  readonly wallMs: number | null;
}

async function main(): Promise<void> {
  const live = process.env.A0_ALLOW_PAID_MODEL_CALLS === '1';
  const model = process.env.A0_EXPERIMENT_MODEL ?? 'claude-opus-5-5';
  const trialsPerCell = Number(process.env.A0_EXPERIMENT_TRIALS ?? '3');
  const maxRepairs = 2;
  const guide = await readFile('MODEL_GUIDE.txt', 'utf8');
  const encoders = {
    o200k_base: getEncoding('o200k_base'),
    cl100k_base: getEncoding('cl100k_base'),
  } as const;
  const count = (text: string): Record<string, number> =>
    Object.fromEntries(Object.entries(encoders).map(([k, e]) => [k, e.encode(text).length]));

  // Harness self-check: reference solutions must pass acceptance in every cell.
  const selfCheck: Record<string, string[]> = {};
  for (const task of TASKS) {
    selfCheck[`${task.id}/a0`] = await acceptA0(task.reference.a0, task.tests);
    selfCheck[`${task.id}/ts`] = await acceptTs(task.reference.ts, task.tests);
    selfCheck[`${task.id}/a0-original-must-fail`] =
      (await acceptA0(task.a0Source, task.tests)).length > 0 ? [] : ['original already passes'];
    selfCheck[`${task.id}/ts-original-must-fail`] =
      (await acceptTs(task.tsSource, task.tests)).length > 0 ? [] : ['original already passes'];
  }
  const selfCheckOk = Object.values(selfCheck).every((f) => f.length === 0);

  const client = live ? new Anthropic() : undefined;
  const trials: Trial[] = [];
  for (const task of TASKS) {
    for (const representation of ['a0', 'ts'] as const) {
      for (const protocol of ['conventional', 'structured'] as const) {
        for (let t = 0; t < (live ? trialsPerCell : 1); t += 1) {
          const { cell, session, handle } = await buildCell(task, representation, protocol, guide);
          const base: Omit<
            Trial,
            | 'outputTokensLocal'
            | 'providerUsage'
            | 'modelCalls'
            | 'validationFailures'
            | 'accepted'
            | 'failures'
            | 'wallMs'
          > = {
            task: task.id,
            kind: task.kind,
            representation,
            protocol,
            trial: t,
            setupTokensLocal: count(cell.system),
            viewTokensLocal: count(cell.view),
            reasoningTokens: null,
          };
          if (client === undefined) {
            trials.push({
              ...base,
              outputTokensLocal: null,
              providerUsage: null,
              modelCalls: 0,
              validationFailures: 0,
              accepted: null,
              failures: [],
              wallMs: null,
            });
            continue;
          }
          const start = performance.now();
          const messages: Anthropic.MessageParam[] = [
            { role: 'user', content: `${task.instruction}\n\n${cell.view}` },
          ];
          let source = representation === 'a0' ? task.a0Source : task.tsSource;
          const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          let calls = 0;
          let validationFailures = 0;
          let failures: string[] = [];
          let accepted = false;
          let outputText = '';
          for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
            const res = await client.messages.create({
              model,
              max_tokens: 4096,
              system: [{ type: 'text', text: cell.system, cache_control: { type: 'ephemeral' } }],
              messages,
            });
            calls += 1;
            usage.input += res.usage.input_tokens;
            usage.output += res.usage.output_tokens;
            usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
            usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
            const reply = res.content
              .filter((b): b is Anthropic.TextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
            outputText += reply;
            const applied =
              representation === 'a0'
                ? applyA0(representation, protocol, source, reply, session)
                : applyTs(protocol, source, reply, handle);
            failures =
              applied.error !== undefined
                ? [applied.error]
                : representation === 'a0'
                  ? await acceptA0(applied.source, task.tests)
                  : await acceptTs(applied.source, task.tests);
            if (failures.length === 0) {
              accepted = true;
              source = applied.source;
              break;
            }
            validationFailures += 1;
            messages.push({ role: 'assistant', content: reply });
            const nextView =
              protocol === 'structured' &&
              representation === 'a0' &&
              session !== undefined &&
              applied.error === undefined
                ? session.open(parseAndValidate(applied.source).functions[0]?.name ?? '').text
                : undefined;
            messages.push({
              role: 'user',
              content: `Rejected:\n${failures.join('\n')}\n${nextView !== undefined ? `\nCurrent view:\n${nextView}` : ''}\nTry again.`,
            });
          }
          trials.push({
            ...base,
            outputTokensLocal: count(outputText),
            providerUsage: usage,
            modelCalls: calls,
            validationFailures,
            accepted,
            failures,
            wallMs: performance.now() - start,
          });
        }
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    status: live
      ? 'run'
      : 'unrun (paid model calls not authorized: set A0_ALLOW_PAID_MODEL_CALLS=1 with Anthropic credentials)',
    model: live ? model : null,
    tokenizerNote:
      'setup/view/output token counts are local js-tiktoken counts (OpenAI encodings), not the vendor tokenizer; providerUsage carries the billed counts when live.',
    design: {
      cells: ['a0/conventional', 'a0/structured', 'ts/conventional', 'ts/structured'],
      heldConstant: [
        'model',
        'task text',
        'acceptance tests',
        'max repairs',
        'max_tokens',
        'system prompt caching',
      ],
      setupCounted:
        'A0 cells carry MODEL_GUIDE.txt as language instructions; TS cells carry the u32 semantics note; both carry their protocol instructions.',
      unknowns: 'Hidden reasoning tokens are not reported by the API and are recorded as null.',
    },
    tasks: TASKS.map((t) => ({ id: t.id, kind: t.kind, tests: t.tests.length })),
    harnessSelfCheck: { ok: selfCheckOk, details: selfCheck },
    trials,
  };
  await mkdir('results', { recursive: true });
  await writeFile(
    join('results', 'ai-edit-experiment.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`status: ${report.status}\nself-check: ${selfCheckOk ? 'ok' : 'FAILED'}\n`);
  for (const tr of trials) {
    process.stdout.write(
      `${tr.task.padEnd(12)} ${tr.representation}/${tr.protocol.padEnd(12)} setup o200k=${tr.setupTokensLocal.o200k_base} view o200k=${tr.viewTokensLocal.o200k_base}${tr.accepted === null ? '' : ` accepted=${tr.accepted} calls=${tr.modelCalls}`}\n`,
    );
  }
  if (!selfCheckOk) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
