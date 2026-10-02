/**
 * File plumbing for collecting replies from fresh subject subagents without writing any reply by
 * hand: one prompt file per (cell, model, task), one reply file written by the subject, one
 * repair prompt file per failed first reply. Nothing here calls a model.
 *
 *   prompts  DUMP.json OUTDIR          one `<key>.prompt.txt` per key of an A0_EXPERIMENT_DUMP file
 *   collect  DUMP.json DIR OUT.json    DIR/<key>.reply.txt (and .repair.txt) into the scripted-replies map
 *   repair   REPORT.json DUMP.json DIR OUTDIR
 *                                      a repair prompt per trial whose first reply was rejected: the
 *                                      system text, the request, the subject's own reply and the
 *                                      harness's exact rejection message
 *
 * The scripted-replies map is `{ "task/a0/structured": [first reply, repair reply?] }`, the format
 * tools/ai-edit-experiment.ts reads through A0_EXPERIMENT_REPLIES.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Dump {
  [key: string]: { system: string; user: string };
}
interface Report {
  trials: {
    task: string;
    representation: string;
    protocol: string;
    accepted: boolean | null;
    attempts: { repair?: string }[];
  }[];
}

const safe = (key: string): string => key.replaceAll('/', '__');
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'prompts') {
  const [dumpPath, outDir] = args as [string, string];
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as Dump;
  mkdirSync(outDir, { recursive: true });
  for (const [key, p] of Object.entries(dump))
    writeFileSync(
      join(outDir, `${safe(key)}.prompt.txt`),
      `SYSTEM:\n${p.system}\n\nREQUEST:\n${p.user}\n`,
    );
  process.stdout.write(`${Object.keys(dump).length} prompt files\n`);
} else if (cmd === 'collect') {
  const [dumpPath, dir, out] = args as [string, string, string];
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as Dump;
  const map: Record<string, string[]> = {};
  let missing = 0;
  for (const key of Object.keys(dump)) {
    const first = join(dir, `${safe(key)}.reply.txt`);
    const second = join(dir, `${safe(key)}.repair.txt`);
    if (!existsSync(first)) {
      missing += 1;
      continue;
    }
    map[key] = [readFileSync(first, 'utf8')];
    if (existsSync(second)) map[key]?.push(readFileSync(second, 'utf8'));
  }
  writeFileSync(out, JSON.stringify(map, null, 1));
  process.stdout.write(`${Object.keys(map).length} replies, ${missing} missing\n`);
} else if (cmd === 'repair') {
  const [reportPath, dumpPath, dir, outDir] = args as [string, string, string, string];
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as Dump;
  mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const t of report.trials) {
    const repair = t.attempts[0]?.repair;
    if (t.accepted === true || repair === undefined) continue;
    const key = `${t.task}/${t.representation}/${t.protocol}`;
    const p = dump[key];
    if (p === undefined) continue;
    const reply = readFileSync(join(dir, `${safe(key)}.reply.txt`), 'utf8');
    writeFileSync(
      join(outDir, `${safe(key)}.prompt.txt`),
      `SYSTEM:\n${p.system}\n\nCONVERSATION SO FAR:\n[user]\n${p.user}\n\n[assistant]\n${reply}\n\n[user]\n${repair}\n\nWrite the next assistant reply only.\n`,
    );
    n += 1;
  }
  process.stdout.write(`${n} repair prompts\n`);
} else {
  throw new Error('usage: prompts | collect | repair');
}
