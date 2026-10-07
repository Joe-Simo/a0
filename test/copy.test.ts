import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { makeIo, run, type TypedFunc } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang } from '../src/toolchain.js';
import { wasmModuleBytes } from '../src/wasm.js';
import { buildGenerator, generate } from '../tools/site-gen.js';
import { renderWords } from '../tools/site-render.js';

// COPY, protocol word 14 (docs/UI-PROTOCOL.md): the open element copies a text to the clipboard when
// the user activates it. The template line `^TEXT` writes it; the interpreter, the wasm module the
// browser runs (site/app.ts reads the same words) and the prerender must agree on the stream.

const COPY_TEXT = 'claude mcp add a0 -- a0 mcp . "x" <y> & z';

const TEMPLATE = [
  '# test fixture: one copy button next to the text it copies',
  'f tags site/gen/tags.tpl',
  '1use "ui.a0"',
  '2',
  '2fn session io -> u32',
  '2r0 read p0',
  '2event at r0 0',
  '2tok at r0 1',
  '<code',
  `"${COPY_TEXT}`,
  '>',
  '<button',
  '+type button',
  '+class copy',
  '+aria-label Copy the command',
  `^${COPY_TEXT}`,
  '"Copy',
  '>',
  '2',
  '2ret event',
  '2end',
  '',
].join('\n');

function strWords(s: string): number[] {
  const b = [...new TextEncoder().encode(s)];
  return [b.length, ...b];
}

async function wasmWords(source: string, dir: string): Promise<number[]> {
  await writeFile(join(dir, 'p.a0'), source);
  await copyFile('site/ui.a0', join(dir, 'ui.a0'));
  const program = (await link(join(dir, 'p.a0'), (f) => readFile(f, 'utf8'), { root: dir }))
    .program;
  const io = makeIo([0, 0, 0, 0, 0]);
  run(program.byName.get('session') as TypedFunc, [io]);
  const IN = 1024;
  const OUT = 131072;
  const bytes = wasmModuleBytes(
    compile(program, 'wasm', { ioInputCapacity: IN, ioOutputCapacity: OUT, optimize: true }).text,
  );
  const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
  const e = instance.exports as {
    memory: WebAssembly.Memory;
    __heap_base: WebAssembly.Global;
    a0_session: (t: number) => number;
  };
  const base = e.__heap_base.value as number;
  const needed = base + (IN + 2 + OUT + 1) * 4;
  if (e.memory.buffer.byteLength < needed)
    e.memory.grow(Math.ceil((needed - e.memory.buffer.byteLength) / 65536));
  const words = new Uint32Array(e.memory.buffer, base, IN + 2 + OUT + 1);
  words.set([0, 0, 0, 0, 0], 0);
  words[IN] = 5;
  e.a0_session(base);
  const nout = words[IN + 2 + OUT] as number;
  const got = [...words.subarray(IN + 2, IN + 2 + nout)];
  assert.deepEqual(got, [...io.output], 'wasm and interpreter write the same words');
  return got;
}

test('the generator line ^TEXT writes COPY (word 14) and it round-trips through interpreter, wasm and prerender', {
  skip: findClang().path === undefined ? 'clang not found' : false,
  timeout: 1_800_000,
}, async () => {
  const bin = await buildGenerator();
  const dir = await mkdtemp(join(tmpdir(), 'a0-copy-'));
  try {
    const tpl = join(dir, 'copy.tpl');
    await writeFile(tpl, TEMPLATE);
    const source = await generate(bin, tpl, { budget: false });
    const words = await wasmWords(source, dir);
    // OPEN button(3), ATTR type, ATTR class, ATTR aria-label, COPY, TEXT "Copy", CLOSE.
    const copy = [14, ...strWords(COPY_TEXT)];
    const at = words.findIndex((w, i) => w === 14 && words[i + 1] === copy[1]);
    assert.ok(at > 0, 'the stream holds a COPY command');
    assert.deepEqual(words.slice(at, at + copy.length), copy);
    const { html, text } = renderWords(words);
    assert.ok(
      html.includes(
        '<button type="button" class="copy" aria-label="Copy the command" data-copy="claude mcp add a0 -- a0 mcp . &quot;x&quot; &lt;y&gt; &amp; z" hidden>Copy</button>',
      ),
      html,
    );
    // The static page keeps the command as text and omits the dead button's label.
    assert.ok(text.includes('claude mcp add a0'));
    assert.ok(!/\bCopy\b/.test(text), text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('prerender: COPY marks the open element hidden with the text; a stray COPY changes nothing', () => {
  const open = [1, 3, 4, 4, ...strWords('button')];
  const words = [...open, 14, ...strWords('npm i -g a0'), 2, ...strWords('Copy'), 3];
  assert.equal(
    renderWords(words).html,
    '<button type="button" data-copy="npm i -g a0" hidden>Copy</button>',
  );
  // after the start tag was written the attribute cannot be added, as with ATTR
  assert.equal(renderWords([1, 3, 2, 0, 14, ...strWords('x'), 3]).html, '<button></button>');
  // a hostile length word reads only the words present
  assert.equal(
    renderWords([1, 3, 14, 0xffff_ffff, 97]).html,
    '<button data-copy="a" hidden></button>',
  );
});

test('site/app.ts handles word 14 inside the click, with the Clipboard API first and no script injection', async () => {
  const app = await readFile('site/app.ts', 'utf8');
  assert.match(app, /case 14: \{/);
  assert.match(app, /addEventListener\('click', \(\) => void copyFor\(top, text\)\)/);
  // the Clipboard API is the first awaited call, so it runs in the user gesture
  assert.match(app, /await navigator\.clipboard\.writeText\(text\)/);
  assert.match(app, /setAttribute\('data-copied'/);
  assert.match(app, /role', 'status'/);
  assert.doesNotMatch(app, /\beval\(|new Function|innerHTML|insertAdjacentHTML|document\.write/);
  const css = await readFile('site/gen/style.css', 'utf8');
  assert.match(css, /\.copy\{[^}]*min-height:44px/);
  assert.match(css, /\.copy\[data-copied\]/);
  assert.match(css, /\.copy\[hidden\]\{display:none\}/);
});
