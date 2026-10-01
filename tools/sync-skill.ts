// skills/a0 is the source of truth for the agent skill (the standard location skills.sh and
// other installers discover). The plugin ships a byte-identical copy in plugin/skills/a0.
//   bun tools/sync-skill.ts          copy skills/a0 over plugin/skills/a0
//   bun tools/sync-skill.ts --check  fail when the copy differs
import { cpSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'skills/a0');
const to = join(root, 'plugin/skills/a0');

function files(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

if (process.argv[2] === '--check') {
  const a = files(from).sort();
  const b = files(to).sort();
  const bad = [...new Set([...a, ...b])].filter(
    (f) =>
      !a.includes(f) ||
      !b.includes(f) ||
      !readFileSync(join(from, f)).equals(readFileSync(join(to, f))),
  );
  if (bad.length > 0) {
    console.error(
      `plugin/skills/a0 differs from skills/a0: ${bad.join(', ')} (run bun tools/sync-skill.ts)`,
    );
    process.exit(1);
  }
  console.log(`skill copies identical (${a.length} files)`);
} else {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log('plugin/skills/a0 updated from skills/a0');
}
