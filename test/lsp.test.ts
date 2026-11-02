import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { compile } from '../src/backends.js';
import { programRevision } from '../src/edit.js';
import { linkSource } from '../src/source-link.js';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.js');
const LIB = 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n';
const MAIN = 'use "lib.a0"\n\nfn f u32 -> u32\nb call sq p0\nc add b 1\nret c\nend\n';

interface Published {
  uri: string;
  diagnostics: {
    code?: string;
    message: string;
    range: { start: { line: number } };
    data?: {
      id: string | null;
      code: string;
      fix: string | null;
      applicability: string | null;
      edits: unknown[];
      spec?: unknown;
    };
  }[];
}

interface Session {
  conn: MessageConnection;
  proc: ChildProcessWithoutNullStreams;
  /** Resolves with the next diagnostics published for `uri`. */
  next(uri: string): Promise<Published>;
}

async function start(root: string, candidate = false, snippets = false): Promise<Session> {
  const script = `import {serveLsp} from ${JSON.stringify(new URL('../src/lsp.js', import.meta.url).href)};import {sourceLspFrontend} from ${JSON.stringify(new URL('../src/lsp-frontend.js', import.meta.url).href)};await serveLsp(${JSON.stringify(root)},sourceLspFrontend);`;
  const proc = spawn(
    process.execPath,
    candidate ? ['--input-type=module', '-e', script] : [CLI, 'lsp', root, '--stdio'],
  );
  const conn = createMessageConnection(
    new StreamMessageReader(proc.stdout),
    new StreamMessageWriter(proc.stdin),
  );
  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const waiting = new Map<string, ((p: Published) => void)[]>();
  conn.onNotification('textDocument/publishDiagnostics', (p: Published) => {
    const queue = waiting.get(p.uri) ?? [];
    queue.shift()?.(p);
  });
  conn.listen();
  await conn.sendRequest('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    capabilities: snippets
      ? { textDocument: { completion: { completionItem: { snippetSupport: true } } } }
      : {},
  });
  await conn.sendNotification('initialized', {});
  return {
    conn,
    proc,
    next: (uri) =>
      new Promise((res, rej) => {
        const queue = waiting.get(uri) ?? [];
        queue.push(res);
        waiting.set(uri, queue);
        proc.once('exit', (code) => rej(new Error(`server exited (${code}): ${stderr}`)));
      }),
  };
}

async function stop(s: Session): Promise<void> {
  await s.conn.sendRequest('shutdown');
  await s.conn.sendNotification('exit');
  s.conn.dispose();
  await new Promise((res) => (s.proc.exitCode === null ? s.proc.once('exit', res) : res(null)));
}

async function withRoot(fn: (base: string, root: string) => Promise<void>): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'a0-lsp-')));
  try {
    const root = join(base, 'root');
    await mkdir(root);
    await writeFile(join(root, 'lib.a0'), LIB);
    await writeFile(join(root, 'main.a0'), MAIN);
    await writeFile(join(base, 'outside.a0'), LIB);
    await fn(base, root);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const open = async (s: Session, uri: string, text: string): Promise<Published> => {
  const pending = s.next(uri);
  await s.conn.sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId: 'a0', version: 1, text },
  });
  return pending;
};

test('source LSP example quick fixes remain executable in the selected grammar', () =>
  withRoot(async (_base, root) => {
    const s = await start(root, true);
    try {
      const uri = pathToFileURL(join(root, 'repair.a0')).href;
      const text = 'fn f _x2 -> _x2\nex [1 2] -> [2 1] # retain this comment\nret A\nend\n';
      await writeFile(join(root, 'repair.a0'), text);
      const [diagnostic] = (await open(s, uri, text)).diagnostics;
      assert.equal(diagnostic?.data?.id, 'A0715');
      assert.match(diagnostic?.message ?? '', /input \[1 2\], expected \[2 1\], got \[1 2\]/);
      assert.deepEqual(diagnostic?.data?.spec, {
        function: 'f',
        ex: 1,
        line: 'ex',
        input: '[1 2]',
        expected: '[2 1]',
        actual: '[1 2]',
      });
      const actions = await s.conn.sendRequest<
        { title: string; edit: { changes: Record<string, { newText: string }[]> } }[]
      >('textDocument/codeAction', {
        textDocument: { uri },
        range: diagnostic?.range,
        context: { diagnostics: [diagnostic] },
      });
      assert.equal(actions.length, 1);
      const replacement = actions[0]?.edit.changes[uri]?.[0]?.newText;
      assert.equal(replacement, 'ex [1 2] -> [1 2] # retain this comment');
      assert.equal(actions[0]?.title, 'Change the expected result to [1 2]');
      assert.deepEqual(
        (
          await change(
            s,
            uri,
            2,
            text.replace(text.split('\n')[1] as string, replacement as string),
          )
        ).diagnostics,
        [],
      );
    } finally {
      await stop(s);
    }
  }));

