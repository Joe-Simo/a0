/** Candidate-only project initialization; no public reader switch. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { bundledPrimer, type InitReport, initFiles, PRIMER_PATH, PRIMER_URL } from './agents.js';
import { withPlaintextWrite } from './plaintext-write.js';
import { inventory } from './protection/disk.js';
import { ProtectionError } from './protection/errors.js';
import { parseSource } from './source.js';
import { SOURCE_EXAMPLES, SOURCE_GUIDE, SOURCE_STARTER } from './source-guide.js';
import { linkSource } from './source-link.js';

const COMMAND = 'node .a0/cli.mjs';
const MANIFEST = '.a0/init.json';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const conflict = () => new ProtectionError('INIT_CONFLICT_REVIEW_EXISTING_FILES');

async function read(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
}

async function safeParents(root: string, path: string): Promise<void> {
  const parts = relative(root, path).split(sep);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw conflict();
    } catch (e) {
      if (!missing(e)) throw e;
    }
  }
}

/** Supplied only by the standalone entrypoint, never inferred from a runtime filename. */
export interface SourceInvocation {
  readonly executable: string;
}

export async function initSourceProject(
  input: string,
  invocation?: SourceInvocation,
): Promise<InitReport> {
  let executable: string | undefined;
  if (invocation !== undefined) {
    if (!isAbsolute(invocation.executable)) throw new ProtectionError('INIT_INVALID_EXECUTABLE');
    executable = await realpath(invocation.executable);
    if (!(await stat(executable)).isFile()) throw new ProtectionError('INIT_INVALID_EXECUTABLE');
  }
  const absolute = resolve(input);
  await mkdir(absolute, { recursive: true });
  const root = await realpath(absolute);
  return withPlaintextWrite(root, async () => {
    const lock = join(root, '.a0-init-lock');
    try {
      await mkdir(lock);
    } catch {
      throw new ProtectionError('INIT_ACTIVE_OR_INTERRUPTED');
    }
    try {
      const existing = await inventory(root, [], (text, path) => {
        if (!path.endsWith('.a0'))
          throw new ProtectionError('INIT_LEGACY_SOURCE_REQUIRES_MIGRATION');
        return parseSource(text).uses ?? [];
      });
      if (existing.incompleteGraphs.length)
        throw new ProtectionError('INIT_SOURCE_REQUIRES_MIGRATION_OR_REPAIR');
      for (const item of existing.items) {
        if (item.role === 'source')
          await linkSource(join(root, item.path), (path) => readFile(path, 'utf8'), { root });
      }
      const launcher =
        executable === undefined
          ? `// Generated candidate frontend binding. Regenerate with the relocated compiler's source-cli.js init.\nimport ${JSON.stringify(new URL('./source-cli.js', import.meta.url).href)};\n`
          : `// Generated standalone frontend binding. Regenerate with the relocated executable's init command.\nimport { spawnSync } from 'node:child_process';\nconst result = spawnSync(${JSON.stringify(executable)}, process.argv.slice(2), { stdio: 'inherit', windowsHide: true });\nif (result.error) {\n  console.error(result.error.message);\n  process.exitCode = 1;\n} else if (result.signal) {\n  process.kill(process.pid, result.signal);\n} else {\n  process.exitCode = result.status ?? 1;\n}\n`;
      const guide =
        executable === undefined
          ? SOURCE_GUIDE
          : SOURCE_GUIDE.replace(
              'Compiler moved? Run node <compiler>/dist/src/source-cli.js init <project> to rebind.',
              'Compiler moved? Run the relocated executable with init <project> to rebind.',
            );
      const files = [
        ...initFiles(PRIMER_PATH, COMMAND),
        {
          path: '.vscode/settings.json',
          text:
            JSON.stringify(
              { 'a0.server.path': 'node', 'a0.server.args': ['.a0/cli.mjs'] },
              null,
              2,
            ) + '\n',
          merge: false,
        },
        { path: PRIMER_PATH, text: guide, merge: false },
        { path: '.a0/EXAMPLES.md', text: SOURCE_EXAMPLES, merge: false },
        { path: '.a0/cli.mjs', text: launcher, merge: false },
        { path: 'examples/a0-hello.a0', text: SOURCE_STARTER, merge: false },
      ];
      const manifestPath = join(root, MANIFEST);
      await safeParents(root, manifestPath);
      const raw = await read(manifestPath);
      const manifest =
        raw === undefined
          ? undefined
          : (JSON.parse(raw) as { format?: string; files?: Record<string, string> });
      if (manifest !== undefined && (manifest.format !== 'a0-source-init-1' || !manifest.files))
        throw conflict();
      const legacy = new Map<string, string[]>();
      for (const primer of [PRIMER_PATH, PRIMER_URL])
        for (const f of initFiles(primer))
          legacy.set(f.path, [...(legacy.get(f.path) ?? []), f.text]);
      const legacyPrimer = bundledPrimer();
      if (legacyPrimer) legacy.set(PRIMER_PATH, [await readFile(legacyPrimer, 'utf8')]);
      const changes: { path: string; before?: string; after: string }[] = [];
      const hashes: Record<string, string> = {};
      const skipped: string[] = [];
      for (const f of files) {
        const path = join(root, f.path);
        await safeParents(root, path);
        const before = await read(path);
        let after = f.text;
        if (before !== undefined && f.path === '.vscode/settings.json') {
          const current = JSON.parse(before) as Record<string, unknown>;
          if (typeof current !== 'object' || current === null || Array.isArray(current))
            throw conflict();
          const wanted = JSON.parse(f.text) as Record<string, unknown>;
          for (const [key, value] of Object.entries(wanted)) {
            const old = current[key];
            const legacy = key === 'a0.server.path' ? 'a0' : [];
            if (
              old !== undefined &&
              JSON.stringify(old) !== JSON.stringify(value) &&
              JSON.stringify(old) !== JSON.stringify(legacy)
            )
              throw conflict();
          }
          after = JSON.stringify({ ...current, ...wanted }, null, 2) + '\n';
        } else if (before !== undefined && before !== after) {
          const owned = manifest?.files?.[f.path] === hash(before);
          const old = legacy
            .get(f.path)
            ?.find((text) => (f.merge ? before.endsWith(text) : before === text));
          if (old !== undefined) after = f.merge ? before.slice(0, -old.length) + f.text : f.text;
          else if (owned)
            after = f.merge ? before.slice(0, before.indexOf('<!-- a0:init -->')) + f.text : f.text;
          else if (f.merge && !before.includes('<!-- a0:init -->'))
            after = `${before.replace(/\n*$/, '\n\n')}${f.text}`;
          else throw conflict();
        }
        hashes[f.path] = hash(after);
        if (before === after) skipped.push(f.path);
        else changes.push({ path, ...(before === undefined ? {} : { before }), after });
      }
      const manifestText = `${JSON.stringify({ format: 'a0-source-init-1', files: hashes }, null, 2)}\n`;
      if (raw !== manifestText)
        changes.push({
          path: manifestPath,
          ...(raw === undefined ? {} : { before: raw }),
          after: manifestText,
        });
      const applied: typeof changes = [];
      try {
        for (const change of changes) {
          await safeParents(root, change.path);
          if ((await read(change.path)) !== change.before) throw conflict();
          await mkdir(dirname(change.path), { recursive: true });
          await writeFile(change.path, change.after, {
            flag: change.before === undefined ? 'wx' : 'w',
          });
          applied.push(change);
        }
      } catch (e) {
        for (const change of applied.reverse()) {
          if ((await read(change.path)) !== change.after) continue;
          if (change.before === undefined) await rm(change.path);
          else await writeFile(change.path, change.before);
        }
        throw e;
      }
      return {
        written: changes.map((c) => relative(root, c.path).split(sep).join('/')),
        skipped,
        primer: PRIMER_PATH,
      };
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  });
}
