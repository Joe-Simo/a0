// Split for the pre-registered secondary measure of sets I and J (the letter is the argument): one-shot acceptance on the tasks whose target
// result is not u32, from the harness reports (results/set-${L}/report.<model>.<form>.json) and tools/ai-edit-tasks-i.ts.
import { readFileSync } from 'node:fs';

const L = process.argv[2] ?? 'i';
const t = readFileSync(`tools/ai-edit-tasks-${L}.ts`, 'utf8');
const resultOf = {};
for (const block of t.split(/\n {2}\{\n/).slice(1)) {
  const id = /id: "([^"]+)"/.exec(block)?.[1] ?? /id: '([^']+)'/.exec(block)?.[1];
  const target = /target: "([^"]+)"/.exec(block)?.[1] ?? /target: '([^']+)'/.exec(block)?.[1];
  const src = /a0Source:\s*['"](.*?)['"],\n/s.exec(block)?.[1];
  if (id === undefined || target === undefined || src === undefined) continue;
  const line = src.split('\\n').find((l) => l.startsWith(`fn ${target} `)) ?? '';
  resultOf[id] = line.split('->').pop().trim();
}
const non = Object.keys(resultOf).filter((k) => resultOf[k] !== 'u32');
const out = { nonU32Tasks: non.length, byModel: {} };
for (const m of ['haiku', 'sonnet']) {
  for (const f of ['dense', 'canon']) {
    const a = JSON.parse(readFileSync(`results/set-${L}/report.${m}.${f}.json`, 'utf8'));
    const sub = a.trials.filter((x) => non.includes(x.task));
    const rest = a.trials.filter((x) => !non.includes(x.task));
    out.byModel[`${m}/${f}`] = {
      nonU32OneShot: `${sub.filter((x) => x.acceptedOneShot).length} of ${sub.length}`,
      u32OneShot: `${rest.filter((x) => x.acceptedOneShot).length} of ${rest.length}`,
    };
  }
}
console.log(JSON.stringify(out, null, 1));
