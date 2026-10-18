/** Actual C frontend/formatter/renderer over the real LSP protocol; no CLI/default switch. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import {
  CancellationToken,
  type Connection,
  createConnection,
  type Diagnostic,
  LSPErrorCodes,
  type TextEdit,
} from 'vscode-languageserver/node';
import { compile } from '../src/backends.js';
import { A0Error, formatProgram, type TypedProgram } from '../src/core.js';
import { semanticRevision } from '../src/edit.js';
import { startServer } from '../src/lsp.js';
import { formatSource, parseSource } from '../src/source.js';
import { linkSource } from '../src/source-link.js';
import { nativeSource } from '../src/source-native.js';
import { openNativeSourceProject } from '../src/source-native-link.js';
import {
  prepareSourceDiagnostic,
  prepareSourceFormat,
  prepareSourceFrontend,
} from '../tools/source-native-load.js';

const frontendPath = process.env.A0_LSP_FRONTEND;
const formatPath = process.env.A0_LSP_FORMAT;
const diagnosticPath = process.env.A0_LSP_DIAGNOSTIC;
assert.ok(
  frontendPath && formatPath && diagnosticPath,
  'A0_LSP_FRONTEND/FORMAT/DIAGNOSTIC required',
);
const prepared = await prepareSourceFrontend(frontendPath);
assert.equal(prepared.build.diagnosticPorts, 'arena-v1');
const module = new WebAssembly.Module(await readFile(join(frontendPath, 'frontend.wasm')));
const formatting = await prepareSourceFormat(formatPath);
const diagnostics = await prepareSourceDiagnostic(diagnosticPath);
assert.equal(diagnostics.verification, true, 'complete native spec diagnostic companion required');
const engine = () => nativeSource(module, diagnostics, formatting);
type Engine = ReturnType<typeof engine>;
interface Publication {
  uri: string;
  version?: number;
  diagnostics: Diagnostic[];
}
interface Protocol {
  readonly client: MessageConnection;
  readonly publications: Publication[];
  open(path: string, text: string): Promise<Publication>;
  change(path: string, text: string, version: number): Promise<Publication>;
  format(path: string): Promise<TextEdit[] | null>;
  wait(path: string, version: number, after: number): Promise<Publication>;
  close(): Promise<void>;
}
interface RegisteredHandlers {
  open?: Parameters<Connection['onDidOpenTextDocument']>[0];
  close?: Parameters<Connection['onDidCloseTextDocument']>[0];
  format?: Parameters<Connection['onDocumentFormatting']>[0];
}
async function protocol(
  root: string,
  frontend: Engine,
  handlers?: RegisteredHandlers,
): Promise<Protocol> {
  const requests = new PassThrough(),
    responses = new PassThrough();
  // MessageReader/Writer avoid the node server's process-exit-on-raw-stream-close adapter.
  const server = createConnection(
    new StreamMessageReader(requests),
    new StreamMessageWriter(responses),
  );
  const client = createMessageConnection(
    new StreamMessageReader(responses),
    new StreamMessageWriter(requests),
  );
  const publications: Publication[] = [];
  const waiting = new Set<() => void>();
  client.onNotification('textDocument/publishDiagnostics', (value: Publication) => {
    publications.push(value);
    for (const pending of waiting) pending();
  });
  client.listen();
  const wired: Connection =
    handlers === undefined
      ? server
      : {
          ...server,
          onDidOpenTextDocument(handler) {
            handlers.open = handler;
            return server.onDidOpenTextDocument(handler);
          },
          onDidCloseTextDocument(handler) {
            handlers.close = handler;
            return server.onDidCloseTextDocument(handler);
          },
          onDocumentFormatting(handler) {
            handlers.format = handler;
            return server.onDocumentFormatting(handler);
          },
        };
  await startServer(wired, root, { frontend });
  await client.sendRequest('initialize', {
    processId: null,
    rootUri: pathToFileURL(root).href,
    capabilities: {},
  });
  await client.sendNotification('initialized', {});
  const wait = (path: string, version: number, after: number): Promise<Publication> =>
    new Promise((resolve, reject) => {
      const uri = pathToFileURL(path).href;
      const timer = setTimeout(() => {
        waiting.delete(pending);
        reject(new Error(`diagnostics missing for version ${version}`));
      }, 10_000);
      const pending = (): void => {
        const value = publications
          .slice(after)
          .find((value) => value.uri === uri && value.version === version);
        if (value === undefined) return;
        waiting.delete(pending);
        clearTimeout(timer);
        resolve(value);
      };
      waiting.add(pending);
      pending();
    });
  return {
    client,
    publications,
    wait,
    async open(path, text) {
      const after = publications.length;
      await client.sendNotification('textDocument/didOpen', {
        textDocument: { uri: pathToFileURL(path).href, languageId: 'a0', version: 1, text },
      });
      return wait(path, 1, after);
    },
    async change(path, text, version) {
      const after = publications.length;
      await client.sendNotification('textDocument/didChange', {
        textDocument: { uri: pathToFileURL(path).href, version },
        contentChanges: [{ text }],
      });
      return wait(path, version, after);
    },
    format: (path) =>
      client.sendRequest('textDocument/formatting', {
        textDocument: { uri: pathToFileURL(path).href },
        options: { tabSize: 2, insertSpaces: true },
      }),
    async close() {
      await client.sendRequest('shutdown');
      client.dispose();
      server.dispose();
      requests.destroy();
      responses.destroy();
    },
  };
}
async function fixture(run: (root: string, outside: string) => Promise<void>): Promise<void> {
  await mkdir(resolve('.a0-tmp'), { recursive: true });
  const scratch = await realpath(await mkdtemp(resolve('.a0-tmp/lsp-native-')));
  const root = join(scratch, 'root'),
    outside = join(scratch, 'outside.a0');
  await mkdir(root);
  await writeFile(outside, 'fn outside\nret 1\nend\n');
  try {
    await run(root, outside);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
const mainText =
  '# main Ω\nprofile strict # profile\nuse "libλ.a0" # dependency\nfn top\nex 3 -> 4 # example\npre lt A 90 # pre\npost gt r A # post\nx helper A # node\nret x # return\nend # end\n# main tail 😀\n';
const helperText =
  'profile strict\n# helper\nfn helper\nex 0 -> 1\na add A 1\nret a\nend\n# Unicode bytes\nfn banner -> _x6\na "λ😀" # text\nret a\nend\n# helper tail\n';

test('native LSP diagnostics and per-file formatting share current buffers and preserve lexical services', async () =>
  fixture(async (root, outside) => {
    const main = join(root, 'main.a0'),
      library = join(root, 'libλ.a0');
    await writeFile(main, 'invalid disk entry');
    await writeFile(library, 'invalid disk dependency');
    const host = engine();
    let units = 0,
      checks = 0,
      formats = 0;
    const parsedSources: string[] = [];
    const counted: Engine = {
      ...host,
      parse() {
        throw new Error('whole-source parse is not part of this protocol path');
      },
      parseUnit(text, budget) {
        units++;
        parsedSources.push(text);
        return host.parseUnit(text, budget);
      },
      checkUnits(inputs, profile, budget) {
        checks++;
        return host.checkUnits(inputs, profile, budget);
      },
      format(input, request) {
        formats++;
        return host.format(input, request);
      },
    };
    const session = await protocol(root, counted);
    try {
      assert.deepEqual((await session.open(library, helperText)).diagnostics, []);
      assert.deepEqual((await session.open(main, mainText)).diagnostics, []);
      const libraryEdits = await session.format(library);
      const libraryOutput = libraryEdits?.[0]?.newText ?? helperText;
      assert.equal(libraryOutput, formatSource(parseSource(helperText)));
      assert.ok(libraryOutput.includes('"λ😀" # text'));
      const edits = await session.format(main);
      const expected = formatSource(parseSource(mainText));
      assert.ok(edits && edits.length === 1);
      assert.equal(edits[0]?.newText, expected);
      assert.ok(expected.includes('use "libλ.a0" # dependency'));
      assert.ok(expected.includes('# main tail 😀'));
      assert.deepEqual((await session.change(main, expected, 2)).diagnostics, []);
      assert.deepEqual(await session.format(main), []);
      const uri = pathToFileURL(main).href;
      const lines = expected.split('\n');
      const at = lines.findIndex((line) => line.includes('helper A'));
      const hover = await session.client.sendRequest<{ contents: { value: string } }>(
        'textDocument/hover',
        { textDocument: { uri }, position: { line: at, character: 4 } },
      );
      assert.equal(hover.contents.value, '`fn helper`');
      const definition = await session.client.sendRequest<{ uri: string }>(
        'textDocument/definition',
        { textDocument: { uri }, position: { line: at, character: 4 } },
      );
      assert.equal(definition.uri, pathToFileURL(library).href);
      const symbols = await session.client.sendRequest<{ name: string }[]>(
        'textDocument/documentSymbol',
        { textDocument: { uri } },
      );
      assert.deepEqual(
        symbols.map((symbol) => symbol.name),
        ['top'],
      );
      const completions = await session.client.sendRequest<{ label: string }[]>(
        'textDocument/completion',
        { textDocument: { uri }, position: { line: at, character: 0 } },
      );
      assert.ok(completions.some((item) => item.label === 'helper'));
      const broken = expected.replace('x helper A', 'x add A true');
      const error = (await session.change(main, broken, 3)).diagnostics[0];
      assert.ok(error);
      let reference: A0Error | undefined;
      try {
        await linkSource(main, async (path) => (path === main ? broken : helperText), { root });
      } catch (failure) {
        assert.ok(failure instanceof A0Error);
        reference = failure;
      }
      assert.ok(reference);
      assert.equal(error.code, reference.code);
      assert.equal(error.data.id, reference.id);
      assert.equal(
        error.range.start.line,
        broken.split('\n').findIndex((line) => line.includes('x add A true')),
      );
      assert.ok(!JSON.stringify(error).includes(root));
      const brokenEdits = await session.format(main);
      assert.equal(brokenEdits?.[0]?.newText ?? broken, formatSource(parseSource(broken)));
      const outsideSource = 'fn outside\nret 1\nend\n';
      const outsideDiagnostic = await session.open(outside, outsideSource);
      assert.equal(outsideDiagnostic.diagnostics[0]?.code, 'limit');
      assert.equal(await session.format(outside), null);
      assert.equal(parsedSources.includes(outsideSource), false);
      assert.ok(units > 0);
      assert.ok(checks > 0 && formats > 0);
    } finally {
      await session.close();
      assert.ok(host.parse('fn alive\nret 1\nend\n').ok);
      host.close();
    }
  }));

test('native LSP has explicit capability/resource/encoding failures and no historical-source fallback', async () =>
  fixture(async (root) => {
    const main = join(root, 'main.a0'),
      library = join(root, 'libλ.a0'),
      historical = join(root, 'old.a0d');
    await writeFile(main, mainText);
    await writeFile(library, helperText);
    await writeFile(historical, 'fn old A\n');
    const plain = nativeSource(module);
    const noFormat = await protocol(root, plain);
    try {
      assert.deepEqual((await noFormat.open(main, mainText)).diagnostics, []);
      await assert.rejects(
        noFormat.format(main),
        (error) =>
          error instanceof ResponseError &&
          error.code === LSPErrorCodes.RequestFailed &&
          error.data.reason === 'unavailable',
      );
      const malformed = await noFormat.change(main, 'fn broken\nend\n', 2);
      assert.equal(malformed.diagnostics[0]?.code, 'service');
      assert.ok(malformed.diagnostics[0]?.data.native.diagnostic > 0);
      await noFormat.open(historical, 'fn old A\n');
      await assert.rejects(
        noFormat.format(historical),
        (error) => error instanceof ResponseError && error.data.reason === 'source-path',
      );
    } finally {
      await noFormat.close();
      plain.close();
    }
    const host = engine();
    let bounded = true;
    const constrained: Engine = {
      ...host,
      checkUnits(units, profile, budget) {
        return host.checkUnits(units, profile, bounded ? 0 : budget);
      },
    };
    const session = await protocol(root, constrained);
    try {
      const resource = await session.open(main, mainText);
      assert.equal(resource.diagnostics[0]?.code, 'service');
      assert.equal(resource.diagnostics[0]?.data.native.status, 4);
      bounded = false;
      assert.deepEqual((await session.change(main, mainText, 2)).diagnostics, []);
      await writeFile(library, Buffer.from([0xff]));
      const encoding = await session.change(main, mainText, 3);
      assert.equal(encoding.diagnostics[0]?.code, 'service');
      assert.equal(
        encoding.diagnostics[0]?.data.native.reason,
        'ERR_ENCODING_INVALID_ENCODED_DATA',
      );
      assert.ok(!JSON.stringify(encoding.diagnostics[0]).includes(root));
      await writeFile(library, helperText);
      assert.deepEqual((await session.change(main, mainText, 4)).diagnostics, []);
      host.close();
      await assert.rejects(
        session.format(main),
        (error) => error instanceof ResponseError && error.data.reason === 'service-unavailable',
      );
    } finally {
      await session.close();
      host.close();
    }
  }));

function sameBackend(actual: TypedProgram, expected: TypedProgram): void {
  assert.equal(formatProgram(actual), formatProgram(expected));
  for (const target of ['c', 'js', 'wasm'] as const)
    assert.equal(compile(actual, target).text, compile(expected, target).text);
}
test('native LSP imported bool/record/array formatting fixed points preserve checked graph revisions and profile overrides', async () =>
  fixture(async (root) => {
    const files = new Map([
      [
        join(root, 'dep.a0'),
        'profile strict # dep\nfn flag _ -> bool\na lt A 10\nret a\nend\nfn pair _ -> (_,bool)\na flag A\nb (A a)\nret b\nend\nfn array _ -> boolx2\na flag A\nb [a true]\nret b\nend\n',
      ],
      [
        join(root, 'mid.a0'),
        'profile strict\nuse "dep.a0" # imported types\nfn passflag _ -> bool\nx flag A\nret x\nend\nfn passpair _ -> (_,bool)\nx pair A\nret x\nend\nfn passarray _ -> boolx2\nx array A\nret x\nend\n# mid tail\n',
      ],
      [join(root, 'empty.a0'), 'profile strict\nuse "mid.a0" # wrapper\n# empty wrapper tail\n'],
      [
        join(root, 'entry.a0'),
        'profile strict # entry\nuse "mid.a0"\nuse "empty.a0"\nfn finalflag _ -> bool\nex 3 -> true\nx passflag A\nret x\nend\nfn finalpair _ -> (_,bool)\nex 3 -> (3 true)\nx passpair A\nret x\nend\nfn finalarray _ -> boolx2\nex 3 -> [true true]\nx passarray A\nret x\nend\n# entry tail Ω\n',
      ],
    ]);
    for (const [path, text] of files) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    const entry = join(root, 'entry.a0');
    for (const profile of ['strict', 'canonical'] as const) {
      const host = engine();
      const frontend: Engine = {
        ...host,
        checkUnits(units, _profile, budget) {
          return host.checkUnits(units, profile, budget);
        },
      };
      const session = await protocol(root, frontend);
      try {
        const read = async (path: string): Promise<string> => files.get(path) as string;
        const before = await openNativeSourceProject(entry, read, host, { root, profile });
        const reference = await linkSource(entry, read, { root, profile });
        sameBackend(before.program, reference.program);
        const last = before.program.functions.length - 1;
        const beforeHash = host.revision(before.native.graph, {
          kind: 'semantic',
          functionIndex: last,
        });
        assert.ok(beforeHash.ok);
        before.native.close();
        for (const [path, text] of files)
          assert.deepEqual((await session.open(path, text)).diagnostics, []);
        const formatted = new Map<string, string>();
        for (const [path, text] of files) {
          const edits = await session.format(path);
          const output = edits?.[0]?.newText ?? text;
          assert.equal(output, formatSource(parseSource(text)));
          formatted.set(path, output);
          assert.deepEqual((await session.change(path, output, 2)).diagnostics, []);
          assert.deepEqual(await session.format(path), []);
        }
        const after = await openNativeSourceProject(
          entry,
          async (path) => formatted.get(path) as string,
          host,
          { root, profile },
        );
        sameBackend(after.program, reference.program);
        const afterHash = host.revision(after.native.graph, {
          kind: 'semantic',
          functionIndex: last,
        });
        assert.deepEqual(afterHash, beforeHash);
        assert.equal(
          afterHash.ok && afterHash.revision,
          semanticRevision(
            reference.program.functions[last] as NonNullable<
              (typeof reference.program.functions)[number]
            >,
          ),
        );
        after.native.close();
      } finally {
        await session.close();
        host.close();
      }
    }
  }));

test('native LSP versions remain coherent under interleaved buffer graph checks and formatting', async () =>
  fixture(async (root) => {
    const main = join(root, 'main.a0'),
      library = join(root, 'libλ.a0');
    await writeFile(main, mainText);
    await writeFile(library, helperText);
    const host = engine();
    const session = await protocol(root, host);
    try {
      await session.open(library, helperText);
      await session.open(main, mainText);
      const after = session.publications.length;
      await Promise.all([
        session.client.sendNotification('textDocument/didChange', {
          textDocument: { uri: pathToFileURL(main).href, version: 2 },
          contentChanges: [{ text: mainText.replace('x helper A', 'x add A true') }],
        }),
        session.client.sendNotification('textDocument/didChange', {
          textDocument: { uri: pathToFileURL(library).href, version: 2 },
          contentChanges: [
            {
              text: helperText.replace('a add A 1', 'a add A 2').replace('ex 0 -> 1', 'ex 0 -> 2'),
            },
          ],
        }),
        session.client.sendNotification('textDocument/didChange', {
          textDocument: { uri: pathToFileURL(main).href, version: 3 },
          contentChanges: [{ text: mainText.replace('ex 3 -> 4', 'ex 3 -> 5') }],
        }),
      ]);
      const latest = await session.wait(main, 3, after);
      assert.deepEqual(latest.diagnostics, []);
      const edits = await session.format(main);
      assert.equal(
        edits?.[0]?.newText,
        formatSource(parseSource(mainText.replace('ex 3 -> 4', 'ex 3 -> 5'))),
      );
      const records = session.publications
        .slice(after)
        .filter((item) => item.uri === pathToFileURL(main).href);
      let observed = 0;
      for (const item of records) {
        assert.ok((item.version ?? 0) >= observed);
        observed = item.version ?? 0;
      }
      const closedAt = session.publications.length;
      await session.client.sendNotification('textDocument/didClose', {
        textDocument: { uri: pathToFileURL(main).href },
      });
      assert.equal(await session.format(main), null);
      assert.ok(
        session.publications
          .slice(closedAt)
          .some((item) => item.uri === pathToFileURL(main).href && item.diagnostics.length === 0),
      );
    } finally {
      await session.close();
      assert.ok(host.parse('fn alive\nret 1\nend\n').ok);
      host.close();
    }
  }));

test('native LSP rejects escaped aliases and direct outside imports without exposing host paths', async () =>
  fixture(async (root, outside) => {
    const main = join(root, 'main.a0');
    await symlink(
      dirname(outside),
      join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const sources = [
      'use "escape/outside.a0"\nfn top\nret 1\nend\n',
      'use "../outside.a0"\nfn top\nret 1\nend\n',
    ];
    await writeFile(main, sources[0] as string);
    const host = engine(),
      session = await protocol(root, host);
    try {
      for (const [index, source] of sources.entries()) {
        const report =
          index === 0
            ? await session.open(main, source)
            : await session.change(main, source, index + 1);
        const error = report.diagnostics[0];
        assert.ok(error);
        const packet = JSON.stringify(error);
        assert.ok(!packet.includes(root));
        assert.ok(!packet.includes(dirname(outside)));
        assert.ok(!packet.includes(outside));
      }
    } finally {
      await session.close();
      host.close();
    }
  }));

test('native LSP real-handler scheduling refuses old formatting and diagnostics after same-version close/reopen', async () =>
  fixture(async (root) => {
    const path = join(root, 'reopened.a0'),
      uri = pathToFileURL(path).href;
    const oldText = '# old document\nfn old -> bool\nret 1\nend\n';
    const newText = '# new document\nfn new\nret 2\nend\n';
    await writeFile(path, newText);
    const host = engine(),
      parsedSources: string[] = [];
    const frontend: Engine = {
      ...host,
      parseUnit(text, budget) {
        parsedSources.push(text);
        return host.parseUnit(text, budget);
      },
    };
    const handlers: RegisteredHandlers = {};
    const session = await protocol(root, frontend, handlers);
    try {
      assert.ok(handlers.open && handlers.close && handlers.format);
      const after = session.publications.length;
      // Invoke the actual registered TextDocuments/server handlers in one JS stack. The real
      // asynchronous FS path resolution cannot complete until after close/reopen below.
      handlers.open({ textDocument: { uri, languageId: 'a0', version: 1, text: oldText } });
      const formatting = Promise.resolve(
        handlers.format(
          { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } },
          CancellationToken.None,
          { begin() {}, report() {}, done() {} },
        ),
      );
      handlers.close({ textDocument: { uri } });
      handlers.open({ textDocument: { uri, languageId: 'a0', version: 1, text: newText } });
      await assert.rejects(
        formatting,
        (error) => error instanceof ResponseError && error.code === LSPErrorCodes.ContentModified,
      );
      const publication = await session.wait(path, 1, after);
      assert.deepEqual(publication.diagnostics, []);
      assert.equal(
        parsedSources.includes(oldText),
        false,
        'stale handlers do not begin native work for the old document',
      );
      const edits = await session.format(path);
      assert.equal(edits?.[0]?.newText ?? newText, formatSource(parseSource(newText)));
      for (const report of session.publications.slice(after))
        if (report.uri === uri && report.version === 1) assert.deepEqual(report.diagnostics, []);
    } finally {
      await session.close();
      host.close();
    }
  }));

test('native LSP preserves genuine spec diagnostic JSON and ownership across direct and imported failures', async () =>
  fixture(async (root) => {
    const main = join(root, 'main.a0'),
      library = join(root, 'libλ.a0');
    const baseLibrary =
      '# dependency π 😀\nprofile strict\nfn spec\nret 0\nend\nfn helper\nret A\nend\n';
    const baseMain = '# entry Ω\nprofile strict\nuse "libλ.a0"\nfn top\nx helper A\nret x\nend\n';
    const cases = [
      ['A0714', 'fn target\nex nope -> 1\nret A\nend\n'],
      ['A0714', 'fn target\npre eq missing 0\nret A\nend\n'],
      ['A0715', 'fn target\nex 3 -> 9\nret A\nend\n'],
      ['A0716', 'fn target\nex 3 -> 3\npre lt A 2\nret A\nend\n'],
      ['A0716', 'fn target\nex 3 -> 3\npost lt r 2\nret A\nend\n'],
      ['A0715', 'fn target\nex 3 -> 3\nx div A 0\nret x\nend\n'],
      [
        'A0716',
        'fn exploding _ -> bool\nx div A 0\ny eq x 0\nret y\nend\nfn target\nex 3 -> 3\npre exploding A\nret A\nend\n',
      ],
      [
        'A0719',
        'fn step u32 u32 -> u32\nx add p0 1\nret x\nend\nfn target u32 -> u32\nex 1 -> 20001\nx fold step 20000 p0\nret x\nend\n',
      ],
      [
        'A0719',
        'fn step u32 u32 -> u32\nx add p0 1\nret x\nend\nfn heavy u32 -> bool\nx fold step 20000 p0\ny eq x 0\nret y\nend\nfn target u32 -> u32\nex 1 -> 1\npre heavy p0\nret p0\nend\n',
      ],
    ] as const;
    await writeFile(main, baseMain);
    await writeFile(library, baseLibrary);
    const host = engine(),
      session = await protocol(root, host);
    try {
      assert.deepEqual((await session.open(library, baseLibrary)).diagnostics, []);
      assert.deepEqual((await session.open(main, baseMain)).diagnostics, []);
      let version = 1;
      for (const imported of [false, true]) {
        for (const [id, source] of cases) {
          const mainSource = baseMain + (imported ? '' : source);
          const librarySource = baseLibrary + (imported ? source : '');
          const sources = new Map([
            [main, mainSource],
            [library, librarySource],
          ]);
          await session.change(library, librarySource, ++version);
          const report = await session.change(main, mainSource, ++version);
          const actual = report.diagnostics[0];
          assert.ok(actual, `${imported ? 'imported' : 'direct'}/${id}`);
          let expected: A0Error | undefined;
          try {
            await linkSource(main, async (path) => sources.get(path) as string, { root });
          } catch (error) {
            assert.ok(error instanceof A0Error);
            expected = error;
          }
          assert.ok(expected);
          assert.equal(expected.id, id);
          assert.equal(actual.code, expected.code);
          assert.deepEqual(actual.data, {
            id: expected.id ?? null,
            code: expected.code,
            fix: expected.fix ?? null,
            applicability: expected.applicability ?? null,
            edits: expected.edits,
            spec: expected.spec ?? null,
          });
          const location = /^(.*\.a0):(\d+): ([\s\S]*)$/.exec(expected.message);
          assert.ok(location, expected.message);
          const expectedBody = `${imported ? `libλ.a0:${location[2]}: ` : ''}${location[3]}`;
          assert.equal(
            actual.message,
            expected.fix === undefined ? expectedBody : `${expected.fix}\n${expectedBody}`,
          );
          assert.equal(actual.range.start.line, imported ? 2 : Number(location[2]) - 1);
          assert.ok(!JSON.stringify(actual).includes(root));
          if (id === 'A0715' && expected.spec?.actual === '3') {
            const actions = await session.client.sendRequest<
              { edit: { changes: Record<string, TextEdit[]> } }[]
            >('textDocument/codeAction', {
              textDocument: { uri: pathToFileURL(main).href },
              context: { diagnostics: [actual] },
              range: actual.range,
            });
            // The existing lexical action only edits an example in the requested document.
            if (!imported)
              assert.ok(
                actions.some((action) =>
                  action.edit.changes[pathToFileURL(main).href]?.[0]?.newText.includes('ex 3 -> 3'),
                ),
              );
            else assert.deepEqual(actions, []);
          }
        }
      }
    } finally {
      await session.close();
      host.close();
    }
  }));
