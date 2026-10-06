import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.js';
import { SYMLINKS } from './vpath.js';

const SOURCE =
  'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n\nfn f u32 -> u32\nb call sq p0\nc add b 1\nret c\nend\n';

async function connect(launch: string): Promise<Client> {
  const server = await createServer(launch);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; error: boolean }> {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text: string }[];
  return { text: content[0]?.text ?? '', error: r.isError === true };
}

async function withRoot(fn: (dir: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'a0-mcp-'));
  try {
    await mkdir(join(base, 'root'));
    await writeFile(join(base, 'root', 'm.a0'), SOURCE);
    await writeFile(join(base, 'outside.a0'), SOURCE);
    await fn(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('mcp: every tool over the in-memory transport', () =>
  withRoot(async (base) => {
    const client = await connect(join(base, 'root', 'm.a0'));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'a0_apply',
      'a0_check',
      'a0_emit',
      'a0_open',
      'a0_program',
      'a0_run',
      'a0_save',
    ]);

    const check = await call(client, 'a0_check', {});
    assert.match(check.text, /^sq \(u32\) -> u32: 1 nodes/m);

    assert.equal((await call(client, 'a0_run', { function: 'f', args: [3] })).text, '10');
    const noFuel = await call(client, 'a0_run', { function: 'f', args: [3], fuel: 1 });
    assert.ok(noFuel.error);
    assert.equal(JSON.parse(noFuel.text).code, 'limit');

    assert.match((await call(client, 'a0_emit', { target: 'js' })).text, /function/);

    const early = await call(client, 'a0_save', {});
    assert.ok(early.error);

    const view = await call(client, 'a0_open', { function: 'f' });
    const handle = view.text.split('\n')[0] ?? '';
    assert.match(handle, /^e[0-9]+$/);
    assert.match(view.text, /sq/);

    const bad = await call(client, 'a0_apply', { edit: `${handle}\nc add b zz` });
    assert.ok(bad.error);
    const diag = JSON.parse(bad.text) as Record<string, unknown>;
    for (const k of ['code', 'message', 'expected', 'actual', 'fix']) assert.ok(k in diag);

    const good = await call(client, 'a0_apply', { edit: `${handle}\nc add b 2` });
    assert.ok(!good.error, good.text);
    assert.match(good.text, /c add b 2/);
    assert.equal((await call(client, 'a0_run', { function: 'f', args: [3] })).text, '11');

    // a reply without a handle line edits the one open handle and returns that view, not the program
    const implied = await call(client, 'a0_apply', { edit: 'c add b 3' });
    assert.ok(!implied.error, implied.text);
    assert.equal(implied.text.split('\n')[0], handle);
    assert.match(implied.text, /c add b 3/);
    assert.equal(
      implied.text,
      good.text.replace('c add b 2', 'c add b 3'),
      'the view of the handle',
    );
    assert.equal((await call(client, 'a0_run', { function: 'f', args: [3] })).text, '12');
    await call(client, 'a0_apply', { edit: 'c add b 2' });

    const prog = await call(client, 'a0_program', { target: 'sq' });
    const g = prog.text.split('\n')[0] ?? '';
    assert.match(g, /^g[0-9]+$/);
    const added = await call(client, 'a0_apply', {
      edit: `${g}\nfn cube u32 -> u32\na call sq p0\nb mul a p0\nret b\nend`,
    });
    assert.ok(!added.error, added.text);
    assert.equal((await call(client, 'a0_run', { function: 'cube', args: [2] })).text, '8');

    const saved = await call(client, 'a0_save', {});
    assert.equal(saved.text, 'm.a0');
    const written = await readFile(join(base, 'root', 'm.a0'), 'utf8');
    assert.match(written, /c add b 2/);
    assert.match(written, /fn cube/);
    await client.close();
  }));

