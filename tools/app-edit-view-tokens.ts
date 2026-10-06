/**
 * The o200k token cost of an A0 request of the application-scale edit benchmark (docs/history/2026-10-06-app-edit-deps-preregistration.md)
 * under three program views: the full signature listing of the sealed arm, the listing scoped to the functions the first target reaches
 * (`A0_PROGRAM_VIEW=deps`), and no program listing. A deterministic count of the harness's own prompts (the request: instruction plus view,
 * without the system text); writes results/app-edit-deps/view-tokens.json.
 *
 *   bun tools/app-edit-view-tokens.ts
 */

import { getEncoding } from 'js-tiktoken';
import { parseAndValidate } from '../src/core.js';
import { EditSession } from '../src/edit.js';
import { startPrograms } from './app-edit-bench.js';
import { APP_TASKS } from './app-edit-tasks.js';
import { writeReport } from './scrub-results.js';

type Scope = 'all' | 'deps' | 'none';

const enc = getEncoding('o200k_base');
const programs = await startPrograms();
const rows: { task: string; all: number; deps: number; none: number }[] = [];
for (const task of APP_TASKS) {
  const count = (scope: Scope): number => {
    const session = new EditSession(parseAndValidate(programs.a0));
    const views = task.a0Targets.map((f) => session.open(f, { scope: 'deps' }).text);
    if (scope !== 'none')
      views.push(session.openProgram({ scope, target: task.a0Targets[0] as string }).text);
    return enc.encode(`${task.instruction}\n\n${views.join('\n')}`).length;
  };
  rows.push({ task: task.id, all: count('all'), deps: count('deps'), none: count('none') });
}
const avg = (key: Scope): number =>
  Math.round(rows.reduce((a, r) => a + r[key], 0) / Math.max(1, rows.length));
await writeReport('results/app-edit-deps/view-tokens.json', {
  generatedAt: new Date().toISOString(),
  tool: 'tools/app-edit-view-tokens.ts',
  preRegistration: 'docs/history/2026-10-06-app-edit-deps-preregistration.md',
  meaning:
    'o200k tokens of the user part of an A0 request of the application-scale edit benchmark (instruction plus the views of the target functions plus a program view): the full listing of every signature (all), the listing scoped to the functions the first target reaches (deps), and no program listing (none).',
  average: { all: avg('all'), deps: avg('deps'), none: avg('none') },
  tasks: rows,
});
console.log(JSON.stringify({ all: avg('all'), deps: avg('deps'), none: avg('none') }));