test('lsp: diagnostics, hover, definition, symbols, completion, formatting over stdio', () =>
  withRoot(async (base, root) => {
    const s = await start(root);
    try {
      const main = pathToFileURL(join(root, 'main.a0')).href;
      const lib = pathToFileURL(join(root, 'lib.a0')).href;
      const doc = { textDocument: { uri: main } };

      assert.deepEqual((await open(s, main, MAIN)).diagnostics, []);

      // A type error on line 5 (0-based 4): code and fix from the checker.
      const broken = MAIN.replace('c add b 1', 'c add b true');
      const pending = s.next(main);
      await s.conn.sendNotification('textDocument/didChange', {
        textDocument: { uri: main, version: 2 },
        contentChanges: [{ text: broken }],
      });
      const [diag] = (await pending).diagnostics;
      assert.equal(diag?.code, 'type');
      assert.equal(diag?.range.start.line, 4);
      assert.ok(!diag?.message.includes(root), 'host paths are not reported');

      const fixed = s.next(main);
      await s.conn.sendNotification('textDocument/didChange', {
        textDocument: { uri: main, version: 3 },
        contentChanges: [{ text: MAIN }],
      });
      assert.deepEqual((await fixed).diagnostics, []);

      const hoverFn = await s.conn.sendRequest<{ contents: { value: string } }>(
        'textDocument/hover',
        { ...doc, position: { line: 3, character: 8 } },
      );
      assert.equal(hoverFn.contents.value, '`fn sq u32 -> u32`');
      const hoverOp = await s.conn.sendRequest<{ contents: { value: string } }>(
        'textDocument/hover',
        { ...doc, position: { line: 4, character: 3 } },
      );
      assert.match(hoverOp.contents.value, /^add a b/);

      const def = await s.conn.sendRequest<{ uri: string; range: { start: { line: number } } }>(
        'textDocument/definition',
        { ...doc, position: { line: 3, character: 8 } },
      );
      assert.equal(def.uri, lib);
      assert.equal(def.range.start.line, 0);

      const symbols = await s.conn.sendRequest<{ name: string; detail: string }[]>(
        'textDocument/documentSymbol',
        doc,
      );
      assert.deepEqual(
        symbols.map((x) => [x.name, x.detail]),
        [['f', 'fn f u32 -> u32']],
      );

      const items = await s.conn.sendRequest<{ label: string }[]>('textDocument/completion', {
        ...doc,
        position: { line: 4, character: 2 },
      });
      const labels = items.map((i) => i.label);
      for (const l of ['add', 'fold', 'udiv', 'sq', 'f']) assert.ok(labels.includes(l), l);
      assert.equal(labels.includes('<<'), false, 'legacy CLI completion is unchanged');

      const messy =
        '# lib first\nuse "lib.a0"\n# square it\nfn f   u32 -> u32   # comment\n  b sq p0 # via lib\nret b\nend\n# tail';
      await s.conn.sendNotification('textDocument/didChange', {
        textDocument: { uri: main, version: 4 },
        contentChanges: [{ text: messy }],
      });
      const edits = await s.conn.sendRequest<{ newText: string }[]>('textDocument/formatting', {
        ...doc,
        options: { tabSize: 2, insertSpaces: true },
      });
      assert.equal(
        edits[0]?.newText,
        '# lib first\nuse "lib.a0"\n\n# square it\nfn f u32 -> u32 # comment\nb call sq p0 # via lib\nret b\nend\n\n# tail\n',
      );
      // Formatting is idempotent: the formatted text needs no further edit.
      await s.conn.sendNotification('textDocument/didChange', {
        textDocument: { uri: main, version: 5 },
        contentChanges: [{ text: edits[0]?.newText ?? '' }],
      });
      assert.deepEqual(
        await s.conn.sendRequest('textDocument/formatting', {
          ...doc,
          options: { tabSize: 2, insertSpaces: true },
        }),
        [],
      );

      // Outside the root: one limit diagnostic, no other service.
      const outside = pathToFileURL(join(base, 'outside.a0')).href;
      const [out] = (await open(s, outside, LIB)).diagnostics;
      assert.equal(out?.code, 'limit');
      assert.deepEqual(
        await s.conn.sendRequest('textDocument/documentSymbol', {
          textDocument: { uri: outside },
        }),
        [],
      );
    } finally {
      await stop(s);
    }
  }));

