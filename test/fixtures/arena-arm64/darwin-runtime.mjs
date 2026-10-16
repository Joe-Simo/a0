import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { findClang } from '../../../dist/src/toolchain.js';
import { checkedCases } from '../../../dist/test/fixtures/checked-ops-fixtures.js';
import { abiCases } from '../../../dist/test/fixtures/native-ports/abi.js';
import { nativePortPureCases } from '../../../dist/test/fixtures/native-ports/semantic.js';
import { checkArm64Assembly } from '../../../dist/tools/verify.js';
import { emitSource, ROOT } from './transport.mjs';

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const clang = findClang();
assert.ok(clang.path);
const inputs = new URL('./sources/', import.meta.url),
  reports = [];
const source = await readFile(new URL('pure.a0', inputs), 'utf8'),
  r = emitSource(source);
assert.equal(r.status, 0, r.stderr);
const p = parseAndValidate(source),
  cases = [...nativePortPureCases(), ...abiCases()],
  proof = await checkArm64Assembly(
    p,
    r.text,
    cases,
    clang,
    'native A0 arena ARM64 full-word source service',
  );
assert.equal(proof.status, 'passed', JSON.stringify(proof));
assert.equal(proof.cases, cases.length);
reports.push({ name: 'canonical', cases: cases.length, actualDarwinArm64Execution: true });
const checkedSource = await readFile(new URL('strict-checked-source.a0', inputs), 'utf8'),
  checked = emitSource(checkedSource);
