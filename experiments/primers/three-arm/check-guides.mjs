// Run with: bun experiments/primers/three-arm/check-guides.mjs
// These are independent language examples, never model prompts or model outcomes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAndValidate, run, validate } from '../../../src/core.ts';
import { parseDense } from '../../../src/dense.ts';
import { EditSession } from '../../../src/edit.ts';
import { createNativeEditSession } from '../../../src/source-native-edit-session.ts';
import { loadNativeSourcePackage } from '../../../src/source-native-package.ts';

const directory = process.env.A0_SOURCE_PACKAGE;
const pin = process.env.A0_SOURCE_PACKAGE_SHA256;
assert.ok(directory && pin);
const packaged = await loadNativeSourcePackage(
  await readFile(join(directory, 'manifest.json')),
  pin,
  (name) => readFile(join(directory, name)),
);
const native = packaged.instantiate();
const source = {
  canonical: `fn step u32 u32 u32 -> u32
s add p0 p2
ret s
end
fn pred u32 u32 u32 -> bool
p lt p1 2
ret p
end
fn main u32 u32 -> (u32,u32,u32x3,(u32))
x fold step 3 p0 7
y loop pred step 9 p0 7
zs arr p1 p1 p1
r rec p0
v rec x y zs r
ret v
end
fn unused u32 u32 -> u32
ret p0
end
`,
  dense: `fn step u32 u32 u32 -> u32
add A C
fn pred u32 u32 u32 -> bool
lt B 2
fn main u32 u32 -> (u32,u32,u32x3,(u32))
x fold step 3 A 7
y loop pred step 9 A 7
zs [B;3]
r (A,)
(x y zs r)
fn unused u32 u32 -> u32
A
`,
  native: `fn step _ _ _ -> _
s add A C
ret s
end
fn pred _ _ _ -> bool
p lt B 2
ret p
end
fn main _ _ -> (_,_,_x3,(_))
x fold step 3 A 7
y loop pred step 9 A 7
zs [B*3]
r (A,)
v (x y zs r)
ret v
end
fn unused _ _ -> _
ret A
end
`,
};
const nativeParse = (text) => {
  const parsed = native.parse(text);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.typed;
};
const rows = [];
try {
  for (const arm of ['canonical', 'dense', 'native']) {
    const program =
      arm === 'canonical'
        ? parseAndValidate(source[arm])
        : arm === 'dense'
          ? validate(parseDense(source[arm]))
          : nativeParse(source[arm]);
    const fn = program.byName.get('main');
    assert.ok(fn);
    assert.deepEqual(run(fn, [5, 3]), [26, 19, [3, 3, 3], [5]]);
    assert.equal(program.byName.get('unused')?.params.length, 2);
    const session =
      arm === 'native' ? createNativeEditSession(program, native) : new EditSession(program);
    const opened = session.open('unused', { dense: arm === 'dense' });
    const updated = session.apply(`${opened.handle}\nret ${arm === 'canonical' ? 'p1' : 'B'}\n`);
    assert.deepEqual(run(updated.byName.get('unused'), [5, 9]), 9);
    rows.push({
      arm,
      aggregateLoopResult: [26, 19, [3, 3, 3], [5]],
      unusedParameterCount: 2,
      editResult: 9,
    });
  }
  const escaped = validate(parseDense('fn escaped u32 -> u32\n$add add A 1\nmul $add 2\n'));
  assert.equal(run(escaped.byName.get('escaped'), [6]), 14);
  console.log(JSON.stringify({ rows, denseEscapedKeyword: 14, modelCalls: 0 }, null, 2));
} finally {
  native.close();
}
