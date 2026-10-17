import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  ALL_OPS,
  formatSource as legacySource,
  parseAndValidate,
  run,
  validate,
} from '../src/core.js';
import { parseFile } from '../src/link.js';
import { formatSource, parseSource } from '../src/source.js';
import { isReject, listSources } from '../tools/dense-loader.js';

// Compare the complete IR and attached source metadata, not just selected execution outputs.
test('candidate flat source frontend round-trips the accepted repository corpus, including comments and imports', async () => {
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

test('flat bindings and operation-named callees remain unambiguous', () => {
  for (const name of ALL_OPS) {
    const before = parseAndValidate(
      `fn ${name} u32 -> u32\na add p0 p0\nret a\nend\nfn main -> u32\na call ${name} 7\nret a\nend\n`,
    );
    const after = validate(parseSource(formatSource(before)));
    assert.equal(legacySource(after), legacySource(before));
    const main = after.byName.get('main');
    assert.ok(main);
    assert.equal(run(main, []), 14);
  }
  const source = 'profile strict\nfn foo\na div 1 A\nret a\nend\nfn main\nfoo mov A\nret A\nend\n';
  const typed = validate(parseSource(source));
  const main = typed.byName.get('main');
  assert.ok(main);
  assert.equal(run(main, [0]), 0);
});

test('flat signatures preserve unused parameters and infer uses from executable contracts', () => {
  const source = 'fn f _ _ -> _\nret A\nend\n\nfn g\npre lt C 10\nret A\nend\n';
  const program = parseSource(source);
  assert.equal(program.functions[0]?.params.length, 2);
  assert.equal(program.functions[1]?.params.length, 3);
  assert.equal(formatSource(program), source);
});

test('flat aggregate grammar is shared by nodes and executable examples', () => {
  const source = 'fn f -> _x3\nex -> [7*3]\na [7*3]\nret a\nend\n';
  const program = validate(parseSource(source));
  const f = program.byName.get('f');
  assert.ok(f);
  assert.deepEqual(run(f, []), [7, 7, 7]);
  assert.equal(formatSource(program), source);
  const bools = 'fn f -> boolx65537\na [true*65537]\nret a\nend\n';
  const large = validate(parseSource(bools));
  assert.equal(formatSource(large), bools);
  assert.throws(() => parseSource('fn f\na [1*9007199254740992]\nret a\nend\n'), /budget/);
});
