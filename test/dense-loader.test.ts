import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { A0Error, run } from '../src/core.js';
import { parseDense } from '../src/dense.js';
import { type Linked, link } from '../src/link.js';
import {
  type Attempt,
  denseForms,
  denseReader,
  judgeProgram,
  judgeReject,
  listSources,
  loadDense,
  mismatch,
  type Read,
  ROOT,
  runComparison,
} from '../tools/dense-loader.js';

/** In-memory files, keyed by resolved path so the test runs the same on every platform. */
function memory(files: Record<string, string>): Read {
  const map = new Map(Object.entries(files).map(([p, t]) => [resolve(p), t] as const));
  return async (path) => {
    const text = map.get(resolve(path));
    if (text === undefined) throw new Error(`no file ${path}`);
    return text;
  };
}

const MEM_ROOT = resolve('/p');

// top calls twice, twice calls inc2, and inc2 is defined two files away: the arities of the whole
// chain have to reach each file that calls into it.
const CHAIN: Record<string, string> = {
  '/p/lib.a0': 'fn inc2 u32 u32 -> u32\na add p0 p1\nret a\nend\n',
  '/p/mid.a0': 'use "lib.a0"\n\nfn twice u32 -> u32\na call inc2 p0 p0\nret a\nend\n',
  '/p/top.a0': 'use "mid.a0"\n\nfn top u32 u32 -> u32\na call twice p0\nb add a p1\nret b\nend\n',
};

/** A load's outcome as the comparison records it; a load that throws is an unmatched reader. */
async function attempt(load: () => Promise<Linked>): Promise<Attempt> {
  try {
    return { ok: true, linked: await load() };
  } catch (e) {
    if (e instanceof A0Error)
      return { ok: false, id: e.id ?? null, line: e.line ?? null, message: e.message };
    return { ok: false, id: null, line: null, message: e instanceof Error ? e.message : String(e) };
  }
}

test('dense loader: a file that calls into a used file reads back exactly, through the chain', async () => {
  const read = memory(CHAIN);
  const entry = resolve('/p/top.a0');
  const dense = await denseForms([entry], read);
  // the dense text of mid.a0 cannot be parsed on its own: its callee is defined in another file
  assert.throws(() => parseDense(dense.get(resolve('/p/mid.a0')) as string));
  const canonical = await link(entry, read, { root: MEM_ROOT });
  const linked = await loadDense(entry, denseReader(dense), MEM_ROOT);
  assert.equal(mismatch(canonical.program, linked.program), undefined);
  assert.equal(linked.sources.length, 3);
  assert.equal(run(linked.program.byName.get('top') as never, [3, 4]), 10);
});

test('dense loader: a dense text that differs from the canonical program is reported', async () => {
  const read = memory(CHAIN);
  const entry = resolve('/p/top.a0');
  const dense = await denseForms([entry], read);
  const canonical = await link(entry, read, { root: MEM_ROOT });
  const good = await loadDense(entry, denseReader(dense), MEM_ROOT);
  const accepted = judgeProgram('top.a0', canonical, { ok: true, linked: good });
  assert.equal(accepted.status, 'match');
  assert.equal(accepted.linkedDense, 'match');

  const changed = new Map(dense);
  const lib = resolve('/p/lib.a0');
  changed.set(lib, (dense.get(lib) as string).replace('add', 'sub'));
  const judged = judgeProgram(
    'top.a0',
    canonical,
    await attempt(() => loadDense(entry, denseReader(changed), MEM_ROOT)),
  );
  assert.equal(judged.status, 'unmatched');
  assert.match(judged.reason ?? '', /canonical text differs/);
});

test('dense loader: a file the dense tree lacks is an unmatched program with the reader message', async () => {
  const read = memory(CHAIN);
  const entry = resolve('/p/top.a0');
  const canonical = await link(entry, read, { root: MEM_ROOT });
  const dense = await denseForms([entry], read);
  dense.delete(resolve('/p/mid.a0'));
  const judged = judgeProgram(
    'top.a0',
    canonical,
    await attempt(() => loadDense(entry, denseReader(dense), MEM_ROOT)),
  );
  assert.equal(judged.status, 'unmatched');
  assert.match(judged.reason ?? '', /^dense reader: /);
});

test('dense loader: reject parity names each way the two readers can disagree', async () => {
  const linked = await link(resolve('/p/lib.a0'), memory(CHAIN), { root: MEM_ROOT });
  const accepted: Attempt = { ok: true, linked };
  const rejected = (id: string | null): Attempt => ({ ok: false, id, line: 3, message: 'msg' });

  assert.deepEqual(judgeReject(rejected('A0220'), rejected('A0220')), {
    status: 'match',
    dense: { accepted: false, id: 'A0220', line: 3, message: 'msg' },
  });
  assert.equal(judgeReject(rejected('A0220'), rejected(null)).category, 'dense-no-id');
  assert.equal(judgeReject(rejected('A0220'), rejected('A0221')).category, 'different-id');
  const lenient = judgeReject(rejected('A0011'), accepted);
  assert.equal(lenient.category, 'dense-accepts');
  assert.match(lenient.reason ?? '', /by design/);
  assert.equal(judgeReject(accepted, rejected('A0011')).category, 'canonical-accepts');
});

test('dense loader: the repository programs read back exactly, and every reject is judged', async () => {
  const sources = listSources(ROOT);
  assert.ok(sources.length >= 100, `found ${sources.length} .a0 files`);
  const report = await runComparison(ROOT);
  assert.equal(report.files.length, sources.length);

  const programs = report.files.filter((f) => f.kind === 'program');
  assert.ok(programs.length >= 80, `found ${programs.length} accepted programs`);
  for (const f of programs) assert.equal(f.status, 'match', `${f.path}: ${f.reason ?? ''}`);
  assert.equal(report.summary.programsUnmatched, 0);
  // compiler/parse.a0 calls into lex.a0: the dense parse fails without the callee's arity
  const parser = programs.find((f) => f.path === 'compiler/parse.a0');
  assert.ok(parser !== undefined && parser.status === 'match' && parser.loaded > 1);

  // every reject is rejected by the canonical reader with the id its header names
  assert.equal(report.summary.rejectsHeaderMatched, report.summary.rejects);
  assert.ok(report.summary.rejects >= 30, `found ${report.summary.rejects} rejects`);
  for (const f of report.files) {
    if (f.status === 'unmatched')
      assert.ok(f.reason, `${f.path}: an unmatched file names its reason`);
  }
  const categories = ['dense-accepts', 'dense-no-id', 'different-id', 'canonical-accepts'];
  for (const category of Object.keys(report.summary.rejectCategories))
    assert.ok(categories.includes(category), category);
});
