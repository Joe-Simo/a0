import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findClang, findGcc } from '../src/toolchain.js';
import { buildNativeCheck } from '../tools/native-check.js';

// The launcher of tools/native/a0.c: the native `a0` with the full command line (a0-cli.js) beside
// it answers `a0 check FILE.a0` itself when the program is accepted and hands everything else to
// the command line, so every command prints and exits as `node dist/src/cli.js` does.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(root, 'dist', 'src', 'cli.js');
const skip =
  (findClang().path ?? findGcc().path) === undefined
    ? 'no C compiler (clang or gcc) on this machine'
    : false;

test('native launcher: every command prints the same bytes and exits the same as the node CLI', {
  skip,
  timeout: 600_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0-launch-'));
  try {
    const { exe: built } = await buildNativeCheck({ dir: join(dir, 'native') });
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const a0 = join(bin, process.platform === 'win32' ? 'a0.exe' : 'a0');
    copyFileSync(built, a0);
    writeFileSync(
      join(bin, 'a0-cli.js'),
      `await import(${JSON.stringify(pathToFileURL(cli).href)});\n`,
    );
    const ok = 'fn f u32 -> u32\na add p0 1\nret a\nend\n';
    writeFileSync(join(dir, 'ok.a0'), ok);
    writeFileSync(join(dir, 'bad.a0'), 'fn f u32 -> u32\na add p0 true\nret a\nend\n');
    writeFileSync(join(dir, 'spec.a0'), 'fn f u32 -> u32\nex 1 -> 2\na add p0 1\nret a\nend\n');
    writeFileSync(join(dir, 'with space.a0'), ok);
    // a rejected program whose path the hand-over must quote
    writeFileSync(join(dir, "bad 'q' space.a0"), 'fn f u32 -> u32\nret p1\nend\n');
    const files = [
      join(dir, 'ok.a0'),
      join(dir, 'bad.a0'),
      join(dir, 'spec.a0'),
      join(dir, 'with space.a0'),
      join(dir, "bad 'q' space.a0"),
      join(dir, 'missing.a0'),
      join(root, 'compiler', 'lex.a0'),
      join(root, 'compiler', 'check.a0'),
      join(root, 'examples', 'life.a0'),
    ];
    const viaLauncher = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(a0, args, {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        maxBuffer: 1 << 26,
        cwd: dir,
      });
    const viaNode = (args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        maxBuffer: 1 << 26,
        cwd: dir,
      });
    const same = (args: string[]) => {
      const reference = viaNode(args);
      const r = viaLauncher(args);
      const label = args.join(' ');
      assert.equal(r.status, reference.status, label);
      assert.equal(r.stdout, reference.stdout, label);
      assert.equal(r.stderr, reference.stderr, label);
      return reference;
    };
    for (const file of files) same(['check', file]);
    assert.equal(same(['check', files[0] as string]).status, 0);
    assert.equal(same(['check', files[1] as string]).status, 1);
    // flags, several files and other commands go to the command line
    same(['--version']);
    same([]);
    same(['check', '--json', files[1] as string]);
    same(['check', files[0] as string, files[1] as string]);
    same(['revision', files[0] as string, 'f']);
    same(['view', files[0] as string, 'f']);
    same(['run', files[0] as string, 'f', '41']);
    same(['dense', files[0] as string]);
    writeFileSync(join(dir, 'p.patch'), 'fn f u32 -> u32\na add p0 2\nret a\nend\n');
    same(['patch', files[0] as string, join(dir, 'p.patch')]);
    // --fix writes the file: each side on its own copy of a fixable program
    const fixable = 'fn f u32 -> u32\na add p0 1\nret a\nend\n\n\n';
    for (const side of ['node', 'launcher'] as const) {
      const f = join(dir, `fix-${side}.a0`);
      writeFileSync(f, fixable);
      const r =
        side === 'node' ? viaNode(['check', '--fix', f]) : viaLauncher(['check', '--fix', f]);
      assert.equal(r.status, 0, `${side}: ${r.stderr}`);
    }
    assert.equal(
      readFileSync(join(dir, 'fix-launcher.a0'), 'utf8'),
      readFileSync(join(dir, 'fix-node.a0'), 'utf8'),
    );
    // an accepted check never starts node: it answers with no node to start
    const noNode = { A0_NODE: join(dir, 'no-such-node') };
    const accepted = viaLauncher(['check', files[0] as string], noNode);
    assert.equal(accepted.status, 0);
    assert.equal(accepted.stdout, viaNode(['check', files[0] as string]).stdout);
    assert.notEqual(viaLauncher(['check', files[1] as string], noNode).status, 0);
    // A0_CLI=0: the native driver as before (its own `check` output)
    assert.equal(viaLauncher(['check', files[0] as string], { A0_CLI: '0' }).stdout, 'ok\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
