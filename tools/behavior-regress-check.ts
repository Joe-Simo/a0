/**
 * Guard for the behavior-regen workflow: a target that is `passed` in the committed report must not
 * become blocked, failed or skipped in the merged one. Exit 1 lists every regression.
 * Usage: bun tools/behavior-regress-check.ts <committed.json> <merged.json>
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

interface Rep {
  targets: { id: string; status: string }[];
}

export function regressions(committed: Rep, merged: Rep): string[] {
  const now = new Map(merged.targets.map((t) => [t.id, t.status] as const));
  const out: string[] = [];
  for (const t of committed.targets) {
    if (t.status !== 'passed') continue;
    const s = now.get(t.id);
    if (s !== 'passed')
      out.push(`${t.id}: passed in the committed report, ${s ?? 'missing'} in the merge`);
  }
  return out;
}

async function main(): Promise<void> {
  const [a, b] = process.argv.slice(2);
  if (a === undefined || b === undefined) {
    process.stderr.write(
      'usage: bun tools/behavior-regress-check.ts <committed.json> <merged.json>\n',
    );
    process.exit(2);
  }
  const bad = regressions(
    JSON.parse(await readFile(a, 'utf8')) as Rep,
    JSON.parse(await readFile(b, 'utf8')) as Rep,
  );
  if (bad.length > 0) {
    process.stderr.write(
      `behavior-regress-check: refusing, the merge loses passed targets:\n  ${bad.join('\n  ')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write('behavior-regress-check: no passed target is lost\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