test('lsp: a use escaping the root is rejected', () =>
  withRoot(async (_base, root) => {
    const s = await start(root);
    try {
      const uri = pathToFileURL(join(root, 'esc.a0')).href;
      await writeFile(join(root, 'esc.a0'), '');
      const text = 'use "../outside.a0"\n\nfn g u32 -> u32\nb call sq p0\nret b\nend\n';
      const [diag] = (await open(s, uri, text)).diagnostics;
      assert.equal(diag?.code, 'structure');
      assert.match(diag?.message ?? '', /inside the project root/);
      const def = await s.conn.sendRequest('textDocument/definition', {
        textDocument: { uri },
        position: { line: 3, character: 8 },
      });
      assert.equal(def, null);
    } finally {
      await stop(s);
    }
  }));

test('lsp: dense documents get diagnostics and dense formatting', () =>
  withRoot(async (_base, root) => {
    const s = await start(root);
    try {
      await writeFile(join(root, 'd.a0d'), 'fn sq mul A A\n');
      const uri = pathToFileURL(join(root, 'd.a0d')).href;
      const doc = { textDocument: { uri } };
      assert.deepEqual((await open(s, uri, 'fn sq mul A A\n\nfn f add sq A 1\n')).diagnostics, []);
      // a type error is reported on the function's line
      const bad = s.next(uri);
      await s.conn.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: 'fn sq mul A A\n\nfn f lt sq A 1\nfn g add f A 1\n' }],
      });
      const [diag] = (await bad).diagnostics;
      assert.equal(diag?.code, 'type');
      // formatting goes through the dense printer, comments kept
      await s.conn.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: 3 },
        contentChanges: [{ text: '# sq\nfn sq   mul A A   # sq\n\n\nfn f\nx sq A\nadd x 1\n' }],
      });
      const edits = await s.conn.sendRequest<{ newText: string }[]>('textDocument/formatting', {
        ...doc,
        options: { tabSize: 2, insertSpaces: true },
      });
      assert.equal(edits[0]?.newText, '# sq\nfn sq # sq\nmul A A\n\nfn f\nx sq A\nadd x 1\n');
    } finally {
      await stop(s);
    }
  }));

test('lsp: diagnostics carry the table code, fix and applicability, and an exact fix is a quick fix', () =>
  withRoot(async (_base, root) => {
    const s = await start(root);
    try {
      const uri = pathToFileURL(join(root, 'main.a0')).href;
      await open(s, uri, MAIN);
      const broken = MAIN.replace('c add b 1', 'c ADD b 1');
      const pending = s.next(uri);
      await s.conn.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: broken }],
      });
      const [diag] = (await pending).diagnostics;
      assert.equal(diag?.code, 'parse', 'the LSP code is still the coarse class');
      assert.equal(diag?.data?.id, 'A0011');
      assert.equal(diag?.data?.applicability, 'exact');
      assert.match(diag?.data?.fix ?? '', /add/);
      const actions = (await s.conn.sendRequest('textDocument/codeAction', {
        textDocument: { uri },
        range: diag?.range,
        context: { diagnostics: [diag] },
      })) as {
        title: string;
        isPreferred: boolean;
        edit: { changes: Record<string, { newText: string }[]> };
      }[];
      assert.equal(actions.length, 1);
      assert.match(actions[0]?.title ?? '', /^Apply exact fix: /);
      assert.equal(actions[0]?.isPreferred, true);
      assert.deepEqual(
        actions[0]?.edit.changes[uri]?.map((e) => e.newText),
        ['c add b 1\n'],
      );
    } finally {
      await stop(s);
    }
  }));