test('mcp: paths are confined to the root, symlink escapes included', { skip: SYMLINKS }, () =>
  withRoot(async (base) => {
    await symlink(join(base, 'outside.a0'), join(base, 'root', 'link.a0'));
    await symlink(join(base, 'gone.a0'), join(base, 'root', 'dangling.a0'));
    await writeFile(
      join(base, 'root', 'uses.a0'),
      'use "../outside.a0"\n\nfn g u32 -> u32\nret p0\nend\n',
    );
    const client = await connect(join(base, 'root'));
    const need = await call(client, 'a0_check', {});
    assert.ok(need.error);
    for (const file of ['../outside.a0', join(base, 'outside.a0'), 'link.a0', 'm.txt', 'uses.a0']) {
      const r = await call(client, 'a0_check', { file });
      assert.ok(r.error, file);
    }
    const view = await call(client, 'a0_open', { file: 'm.a0', function: 'f' });
    const handle = view.text.split('\n')[0] ?? '';
    await call(client, 'a0_apply', { file: 'm.a0', edit: `${handle}\nc add b 5` });
    for (const path of ['../escape.a0', 'dangling.a0', 'link.a0']) {
      const r = await call(client, 'a0_save', { file: 'm.a0', path });
      assert.ok(r.error, path);
    }
    await assert.rejects(readFile(join(base, 'escape.a0')));
    await assert.rejects(readFile(join(base, 'gone.a0')));
    assert.equal(await readFile(join(base, 'outside.a0'), 'utf8'), SOURCE);
    const ok = await call(client, 'a0_save', { file: 'm.a0', path: 'sub.a0' });
    assert.equal(ok.text, 'sub.a0');
    await client.close();
  }),
);

test(
  'mcp: diagnostics carry no host paths; an .a0 name must also resolve to an .a0 file',
  { skip: SYMLINKS },
  () =>
    withRoot(async (base) => {
      const root = join(base, 'root');
      await writeFile(join(root, 'bad.a0'), 'fn r u32 -> u32\na call r p0\nret a\nend\n');
      await writeFile(join(root, 'secret.env'), 'TOKEN=abc\n');
      await symlink(join(root, 'secret.env'), join(root, 'env.a0'));
      await mkdir(join(root, 'dir.a0'));
      const client = await connect(root);
      const bad = await call(client, 'a0_check', { file: 'bad.a0' });
      assert.ok(bad.error);
      assert.match(bad.text, /bad\.a0/);
      const view = await call(client, 'a0_open', { file: 'm.a0', function: 'f' });
      await call(client, 'a0_apply', {
        file: 'm.a0',
        edit: `${view.text.split('\n')[0] ?? ''}\nc add b 5`,
      });
      const dir = await call(client, 'a0_save', { file: 'm.a0', path: 'dir.a0' });
      assert.ok(dir.error);
      for (const r of [bad, dir]) {
        assert.ok(!r.text.includes(base), r.text);
        assert.ok(!r.text.includes('/private/'), r.text);
      }
      for (const r of [
        await call(client, 'a0_check', { file: 'env.a0' }),
        await call(client, 'a0_save', { file: 'm.a0', path: 'env.a0' }),
      ]) {
        assert.ok(r.error);
        assert.ok(!r.text.includes('TOKEN'), r.text);
      }
      assert.equal(await readFile(join(root, 'secret.env'), 'utf8'), 'TOKEN=abc\n');
      await client.close();
    }),
);

