/**
 * Deterministic cost of the lazy hints (src/lazy.ts) on recorded first replies: every recorded first reply of the V3 arm on the
 * sealed sets X and Y (fresh Haiku and Sonnet subagents, results/primer-v3/, results/dense-default/) is applied to its task's
 * starting program in a fresh edit session, once with the hints off and once on. The extra tokens of a rejection (o200k, the
 * message the repair prompt carries) and the extra view tokens (the fold legend) are summed and divided by the number of
 * tasks, so the average is paid over accepted and rejected trials alike.
 *
 *   bun tools/primer-v4-hint-cost.ts      writes results/primer-v4-hint-cost.json
 *
 * This measures the hints on the failures of the V3 arm. The V4 arm's own failures are more numerous (the registered run
 * measures them); this is the floor the hints cost on the replies a fuller primer already produces.
 */

import { readFileSync } from 'node:fs';
import { getEncoding } from 'js-tiktoken';
import { formatDiagnostic, parseAndValidate } from '../src/core.js';
import { A0Error } from '../src/diagnostics.js';
import { EditSession } from '../src/edit.js';
import { extractBlock } from './ai-edit-apply.js';
import { TASKS_X } from './ai-edit-tasks-x.js';
import { TASKS_Y } from './ai-edit-tasks-y.js';
import { writeReport } from './scrub-results.js';

const enc = getEncoding('o200k_base');
const tokens = (s: string): number => enc.encode(s).length;

interface Cell {
  readonly set: 'x' | 'y';
  readonly model: string;
  readonly file: string;
}
const CELLS: readonly Cell[] = [
  { set: 'y', model: 'haiku', file: 'results/primer-v3/replies.y.haiku.V3.json' },
  { set: 'y', model: 'sonnet', file: 'results/primer-v3/replies.y.sonnet.V3.json' },
  { set: 'x', model: 'haiku', file: 'results/dense-default/replies.x.haiku.canon.json' },
  { set: 'x', model: 'sonnet', file: 'results/dense-default/replies.x.sonnet.canon.json' },
];

function openSession(source: string, fn: string): { session: EditSession; view: string } {
  const session = new EditSession(parseAndValidate(source));
  const view = `${session.open(fn, { scope: 'deps' }).text}\n${session.openProgram({ scope: 'all', target: fn }).text}`;
  return { session, view };
}

function rejection(source: string, fn: string, reply: string): string | undefined {
  const { session } = openSession(source, fn);
  try {
    session.apply(extractBlock(reply));
    return undefined;
  } catch (e) {
    return e instanceof A0Error ? formatDiagnostic(e, false) : undefined;
  }
}

const out: Record<string, unknown> = {};
for (const c of CELLS) {
  const tasks = (c.set === 'y' ? TASKS_Y : TASKS_X) as readonly {
    id: string;
    target: string;
    a0Source: string;
  }[];
  const replies = JSON.parse(readFileSync(c.file, 'utf8')) as Record<string, string[]>;
  let extraRejection = 0;
  let extraView = 0;
  let rejected = 0;
  let n = 0;
  for (const t of tasks) {
    const first = replies[`${t.id}/a0/structured`]?.[0];
    if (first === undefined) continue;
    n += 1;
    delete process.env.A0_LAZY_HINTS;
    const off = rejection(t.a0Source, t.target, first);
    const offView = tokens(openSession(t.a0Source, t.target).view);
    process.env.A0_LAZY_HINTS = 'on';
    const on = rejection(t.a0Source, t.target, first);
    const onView = tokens(openSession(t.a0Source, t.target).view);
    delete process.env.A0_LAZY_HINTS;
    extraView += onView - offView;
    if (off !== undefined && on !== undefined) {
      rejected += 1;
      extraRejection += tokens(on) - tokens(off);
    }
  }
  out[`${c.set}/${c.model}`] = {
    tasks: n,
    firstRepliesRejectedByTheChecker: rejected,
    extraRejectionTokensTotal: extraRejection,
    extraViewTokensTotal: extraView,
    meanExtraTokensPerTask: Math.round(((extraRejection + extraView) / n) * 10) / 10,
  };
}
await writeReport('results/primer-v4-hint-cost.json', {
  generatedAt: new Date().toISOString(),
  tool: 'tools/primer-v4-hint-cost.ts',
  meaning:
    'Extra o200k tokens the lazy hints add to the recorded first-reply rejections (and the fold legend to the view) of the V3 arm on sets X and Y, averaged over all tasks.',
  cells: out,
});
console.log(JSON.stringify(out, null, 1));