// Spec lines sit between the header (line 2) and the first node (line 6): every position below
// is one the spec lines shifted.
const SPECMAIN =
  'use "lib.a0"\n\nfn f u32 -> u32\nex 1 -> 2\nex 5 -> 26\npre lt p0 100\nb call sq p0\nc add b 1\nret c\nend\n';

const change = async (s: Session, uri: string, version: number, text: string) => {
  const pending = s.next(uri);
  await s.conn.sendNotification('textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
  return pending;
};

test('lsp: spec lines shift positions, hover, completion, and a wrong example has an exact rewrite', () =>
  withRoot(async (_base, root) => {
    const s = await start(root);
    try {
      const uri = pathToFileURL(join(root, 'main.a0')).href;
      const at = (line: number, character: number) => ({
        textDocument: { uri },
        position: { line, character },
      });
      assert.deepEqual((await open(s, uri, SPECMAIN)).diagnostics, []);

      // A node error is on the node's own line, below the three spec lines.
      const [typed] = (await change(s, uri, 2, SPECMAIN.replace('c add b 1', 'c add b true')))
        .diagnostics;
      assert.equal(typed?.code, 'type');
      assert.equal(typed?.range.start.line, 7);

      // A wrong example is reported on its own line, with the example it broke.
      const wrongText = SPECMAIN.replace('ex 5 -> 26', 'ex 5 -> 27');
      const [wrong] = (await change(s, uri, 3, wrongText)).diagnostics;
      assert.equal(wrong?.data?.id, 'A0715');
      assert.equal(wrong?.range.start.line, 4);
      assert.deepEqual(wrong?.data?.spec, {
        function: 'f',
        ex: 2,
        line: 'ex',
        input: '5',
        expected: '27',
        actual: '26',
      });
      const actions = (await s.conn.sendRequest('textDocument/codeAction', {
        textDocument: { uri },
        range: wrong?.range,
        context: { diagnostics: [wrong] },
      })) as {
        title: string;
        isPreferred: boolean;
        edit: {
          changes: Record<string, { range: { start: { line: number } }; newText: string }[]>;
        };
      }[];
      assert.equal(actions.length, 1);
      assert.equal(actions[0]?.title, 'Change the expected result to 26');
      assert.equal(actions[0]?.isPreferred, false, 'the function may be the wrong side');
      assert.equal(actions[0]?.edit.changes[uri]?.[0]?.range.start.line, 4);
      assert.equal(actions[0]?.edit.changes[uri]?.[0]?.newText, 'ex 5 -> 26');

      // A broken precondition is on the pre line.
      const [pre] = (await change(s, uri, 4, SPECMAIN.replace('pre lt p0 100', 'pre lt p0 3')))
        .diagnostics;
      assert.equal(pre?.data?.id, 'A0716');
      assert.equal(pre?.range.start.line, 5);

      await change(s, uri, 5, SPECMAIN);

      // Hover: the keywords, an operation inside a spec line, and a callee below the spec lines.
      const hover = async (line: number, character: number) =>
        (await s.conn.sendRequest('textDocument/hover', at(line, character))) as {
          contents: { value: string };
        } | null;
      assert.match((await hover(3, 0))?.contents.value ?? '', /^ex ARGS -> RESULT/);
      assert.match((await hover(5, 1))?.contents.value ?? '', /^pre OP ARGS/);
      assert.match((await hover(5, 5))?.contents.value ?? '', /^lt a b -> bool/);
      assert.match((await hover(6, 8))?.contents.value ?? '', /fn sq u32 -> u32/);

      // Completion offers the spec words only where a spec line may start.
      const labels = async (line: number): Promise<string[]> =>
        (
          (await s.conn.sendRequest('textDocument/completion', at(line, 0))) as {
            label: string;
          }[]
        ).map((i) => i.label);
      assert.ok((await labels(3)).includes('ex') && (await labels(3)).includes('pre'));
      const afterPre = await labels(6);
      assert.ok(afterPre.includes('ex') && afterPre.includes('post') && !afterPre.includes('pre'));
      assert.ok(!(await labels(8)).includes('ex'), 'not below the first node');

      // The symbol range of f still runs from its header to its end.
      const symbols = (await s.conn.sendRequest('textDocument/documentSymbol', {
        textDocument: { uri },
      })) as { name: string; range: { start: { line: number }; end: { line: number } } }[];
      assert.deepEqual(
        symbols.map((d) => [d.name, d.range.start.line, d.range.end.line]),
        [['f', 2, 9]],
      );

      // Formatting a canonical file with spec lines changes nothing.
      const fmt = (await s.conn.sendRequest('textDocument/formatting', {
        textDocument: { uri },
        options: { tabSize: 2, insertSpaces: true },
      })) as unknown[];
      assert.deepEqual(fmt, []);
    } finally {
      await stop(s);
    }
  }));

test('candidate LSP shares diagnostics, imports, formatting and unsaved dependency checks', () =>
  withRoot(async (base, root) => {
    const library = 'fn sq\na mul A A\nret a\nend\n';
    const source = 'use "lib.a0"\n\n# preserve\nfn f _ -> _\n  b sq A\n  c shl b 1\nret c\nend\n';
    const mainPath = join(root, 'main.a0');
    await writeFile(join(root, 'lib.a0'), library);
    await writeFile(mainPath, source);
    const s = await start(root, true);
    const main = pathToFileURL(mainPath).href,
      lib = pathToFileURL(join(root, 'lib.a0')).href;
    const doc = { textDocument: { uri: main } };
    try {
      assert.deepEqual((await open(s, main, source)).diagnostics, []);
      const edits = await s.conn.sendRequest<{ newText: string }[]>('textDocument/formatting', {
        ...doc,
        options: { tabSize: 2, insertSpaces: true },
      });
      const formatted = edits[0]?.newText;
      assert.ok(formatted);
      assert.match(formatted, /# preserve/);
      assert.match(formatted, /c << b 1/);
      const read = (text: string) => (path: string) =>
        path === mainPath ? Promise.resolve(text) : readFile(path, 'utf8');
      const before = await linkSource(mainPath, read(source), { root });
      const after = await linkSource(mainPath, read(formatted), { root });
      assert.equal(programRevision(after.program), programRevision(before.program));
      for (const target of ['c', 'js'] as const)
        assert.equal(compile(after.program, target).text, compile(before.program, target).text);
      const next = s.next(main);
      await s.conn.sendNotification('textDocument/didChange', {
        textDocument: { uri: main, version: 2 },
        contentChanges: [{ text: formatted }],
      });
      assert.deepEqual((await next).diagnostics, []);
      assert.deepEqual(
        await s.conn.sendRequest('textDocument/formatting', {
          ...doc,
          options: { tabSize: 2, insertSpaces: true },
        }),
        [],
      );
      const items = await s.conn.sendRequest<
        { label: string; insertText?: string; insertTextFormat?: number }[]
      >('textDocument/completion', {
        ...doc,
        position: { line: 4, character: 4 },
      });
      assert.ok(items.some((x) => x.label === '<<'));
      assert.equal(items.find((x) => x.label === '[]')?.insertText, '[0]');
      assert.equal(items.find((x) => x.label === '[]')?.insertTextFormat, 1);
      const lines = formatted.split('\n'),
        shift = lines.findIndex((x) => x.includes('<<'));
      const shiftLine = lines[shift];
      assert.ok(shiftLine);
      const hover = await s.conn.sendRequest<{ contents: { value: string } }>(
        'textDocument/hover',
        { ...doc, position: { line: shift, character: shiftLine.indexOf('<<') } },
      );
      assert.match(hover.contents.value, /<</);
      assert.doesNotMatch(hover.contents.value, /alias of/);
      assert.equal(
        items.some((x) => ['shl', 'shr', 'arr', 'rec'].includes(x.label)),
        false,
      );
      const call = lines.findIndex((x) => x.includes('sq A'));
      const callLine = lines[call];
      assert.ok(callLine);
      const definition = await s.conn.sendRequest<{ uri: string }>('textDocument/definition', {
        ...doc,
        position: { line: call, character: callLine.indexOf('sq') },
      });
      assert.equal(definition.uri, lib);
      const brokenMain = s.next(main);
      await open(s, lib, library.replace('mul A A', 'mul A true'));
      assert.ok((await brokenMain).diagnostics.length > 0, 'unsaved dependency is checked');
      const fixedMain = s.next(main),
        fixedLib = s.next(lib);
      await s.conn.sendNotification('textDocument/didChange', {
        textDocument: { uri: lib, version: 2 },
        contentChanges: [{ text: library }],
      });
      assert.deepEqual((await fixedLib).diagnostics, []);
      assert.deepEqual((await fixedMain).diagnostics, []);
      const wrong = (await change(s, main, 3, 'fn f\nex 1 -> 3\nret A\nend\n')).diagnostics[0];
      assert.equal(wrong?.data?.id, 'A0715');
      const actions = await s.conn.sendRequest<
        { edit: { changes: Record<string, { newText: string }[]> } }[]
      >('textDocument/codeAction', {
        ...doc,
        range: wrong?.range,
        context: { diagnostics: [wrong] },
      });
      assert.equal(actions[0]?.edit.changes[main]?.[0]?.newText, 'ex 1 -> 1');
      assert.deepEqual((await change(s, main, 4, 'fn f\nex 1 -> 1\nret A\nend\n')).diagnostics, []);
      const outside = pathToFileURL(join(base, 'outside.a0')).href;
      assert.equal((await open(s, outside, library)).diagnostics[0]?.code, 'limit');
    } finally {
      await stop(s);
    }
  }));

test('candidate LSP completion snippets use one executable spelling for shifts and aggregates', () =>
  withRoot(async (_base, root) => {
    const s = await start(root, true, true);
    try {
      const uri = pathToFileURL(join(root, 'main.a0')).href;
      await open(s, uri, 'fn f\nx << A 1\nret x\nend\n');
      const items = await s.conn.sendRequest<
        { label: string; insertText?: string; insertTextFormat?: number; detail?: string }[]
      >('textDocument/completion', { textDocument: { uri }, position: { line: 1, character: 2 } });
      for (const label of ['<<', '>>', '[]', '()']) {
        const item = items.find((x) => x.label === label);
        assert.ok(item?.insertText);
        assert.equal(item.insertTextFormat, 2);
        const expression = item.insertText.replace(/\$\{\d+:([^}]+)\}/g, '$1');
        const type = label === '[]' ? ' -> _x1' : label === '()' ? ' -> (_)' : '';
        const { validate } = await import('../src/core.js');
        const { parseSource } = await import('../src/source.js');
        validate(parseSource(`fn f${type}\nx ${expression}\nret x\nend\n`));
      }
      assert.equal(
        items.some((x) => ['shl', 'shr', 'arr', 'rec', 'udiv', 'urem'].includes(x.label)),
        false,
      );
    } finally {
      await stop(s);
    }
  }));

test('source LSP type diagnostics use the selected literal spelling', () =>
  withRoot(async (_base, root) => {
    const s = await start(root, true);
    try {
      const path = join(root, 'type-error.a0');
      const uri = pathToFileURL(path).href;
      const text = 'fn f _x2 -> _\nex [1 2 3] -> 0\nret 0\nend\n';
      await writeFile(path, text);
      const [diagnostic] = (await open(s, uri, text)).diagnostics;
      assert.equal(diagnostic?.data?.id, 'A0714');
      assert.match(diagnostic?.message ?? '', / is \[1 2 3\], which is not a u32x2/);
    } finally {
      await stop(s);
    }
  }));

for (const kind of ['pre', 'post'] as const) {
  test(`source LSP ${kind} failures use source literal spelling`, () =>
    withRoot(async (_base, root) => {
      const s = await start(root, true);
      try {
        const path = join(root, 'contract.a0');
        const text = `fn f _x2 -> _x2\nex [1 2] -> [1 2]\n${kind} eq 0 1\nret A\nend\n`;
        await writeFile(path, text);
        const [diagnostic] = (await open(s, pathToFileURL(path).href, text)).diagnostics;
        assert.equal(diagnostic?.data?.id, 'A0716');
        assert.deepEqual(diagnostic?.data?.spec, {
          function: 'f',
          ex: 1,
          line: kind,
          input: '[1 2]',
        });
        assert.match(diagnostic?.message ?? '', /the input \[1 2\]/);
        if (kind === 'post') assert.match(diagnostic?.message ?? '', /gives \[1 2\], which/);
      } finally {
        await stop(s);
      }
    }));
}
