import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  A0Error,
  ALL_OPS,
  LIMITS,
  formatSource as legacySource,
  parse,
  parseAndValidate,
  run,
  validate,
} from '../src/core.js';
import { parseFile } from '../src/link.js';
import { formatSource, parseSource } from '../src/source.js';
import { isReject, listSources } from '../tools/dense-loader.js';

function getFunction(program: ReturnType<typeof validate>, name = 'f') {
  const fn = program.byName.get(name);
  assert.ok(fn, name);
  return fn;
}

// Compare the complete IR and attached source metadata, not just selected execution outputs.
test('candidate source frontend round-trips the accepted repository corpus, including comments and imports', async () => {
  const paths = listSources(process.cwd()).filter((path) => !isReject(path, process.cwd()));
  assert.ok(paths.length >= 100);
  for (const path of paths) {
    const { program } = await parseFile(path, (p) => readFile(p, 'utf8'));
    const text = formatSource(program);
    const back = parseSource(text);
    assert.equal(legacySource(back), legacySource(program), path);
    assert.equal(formatSource(back), text, `${path}: formatter fixed point`);
  }
});

test('candidate source keeps a callee name distinct from a node binding under strict semantics', () => {
  const original = parseAndValidate(
    'profile strict\nfn foo u32 -> u32\nbad div 1 p0\nret bad\nend\nfn f u32 -> u32\nfoo mov p0\nret p0\nend\n',
  );
  const text = formatSource(original);
  assert.ok(text.includes('foo=mov(A)'));
  const back = validate(parseSource(text));
  assert.equal(run(getFunction(back), [0]), 0);
  assert.equal(legacySource(back), legacySource(original));
});

test('candidate source can call functions whose names are operations or source directives', () => {
  for (const name of [...ALL_OPS, 'text', 'use', 'profile', 'pre', 'post', 'ex']) {
    const program = parseAndValidate(
      `fn ${name} u32 -> u32\nr mul p0 2\nret r\nend\nfn main u32 -> u32\nr call ${name} p0\nret r\nend\n`,
    );
    const text = formatSource(program),
      back = validate(parseSource(text));
    assert.equal(run(getFunction(back, 'main'), [7]), 14, name);
    assert.equal(legacySource(back), legacySource(program), name);
  }
});

test('candidate expressions have no implicit mixed-operator precedence or comparison chains', () => {
  for (const expr of ['A+B*C', 'A<B<C', 'A/B/C'])
    assert.throws(() => parseSource(`fn f(A,B,C)\n${expr}\n`), A0Error, expr);
  const typed = validate(parseSource('fn f(A,B,C)\nA+(B*C)\n'));
  assert.equal(run(getFunction(typed), [2, 3, 4]), 14);
  const left = validate(parseSource('fn f(A,B,C)\nA-B-C\n'));
  assert.equal(run(getFunction(left), [10, 3, 2]), 5);
});

test('candidate scanning shares Unicode whitespace and text literal semantics', () => {
  const text =
    '# header\nprofile strict # mode\nfn f(A) # fn\n# node\na=mov(\u2003A\u00a0) # keep\n# result\na # ret\n# ending\nend # end\n\n# tail\n';
  const p = parseSource(text);
  assert.equal(legacySource(parseSource(formatSource(p))), legacySource(p));
  const unicode = parse('fn f -> u32x6\nx text "é # \\n"\nret x\nend\n');
  assert.equal(legacySource(parseSource(formatSource(unicode))), legacySource(unicode));
  assert.throws(
    () => parseSource('fn f()\n"bad\\r"\n'),
    (e: unknown) => e instanceof A0Error && e.id === 'A0008',
  );
});

test('candidate expressions and formatting support the full node budget without JS recursion', () => {
  const text = `fn f(A)\n${'mov('.repeat(LIMITS.maxNodesPerFunction)}A${')'.repeat(LIMITS.maxNodesPerFunction)}\n`;
  const parsed = parseSource(text);
  assert.equal(parsed.functions[0]?.nodes.length, LIMITS.maxNodesPerFunction);
  assert.equal(formatSource(parsed), text);
  const typed = validate(parsed);
  assert.equal(run(getFunction(typed), [7]), 7);
  assert.throws(
    () => parseSource(text.replace('mov(A)', 'mov(mov(A))')),
    (e: unknown) => e instanceof A0Error && e.id === 'A0027',
  );
});

test('candidate parser enforces source, parameter and repeat bounds before expanding values', () => {
  assert.throws(
    () => parseSource(' '.repeat(LIMITS.maxSourceBytes + 1)),
    (e: unknown) => e instanceof A0Error && e.id === 'A0016',
  );
  const ps = Array.from({ length: LIMITS.maxParams + 1 }, (_, i) => `P${i}`).join(',');
  assert.throws(
    () => parseSource(`fn f(${ps})\n0\n`),
    (e: unknown) => e instanceof A0Error && e.id === 'A0024',
  );
  for (const count of ['0', '65537', '9007199254740992'])
    assert.throws(() => parseSource(`fn f()\n[1;${count}]\n`), A0Error);
  assert.equal(
    parseSource('fn f() -> u32x65536\n[1;65536]\n').functions[0]?.nodes[0]?.args.length,
    65536,
  );
});
