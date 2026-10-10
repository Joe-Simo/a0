/**
 * Subject directories for the edit-protocol run (docs/history/2026-10-10-edit-protocol-preregistration.md):
 * one directory per first-shot prompt of a harness dump (A0_EXPERIMENT_DUMP), holding only `prompt.txt`
 * (system text, then the request). The subject writes `reply.txt` there. Calls no model.
 *
 *   bun tools/edit-protocol-setup.ts DUMP.json ROOT ARM MODEL SET
 *
 * Appends one JSON line per subject ({id, arm, model, dir, prompt}) to ROOT/manifest.jsonl.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function subjectPrompt(dir: string): string {
  return `Experiment subject. Directory: ${dir}. Read and write only inside it; never read, list or search anything outside it (no repository, no other directory, no web). Read prompt.txt there (a SYSTEM text, then a REQUEST), follow the SYSTEM text and answer the REQUEST. Write only your reply text to reply.txt in that directory, then stop.`;
}

if (import.meta.main) {
  const [dumpPath, root, arm, model, set] = process.argv.slice(2) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as Record<
    string,
    { system: string; user: string }
  >;
  let n = 0;
  for (const [key, p] of Object.entries(dump)) {
    const task = key.split('/')[0] ?? key;
    const dir = resolve(root, arm, model, set, task);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'prompt.txt'), `SYSTEM:\n${p.system}\n\nREQUEST:\n${p.user}\n`);
    appendFileSync(
      join(root, 'manifest.jsonl'),
      `${JSON.stringify({ id: `${arm}/${model}/${set}/${task}`, key, arm, model, dir, prompt: subjectPrompt(dir) })}\n`,
    );
    n += 1;
  }
  process.stdout.write(`${n} subject directories\n`);
}
