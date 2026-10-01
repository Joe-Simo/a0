/**
 * reply-classify: why did a model's edit reply fail? Deterministic rules only; a reply the rules
 * cannot place stays 'unknown'. `--json` prints every class and the rule that chose it.
 *
 *   truncation          the reply stopped at the output cap (stop reason, or an unclosed code fence)
 *   format-slip         the answer was right in spirit but the wrapper broke the protocol: prose around
 *                       the block, a handle that is not the open one, no block at all
 *   protocol-ambiguity  the protocol itself gave two readings or a stale reference: line numbers out
 *                       of range, a revision mismatch, an ambiguous target
 *   model-error         a well-formed edit that the checker or the tests rejected
 *   unknown             no rule matched
 *
 *   node dist/tools/dev/reply-classify.js <results/ai-edit-experiment.*.json> [--json]
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type FailureClass =
  | 'truncation'
  | 'format-slip'
  | 'protocol-ambiguity'
  | 'model-error'
  | 'unknown';
export const FAILURE_CLASSES: readonly FailureClass[] = [
  'truncation',
  'format-slip',
  'protocol-ambiguity',
  'model-error',
  'unknown',
];

export interface FailedReply {
  readonly failures: readonly string[];
  readonly reply?: string;
  readonly stopReason?: string;
  readonly outputTokens?: number;
  readonly maxTokens?: number;
}

export function classifyByRules(r: FailedReply): { cls: FailureClass; rule: string } {
  const text = r.failures.join('\n');
  const reply = r.reply ?? '';
  if (r.stopReason && /max_tokens|length/i.test(r.stopReason))
    return { cls: 'truncation', rule: 'stop reason is the output cap' };
  if (r.outputTokens !== undefined && r.maxTokens !== undefined && r.outputTokens >= r.maxTokens)
    return { cls: 'truncation', rule: 'output tokens reached the cap' };
  if (reply && (reply.match(/```/g)?.length ?? 0) % 2 === 1)
    return { cls: 'truncation', rule: 'unclosed code fence' };
  if (
    /expected handle|no code block|unparse|could not (?:find|extract)|prose|unexpected (?:text|wrapper)|malformed (?:reply|patch)/i.test(
      text,
    )
  )
    return { cls: 'format-slip', rule: 'failure names a reply-format problem' };
  if (
    /out of range|stale|revision|ambiguous|1-based|0-based|no such (?:function|line)|more than one match/i.test(
      text,
    )
  )
    return { cls: 'protocol-ambiguity', rule: 'failure names a reference or numbering problem' };
  if (
    /\btests?\b|expected .* (?:got|but)|= \S+, expected|mismatch|wrong|assert|checksum|type error|parse error|structure|checker|rejected|\bfix:/i.test(
      text,
    )
  )
    return { cls: 'model-error', rule: 'a well-formed reply was rejected by the checker or tests' };
  return { cls: 'unknown', rule: 'no rule matched' };
}

export interface Classified {
  readonly cls: FailureClass;
  readonly rule: string;
}

export function classify(r: FailedReply): Classified {
  return classifyByRules(r);
}

interface Trial {
  readonly task?: string;
  readonly attempts?: readonly {
    readonly status?: string;
    readonly failures?: readonly string[];
  }[];
  readonly failures?: readonly string[];
  readonly accepted?: boolean;
}

export function failedTrials(json: unknown): FailedReply[] {
  const trials = (json as { trials?: Trial[] }).trials ?? [];
  const out: FailedReply[] = [];
  for (const t of trials) {
    for (const a of t.attempts ?? []) {
      if (a.status !== 'ok' || (a.failures?.length ?? 0) > 0) {
        out.push({ failures: a.failures ?? [] });
      }
    }
  }
  return out.filter((f) => f.failures.length > 0);
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    process.stderr.write('usage: reply-classify <results json> [--json]\n');
    process.exit(2);
  }
  const failed = failedTrials(JSON.parse(readFileSync(file, 'utf8')));
  const rows = failed.map((f) => ({ ...classify(f), failures: f.failures.slice(0, 3) }));
  const counts = new Map<string, number>();
  for (const c of rows) counts.set(c.cls, (counts.get(c.cls) ?? 0) + 1);
  if (args.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ file, counts: Object.fromEntries(counts), rows }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`${failed.length} failed attempts\n`);
  for (const [k, n] of counts) process.stdout.write(`  ${k.padEnd(20)} ${n}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