test('mcp: dense views, dense replies, and a dense file saved as dense', () =>
  withRoot(async (base) => {
    await writeFile(join(base, 'root', 'd.a0d'), 'fn sq mul A A\n\nfn f add sq A 1\n');
    const client = await connect(join(base, 'root'));
    // A .a0d file is dense by default.
    const view = await call(client, 'a0_open', { file: 'd.a0d', function: 'f' });
    assert.ok(!view.error, view.text);
    assert.equal(view.text.split('\n').slice(1).join('\n'), 'fn f add sq A 1\n# sq u32 -> u32');
    const handle = view.text.split('\n')[0] ?? '';
    const edit = await call(client, 'a0_apply', {
      file: 'd.a0d',
      edit: `${handle}\nfn f add sq A 2`,
    });
    assert.ok(!edit.error, edit.text);
    assert.equal(
      (await call(client, 'a0_run', { file: 'd.a0d', function: 'f', args: [3] })).text,
      '11',
    );
    const prog = await call(client, 'a0_program', { file: 'd.a0d' });
    assert.equal(prog.text.split('\n').slice(1).join('\n'), '# sq u32 -> u32\n# f u32 -> u32');
    assert.equal((await call(client, 'a0_save', { file: 'd.a0d' })).text, 'd.a0d');
    assert.equal(
      await readFile(join(base, 'root', 'd.a0d'), 'utf8'),
      'fn sq mul A A\n\nfn f add sq A 2\n',
    );
    // lean: no handle line; a reply without one edits the one open function
    await writeFile(join(base, 'root', 'l.a0d'), 'fn sq mul A A\n\nfn f add sq A 1\n');
    const lean = await call(client, 'a0_open', { file: 'l.a0d', function: 'f', lean: true });
    assert.ok(!lean.error, lean.text);
    assert.equal(lean.text, 'fn f add sq A 1\n# sq u32 -> u32');
    const leanEdit = await call(client, 'a0_apply', { file: 'l.a0d', edit: 'fn f add sq A 3' });
    assert.ok(!leanEdit.error, leanEdit.text);
    assert.equal(
      (await call(client, 'a0_run', { file: 'l.a0d', function: 'f', args: [3] })).text,
      '12',
    );
    // scope bodies: the direct callees' dense text instead of their signature lines
    const bodies = await call(client, 'a0_open', {
      file: 'l.a0d',
      function: 'f',
      scope: 'bodies',
      lean: true,
    });
    assert.equal(bodies.text, 'fn f add sq A 3\nfn sq mul A A');
    // A canonical file can still be viewed and edited dense on request; it saves as canonical.
    const v2 = await call(client, 'a0_open', { file: 'm.a0', function: 'f', dense: true });
    assert.match(v2.text, /^e[0-9]+\nfn f\nb sq A\nc add b 1\n# sq u32 -> u32$/);
    const h2 = v2.text.split('\n')[0] ?? '';
    const e2 = await call(client, 'a0_apply', { file: 'm.a0', edit: `${h2}\nfn f add sq A 5` });
    assert.ok(!e2.error, e2.text);
    assert.equal(
      (await call(client, 'a0_run', { file: 'm.a0', function: 'f', args: [2] })).text,
      '9',
    );
    await call(client, 'a0_save', { file: 'm.a0' });
    assert.match(await readFile(join(base, 'root', 'm.a0'), 'utf8'), /^fn sq u32 -> u32\n/);
    await client.close();
  }));

test('mcp: a rejected edit carries id, fix and applicability, and `fix all` applies the exact fixes', () =>
  withRoot(async (base) => {
    const client = await connect(join(base, 'root', 'm.a0'));
    const view = await call(client, 'a0_open', { function: 'f' });
    const handle = view.text.split('\n')[0] ?? '';
    const bad = await call(client, 'a0_apply', { edit: `${handle}\nc ADD b, 0x2` });
    assert.ok(bad.error);
    const diag = JSON.parse(bad.text) as Record<string, unknown>;
    assert.equal(diag.code, 'parse', 'the coarse class is unchanged');
    assert.equal(diag.id, 'A0011');
    assert.equal(diag.applicability, 'exact');
    assert.ok(Array.isArray(diag.edits) && diag.edits.length === 1);
    assert.match(String(diag.fix), /add/);
    // The next reply is `fix all`: both exact fixes land, atomically, and the program runs.
    const fixed = await call(client, 'a0_apply', { edit: `${handle}\nfix all` });
    assert.ok(!fixed.error, fixed.text);
    assert.equal((await call(client, 'a0_run', { function: 'f', args: [3] })).text, '11');
    // With nothing rejected, `fix all` is itself a diagnostic.
    const again = await call(client, 'a0_apply', { edit: 'fix all' });
    assert.ok(again.error);
    assert.equal((JSON.parse(again.text) as { id: string }).id, 'A0521');
    // A suggestion is `maybe` and names the candidate.
    const typo = await call(client, 'a0_apply', { edit: `${handle}\nc mull b 2` });
    const t = JSON.parse(typo.text) as { id: string; applicability: string; fix: string };
    assert.deepEqual([t.id, t.applicability], ['A0102', 'maybe']);
    assert.equal(t.fix, "did you mean 'mul'?");
    await client.close();
  }));

test('mcp: spec lines round trip, specs hide, and a rejected edit names the example it broke', () =>
  withRoot(async (base) => {
    const root = join(base, 'root');
    const SPEC = 'fn f u32 -> u32\nex 1 -> 2\npre lt p0 100\na add p0 1\nret a\nend\n';
    await writeFile(join(root, 's.a0'), SPEC);
    const client = await connect(root);
    const shown = await call(client, 'a0_open', { file: 's.a0', function: 'f' });
    assert.match(shown.text, /^ex 1 -> 2$/m);
    assert.match(shown.text, /^pre lt p0 100$/m);
    const hidden = await call(client, 'a0_open', { file: 's.a0', function: 'f', specs: 'hide' });
    assert.ok(!hidden.error, hidden.text);
    assert.doesNotMatch(hidden.text, /^(ex|pre) /m);
    const handle = shown.text.split('\n')[0] ?? '';

    // A change that breaks the example is rejected whole, with the example it broke.
    const bad = await call(client, 'a0_apply', { file: 's.a0', edit: `${handle}\na add p0 2` });
    assert.ok(bad.error);
    const d = JSON.parse(bad.text) as {
      id: string;
      spec: Record<string, unknown>;
      fix: string;
    };
    assert.equal(d.id, 'A0715');
    assert.deepEqual(d.spec, {
      function: 'f',
      ex: 1,
      line: 'ex',
      input: '1',
      expected: '2',
      actual: '3',
    });
    assert.match(d.fix, /ex 1 -> 3/);
    // Nothing changed: the program still runs as before.
    const ran = await call(client, 'a0_run', { file: 's.a0', function: 'f', args: [4] });
    assert.equal(ran.text, '5');

    // An example added with the wrong value is rejected too; the right one lands.
    const wrong = await call(client, 'a0_apply', { file: 's.a0', edit: `${handle}\n+ex 5 -> 9` });
    assert.ok(wrong.error);
    assert.equal((JSON.parse(wrong.text) as { spec: { actual: string } }).spec.actual, '6');
    const added = await call(client, 'a0_apply', { file: 's.a0', edit: `${handle}\n+ex 5 -> 6` });
    assert.ok(!added.error, added.text);
    assert.match(added.text, /^ex 5 -> 6$/m);

    // A rewrite that carries no spec lines keeps them when the view hid them.
    const view = await call(client, 'a0_open', { file: 's.a0', function: 'f', specs: 'hide' });
    const hh = view.text.split('\n')[0] ?? '';
    const swapped = await call(client, 'a0_apply', {
      file: 's.a0',
      edit: `${hh}\nfn f u32 -> u32\nb add 1 p0\nret b\nend`,
    });
    assert.ok(!swapped.error, swapped.text);
    await call(client, 'a0_save', { file: 's.a0' });
    const saved = await readFile(join(root, 's.a0'), 'utf8');
    assert.match(saved, /^fn f u32 -> u32\nex 1 -> 2\nex 5 -> 6\npre lt p0 100\n/);

    // A file whose own example is wrong is rejected at open, with the same fields.
    await writeFile(join(root, 't.a0'), SPEC.replace('ex 1 -> 2', 'ex 1 -> 3'));
    const opened = await call(client, 'a0_open', { file: 't.a0', function: 'f' });
    assert.ok(opened.error);
    const o = JSON.parse(opened.text) as { id: string; message: string; spec: { ex: number } };
    assert.equal(o.id, 'A0715');
    assert.equal(o.spec.ex, 1);
    assert.match(o.message, /t\.a0:2: /, 'the diagnostic points at the ex line');
    await client.close();
  }));
