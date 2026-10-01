// The repository is public: tracked files carry no local paths, no session identifiers, no
// credentials and no editor or agent state. The patterns are spelled so that this file does not
// match itself.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reportJson, scrubText } from '../tools/scrub-results.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function tracked(): string[] | undefined {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return undefined; // not a git checkout (a source archive): nothing to enumerate
  }
}

const files = tracked();
const skip = files === undefined ? 'not a git checkout' : false;

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![0-9a-f])';
const LOCAL: readonly [string, RegExp][] = [
  ['home directory', /\/(?:Users|home)\/(?!Shared\/)[A-Za-z0-9._-]+\//],
  ['private temp directory', /\/private\/tm[p]\b/],
  ['per-user temp directory', /\/var\/fol[d]ers\b/],
  ['agent sandbox user', /claude-\d{3,}/],
  ['session id inside a path', new RegExp(`\\/${UUID}(?:\\/|\\b)`)],
  ['agent worktree', /\.claude\/worktrees\/|agent-[0-9a-f]{16}/],
];

const FORBIDDEN_NAME: readonly [string, RegExp][] = [
  ['session handoff notes', /(?:^|\/)HANDOF[F]\.[a-z]+$/],
  ['environment file', /(?:^|\/)\.env(?:\..*)?$/],
  [
    'key or certificate file',
    /\.(?:pem|key|p12|pfx|keystore|jks)$|(?:^|\/)id_(?:rsa|ed25519|ecdsa)/,
  ],
  [
    'editor or agent local state',
    /(?:^|\/)(?:\.claude|\.codex|\.cursor|\.idea|\.playwright-mcp|\.a0-cache|\.a0-tmp)\/|^\.vscode\/|(?:^|\/)settings\.local\.json$|(?:^|\/)\.DS_Store$/,
  ],
];

function isText(buf: Buffer): boolean {
  return !buf.subarray(0, 8000).includes(0);
}

test('hygiene: no tracked file name is personal or local state', { skip }, () => {
  const bad: string[] = [];
  for (const f of files ?? []) {
    for (const [what, rx] of FORBIDDEN_NAME) if (rx.test(f)) bad.push(`${f} (${what})`);
  }
  assert.deepEqual(bad, []);
});

test('hygiene: no tracked file contains a local path or session identifier', { skip }, () => {
  const bad: string[] = [];
  for (const f of files ?? []) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, f));
    } catch {
      continue; // listed but absent from the working tree (a deletion not yet staged)
    }
    if (!isText(buf)) continue;
    const text = buf.toString('utf8');
    for (const [what, rx] of LOCAL) {
      const m = rx.exec(text);
      if (m) bad.push(`${f}: ${what} (${m[0].slice(0, 40)})`);
    }
  }
  assert.deepEqual(bad.slice(0, 20), []);
});

// Private names (another private project, a vendor, the maintainer's account name) cannot be
// written into a public test. A maintainer keeps them in a local file, one regular expression per
// line (`#` starts a comment), and points A0_PUBLIC_DENYLIST at it; the test is skipped without it.
// A hit is reported as file, line and denylist line number only, never as the term.
const denyPath = process.env.A0_PUBLIC_DENYLIST;
const denySkip =
  skip !== false
    ? skip
    : denyPath === undefined || !existsSync(denyPath)
      ? 'A0_PUBLIC_DENYLIST names no file'
      : false;

test('hygiene: no tracked file contains a term from the local denylist', { skip: denySkip }, () => {
  const rules = readFileSync(denyPath ?? '', 'utf8')
    .split('\n')
    .map((text, i): [number, string] => [i + 1, text])
    .filter(([, text]) => text.trim() !== '' && !/^\s*#/.test(text))
    .map(([n, text]): [number, RegExp] => [n, new RegExp(text, 'i')]);
  const bad: string[] = [];
  for (const f of files ?? []) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, f));
    } catch {
      continue;
    }
    if (!isText(buf)) continue;
    buf
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const [n, rx] of rules)
          if (rx.test(line)) bad.push(`${f}:${i + 1} (denylist line ${n})`);
      });
  }
  assert.deepEqual(bad.slice(0, 20), []);
});

test('scrub: local paths become placeholders, text and numbers stay, and it is idempotent', () => {
  const home = ['', 'Users', 'alice'].join('/');
  const tmp = ['', 'private', 'var', 'folders', 'ab', 'cdef0123', 'T'].join('/');
  const scratch = [
    '',
    'private',
    'tmp',
    ['claude', '501'].join('-'),
    '-repo',
    '<id>',
    'scratchpad',
    'g10',
    'set-a.json',
  ].join('/');
  const worktree = [
    home,
    'Downloads',
    'a0',
    '.claude',
    'worktrees',
    ['agent', '0123456789abcdef'].join('-'),
  ].join('/');
  const sample = {
    n: 3.25,
    ok: true,
    reply: `fail at ${tmp}/a0-Xy12/mod.ts(4,2): bad; ${worktree}/src/core.ts; ${home}/notes; ${scratch}`,
  };
  const out = reportJson(sample);
  const back = JSON.parse(out) as typeof sample;
  assert.equal(back.n, 3.25);
  assert.equal(back.ok, true);
  assert.equal(
    back.reply,
    'fail at <tmp>/a0-Xy12/mod.ts(4,2): bad; <repo>/src/core.ts; <home>/notes; <tmp>/set-a.json',
  );
  assert.equal(scrubText(out), out);
  for (const [, rx] of LOCAL) assert.ok(!rx.test(out));
  // a cut-short temp prefix and a relative climb to it are covered too
  const cut = `${['..', '..', '..'].join('/')}${['', 'var', 'fold'].join('/')}`;
  assert.equal(scrubText(`x ${cut}`), 'x <tmp>');
});