assert.equal(checked.status, 0, checked.stderr);
const checkedProof = await checkArm64Assembly(
  parseAndValidate(checkedSource),
  checked.text,
  checkedCases(),
  clang,
  'native A0 arena ARM64 strict checked totals',
);
assert.equal(checkedProof.status, 'passed', JSON.stringify(checkedProof));
assert.equal(checkedProof.cases, checkedCases().length);
reports.push({
  name: 'strict-checked',
  cases: checkedCases().length,
  actualDarwinArm64Execution: true,
});
const aliasDir = `${ROOT}/abi`;
await mkdir(aliasDir, { recursive: true });
await writeFile(`${aliasDir}/module.s`, r.text);
await writeFile(
  `${aliasDir}/alias.s`,
  '\t.text\n\t.globl _a0_probe_alias\n\t.p2align 2\n_a0_probe_alias:\n\tmov x8, x0\n\tb _a0_abi_pack\n',
);
await writeFile(
  `${aliasDir}/driver.c`,
  `#include <stdint.h>
#include <stdbool.h>
typedef struct {uint32_t a[3],sum,flag;} pack;
extern pack a0_abi_pack(const uint32_t*,uint32_t,bool,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t);
extern void a0_probe_alias(uint32_t*,uint32_t,bool,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t);
int main(void){uint32_t indexes[]={0,1,2,3,UINT32_MAX};for(unsigned f=0;f<2;f++)for(unsigned i=0;i<5;i++){uint32_t n=indexes[i],a[5]={11,12,13,0,0},expected[3]={11,12,13};expected[n%3]=77;pack p=a0_abi_pack(a,n,f!=0,17,19,23,29,77);for(unsigned k=0;k<3;k++)if(p.a[k]!=expected[k]||a[k]!=11+k)return 1;if(p.sum!=(uint32_t)(88u+n)||p.flag!=f)return 2;a0_probe_alias(a,n,f!=0,17,19,23,29,77);for(unsigned k=0;k<3;k++)if(a[k]!=expected[k])return 3;if(a[3]!=(uint32_t)(88u+n)||a[4]!=f)return 4;}return 0;}
`,
);
const ac = spawnSync(
  clang.path,
  [
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    `${aliasDir}/module.s`,
    `${aliasDir}/alias.s`,
    `${aliasDir}/driver.c`,
    '-o',
    `${aliasDir}/program`,
  ],
  { encoding: 'utf8', timeout: 60000 },
);
assert.equal(ac.status, 0, ac.stderr);
assert.equal(spawnSync(`${aliasDir}/program`, [], { timeout: 60000 }).status, 0);
reports.push({
  name: 'x8-sret-and-overlapping-input',
  cases: 20,
  actualDarwinArm64Execution: true,
});
const fix = {
  bounds: 'keep the index below the length (check it, or use cget for a total read)',
  divzero: 'test the divisor first, or use cdiv/crem, which return (0,false) for a zero divisor',
};
for (const [name, decl, body, traps, safe] of [
  [
    'strict',
    'extern uint32_t a0_divide(uint32_t,uint32_t),a0_bound(uint32_t),a0_folded(uint32_t),a0_looped(uint32_t);',
    'switch(atoi(argv[1])){case 0:return a0_divide(13,0);case 1:return a0_bound(3);case 2:return a0_folded(9);case 3:return a0_looped(1);default:return a0_divide(13,2)!=6||a0_bound(0)!=11||a0_bound(2)!=33;}',
    [
      ['divzero', 'divide', '-', '-', 'divide'],
      ['bounds', 'bound', '-', '-', 'bound'],
      ['divzero', 'stp', 'folded.iteration', 2, 'folded>stp'],
      ['bounds', 'pred', 'looped.original_loop', 2, 'looped>pred'],
    ],
    4,
  ],
  [
    'strict-extra',
    'extern uint32_t a0_remzero(uint32_t,uint32_t),a0_both(uint32_t,uint32_t),a0_update(uint32_t),a0_top(uint32_t),a0_after(uint32_t),a0_trap(void),a0_skip(uint32_t);',
    'switch(atoi(argv[1])){case 0:return a0_remzero(UINT32_MAX,0);case 1:return a0_both(2,9);case 2:return a0_both(0,9);case 3:return a0_update(2);case 4:return a0_top(9);case 5:return a0_after(9);default:return a0_trap()!=7||a0_update(0)!=99||a0_update(1)!=13||a0_skip(UINT32_MAX)!=UINT32_MAX;}',
    [
      ['divzero', 'remzero', '-', '-', 'remzero'],
      ['bounds', 'both', '-', '-', 'both'],
      ['divzero', 'both', '-', '-', 'both'],
      ['bounds', 'update', '-', '-', 'update'],
      ['divzero', 'stp', 'middle.iteration', 2, 'top>middle>stp'],
      ['divzero', 'after', '-', '-', 'after'],
    ],
    6,
  ],
]) {
  const s = await readFile(new URL(`${name}.a0`, inputs), 'utf8'),
    emitted = emitSource(s);
  assert.equal(emitted.status, 0, emitted.stderr);
  const d = `${ROOT}/${name}`;
  await mkdir(d, { recursive: true });
  await writeFile(`${d}/module.s`, emitted.text);
  await writeFile(
    `${d}/driver.c`,
    '#include <stdint.h>\n#include <stdlib.h>\n' +
      decl +
      '\nint main(int argc,char **argv){if(argc!=2)return 90;' +
      body +
      '}\n',
  );
  const built = spawnSync(
    clang.path,
    ['-O2', '-Wall', '-Wextra', '-Werror', `${d}/module.s`, `${d}/driver.c`, '-o', `${d}/program`],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(built.status, 0, built.stderr);
  for (let i = 0; i < traps.length; i++) {
    const [kind, fn, at, trip, chain] = traps[i],
      ran = spawnSync(`${d}/program`, [String(i)], { encoding: 'utf8', timeout: 60000 });
    assert.equal(ran.status, 3, ran.stderr);
    assert.equal(ran.stdout, '');
    assert.equal(
      ran.stderr,
      `runtime: trap ${kind} fn=${fn} at=${at} trip=${trip} chain=${chain} fix: ${fix[kind]}\n`,
    );
  }
  assert.equal(spawnSync(`${d}/program`, [String(safe)], { timeout: 60000 }).status, 0);
  reports.push({ name, cases: traps.length + 1, actualDarwinArm64Execution: true });
}
await writeFile(
  `${ROOT}/darwin-runtime-results.json`,
  `${JSON.stringify(
    {
      kind: 'Fresh seed-built A0 source service followed by actual Darwin ARM64 linked execution; independent BigInt/checked/ABI/alias/trap text oracles',
      reports,
    },
    null,
    2,
  )}\n`,
);
console.log('Actual Darwin ARM64 source-service target runtime oracles passed');
