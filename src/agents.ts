/**
 * Agent integration: `a0 init` (instruction and rule files for coding agents) and `a0 hook`
 * (the after-edit check that Claude Code PostToolUse and Gemini CLI AfterTool hooks run).
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDiagnostic, type TypedProgram } from './core.js';

export const PRIMER_URL = 'https://github.com/Joe-Simo/a0/blob/main/MODEL_GUIDE.txt';
/** Where `a0 init` copies the primer inside a project. */
export const PRIMER_PATH = '.a0/MODEL_GUIDE.txt';
const MARKER = '<!-- a0:init -->';

export function agentsMd(primer: string): string {
  return `${MARKER}
## A0 (\`*.a0\` files)

A0 is a language written by AI agents. Read the primer before touching \`*.a0\`: \`${primer}\`.

- Edit A0 through the a0 MCP tools, not as free text: \`a0_open\` (function view with a handle) or
  \`a0_program\` (program handle), then \`a0_apply\` with the handle line followed by edit lines,
  then \`a0_save\` only after a successful apply. Start the server with \`a0 mcp .\`.
- Edit protocol: reply with the shown handle line, then edit lines. Under a function handle,
  \`id op ...\` replaces or inserts before \`ret\`, \`id op ... @ other\` inserts after \`other\`,
  \`-id\` deletes, \`ret x\` sets the result. Under a program handle, whole \`fn ... end\` blocks add or
  replace functions and \`-fn name\` removes one.
- A diagnostic carries a code, expected/actual, and a \`fix:\`. Apply the fix exactly, then retry.
- After any \`*.a0\` change run \`a0 check <file>\` and do not stop while it reports an error.
  \`a0 run <file> <fn> <args...>\` runs the reference interpreter; \`a0 emit <target> <file>\` compiles.
`;
}

const POINTER = `${MARKER}\n@AGENTS.md\n\nA0 agent instructions are in AGENTS.md; read it before editing \`*.a0\` files.\n`;

function ruleBody(primer: string): string {
  return `Before editing \`*.a0\` files read \`${primer}\` and AGENTS.md. Prefer the a0 MCP tools
(\`a0_open\`/\`a0_program\` -> \`a0_apply\` -> \`a0_save\`). After every \`*.a0\` edit run
\`a0 check <file>\`; if it prints \`error: <code>: ... fix: ...\`, apply that fix and check again
until it passes.
`;
}

/** Files `a0 init` writes, relative to the project root. `merge` files get a section appended. */
export function initFiles(primer: string): { path: string; text: string; merge: boolean }[] {
  const rule = ruleBody(primer);
  return [
    { path: 'AGENTS.md', text: agentsMd(primer), merge: true },
    { path: 'CLAUDE.md', text: POINTER, merge: true },
    { path: 'GEMINI.md', text: POINTER, merge: true },
    {
      path: '.cursor/rules/a0.mdc',
      text: `---\ndescription: A0 language edit protocol and after-edit check\nglobs: **/*.a0\nalwaysApply: false\n---\n${rule}`,
      merge: false,
    },
    {
      path: '.windsurf/rules/a0.md',
      text: `---\ntrigger: glob\nglobs: **/*.a0\n---\n${rule}`,
      merge: false,
    },
    {
      path: '.github/instructions/a0.instructions.md',
      text: `---\napplyTo: "**/*.a0"\n---\n${rule}`,
      merge: false,
    },
    {
      path: '.gemini/settings.json',
      text: `${JSON.stringify(
        {
          hooks: {
            AfterTool: [
              {
                matcher: 'write_file|replace',
                hooks: [{ name: 'a0-check', type: 'command', command: 'a0 hook', timeout: 30000 }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      merge: false,
    },
  ];
}

/** The primer shipped next to the compiler (repo checkout), if present. */
function bundledPrimer(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '..', 'MODEL_GUIDE.txt'), join(here, '..', '..', 'MODEL_GUIDE.txt')])
    if (existsSync(p)) return p;
  return undefined;
}

export interface InitReport {
  written: string[];
  skipped: string[];
  primer: string;
}

/**
 * Write agent instruction files into `root`. Existing AGENTS.md/CLAUDE.md/GEMINI.md get the A0
 * section appended once; other existing files are left untouched.
 */
export async function init(root: string): Promise<InitReport> {
  const written: string[] = [];
  const skipped: string[] = [];
  const source = bundledPrimer();
  let primer = PRIMER_URL;
  if (source !== undefined) {
    const dest = join(root, PRIMER_PATH);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(source, 'utf8'), 'utf8');
    written.push(PRIMER_PATH);
    primer = PRIMER_PATH;
  }
  for (const f of initFiles(primer)) {
    const dest = join(root, f.path);
    if (existsSync(dest)) {
      const old = await readFile(dest, 'utf8');
      if (!f.merge || old.includes(MARKER)) {
        skipped.push(f.path);
        continue;
      }
      await writeFile(dest, `${old.replace(/\n*$/, '\n\n')}${f.text}`, 'utf8');
    } else {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.text, 'utf8');
    }
    written.push(f.path);
  }
  return { written, skipped, primer };
}

interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  tool_input?: { file_path?: string; path?: string };
}

/**
 * Handle one hook invocation (Claude Code PostToolUse or Gemini CLI AfterTool): stdin JSON in,
 * JSON out. Returns undefined when the edited file is not A0 or checks cleanly; otherwise the
 * blocking response whose `reason` gives the agent the exact diagnostic and fix.
 */
export async function hookResponse(
  input: string,
  load: (path: string) => Promise<TypedProgram>,
): Promise<string | undefined> {
  const event = JSON.parse(input) as HookInput;
  const file = event.tool_input?.file_path ?? event.tool_input?.path;
  if (file === undefined || !file.endsWith('.a0')) return undefined;
  const path = resolve(event.cwd ?? process.cwd(), file);
  try {
    await load(path);
    return undefined;
  } catch (err) {
    const diagnostic = formatDiagnostic(err);
    const reason = `a0 check ${file} failed: error: ${diagnostic}\nApply the fix above to ${file} and re-run a0 check until it passes.`;
    const hookEventName = event.hook_event_name ?? 'PostToolUse';
    const hookSpecificOutput = { hookEventName, additionalContext: reason };
    // Gemini CLI AfterTool: `decision: "deny"` would hide the tool result, so the diagnostic is
    // appended as additionalContext only. Claude Code PostToolUse: `decision: "block"` feeds
    // `reason` back to the model.
    if (hookEventName === 'AfterTool') return JSON.stringify({ hookSpecificOutput });
    return JSON.stringify({ decision: 'block', reason, hookSpecificOutput });
  }
}
