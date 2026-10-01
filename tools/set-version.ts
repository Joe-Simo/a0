// One release version, many files. Sets (or checks) the version in package.json, the Claude and
// Codex plugin manifests, gemini-extension.json, the VS Code extension, the Continue config, the
// MCP Bundle manifest, the server.json template and src/version.ts (what `a0 --version` prints).
//   bun tools/set-version.ts 0.8.16          set every file
//   bun tools/set-version.ts --check         every file carries the same version
//   bun tools/set-version.ts --check 0.8.16  every file carries exactly this version
// Edits replace only the version text, so the files keep their formatting.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface Site {
  readonly file: string;
  /** Matches the version once; group 1 is the text before it, group 2 the version, group 3 the text after. */
  readonly pattern: RegExp;
}

const V = '(\\d+\\.\\d+\\.\\d+)';
const jsonVersion = new RegExp(`^(\\{[\\s\\S]*?"version":\\s*")${V}(")`);
export const SITES: readonly Site[] = [
  { file: 'package.json', pattern: jsonVersion },
  { file: 'plugin/.claude-plugin/plugin.json', pattern: jsonVersion },
  { file: 'plugin/.codex-plugin/plugin.json', pattern: jsonVersion },
  { file: 'gemini-extension.json', pattern: jsonVersion },
  { file: 'editors/vscode/package.json', pattern: jsonVersion },
  { file: 'editors/vscode/package.json', pattern: new RegExp(`(--out a0-)${V}(\\.vsix)`) },
  { file: 'mcpb/manifest.json', pattern: jsonVersion },
  { file: 'server.json', pattern: jsonVersion },
  {
    file: 'integrations/continue.a0.yaml',
    pattern: new RegExp(`^(name: a0\\nversion: )${V}()`, 'm'),
  },
  { file: 'src/version.ts', pattern: new RegExp(`(A0_VERSION = ')${V}(')`) },
];

/** The repository root: the nearest ancestor of this file that holds a package.json. */
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('repository root not found');
    dir = up;
  }
  return dir;
}
const root = findRoot();

/** Every site with the version it carries now. */
export function readVersions(dir: string = root): { site: Site; version: string }[] {
  return SITES.map((site) => {
    const m = site.pattern.exec(readFileSync(join(dir, site.file), 'utf8'));
    const version = m?.[2];
    if (version === undefined) throw new Error(`${site.file}: version not found`);
    return { site, version };
  });
}

export function setVersion(version: string, dir: string = root): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`);
  for (const file of new Set(SITES.map((s) => s.file))) {
    const path = join(dir, file);
    let text = readFileSync(path, 'utf8');
    for (const site of SITES.filter((s) => s.file === file)) {
      if (!site.pattern.test(text)) throw new Error(`${file}: version not found`);
      text = text.replace(site.pattern, `$1${version}$3`);
    }
    writeFileSync(path, text);
  }
}

/** The mismatches against `expected` (default: the version of the first site), as messages. */
export function versionProblems(expected?: string, dir: string = root): string[] {
  const found = readVersions(dir);
  const want = expected ?? found[0]?.version;
  return found
    .filter((f) => f.version !== want)
    .map((f) => `${f.site.file}: ${f.version}, expected ${want}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [a, b] = process.argv.slice(2);
  if (a === '--check') {
    const problems = versionProblems(b?.replace(/^v/, ''));
    if (problems.length > 0) {
      process.stderr.write(`${problems.join('\n')}\n`);
      process.exit(1);
    }
    console.log(`all ${SITES.length} version sites agree: ${readVersions()[0]?.version}`);
  } else if (a !== undefined) {
    setVersion(a.replace(/^v/, ''));
    console.log(`set ${SITES.length} version sites to ${a.replace(/^v/, '')}`);
  } else {
    process.stderr.write('usage: set-version.ts <version> | --check [version]\n');
    process.exit(2);
  }
}
