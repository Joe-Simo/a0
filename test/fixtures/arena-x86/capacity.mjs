import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { emitProgram, emitSource, ROOT } from './transport.mjs';

const invalid =
    'fn bad -> u32\na arr ' + Array(70017).fill('0').join(' ') + '\nr get a 0\nret r\nend\n',
  rejected = emitSource(invalid);
assert.equal(rejected.status, 8, rejected.stderr);
assert.equal(rejected.meta.checked[1], 206);
assert.equal(rejected.text, '');
const reports = [
    {
      name: 'u32-aggregate70017-language-A0206',
      mode: 'source',
      code: 8,
      diagnostic: 206,
      bytesPublished: 0,
    },
  ],
  fixtures = [
    [
      'functions1000',
      Array.from(
        { length: 1000 },
        (_, i) => `fn f${i} u32 -> u32\nr add p0 ${i}\nret r\nend\n`,
      ).join(''),
      'extern uint32_t a0_f0(uint32_t),a0_f999(uint32_t);',
      'return a0_f0(7)!=7 || a0_f999(4294967295u)!=998;',
    ],
    [
      'nodes3000',
      'fn chain u32 -> u32\n' +
        Array.from(
          { length: 3000 },
          (_, i) => `v${i} add ${i === 0 ? 'p0' : `v${i - 1}`} 1\n`,
        ).join('') +
        'ret v2999\nend\n',
      'extern uint32_t a0_chain(uint32_t);',
      'return a0_chain(4294967295u)!=2999;',
    ],
    [
      'operands65536',
      'fn wide u32 u32 -> u32\na arr ' +
        Array(65536).fill('p0').join(' ') +
        '\nx get a p1\nret x\nend\n',
      'extern uint32_t a0_wide(uint32_t,uint32_t);',
      'return a0_wide(3735928559u,4294967295u)!=3735928559u;',
    ],
    [
      'record70017',
      'fn recordwide -> bool\na rec ' +
        Array(70017).fill('true').join(' ') +
        '\nr at a 70016\nret r\nend\n',
      'extern uint32_t a0_recordwide(void);',
      'return a0_recordwide()!=1;',
    ],
  ];
for (const [name, source, decl, body] of fixtures)
  for (const mode of ['source', 'table']) {
    const r = mode === 'source' ? emitSource(source) : emitProgram(parseAndValidate(source));
    assert.equal(r.status, 0, r.stderr);
    const d = ROOT + '/capacities/' + mode + '-' + name;
    await mkdir(d, { recursive: true });
    await writeFile(d + '/source.a0', source);
    await writeFile(d + '/module.s', r.text);
    await writeFile(
      d + '/driver.c',
      '#include <stdint.h>\n' + decl + '\nint main(void){' + body + '}\n',
    );
    const c = spawnSync(
      'clang',
      [
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        d + '/module.s',
        d + '/driver.c',
        '-o',
        d + '/program',
      ],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(c.status, 0, c.stderr);
    assert.equal(spawnSync(d + '/program', [], { timeout: 60000 }).status, 0, name);
    reports.push({
      name,
      mode,
      sourceBytes: source.length,
      assemblyBytes: r.text.length,
      ctxCounts: r.meta.context?.slice(11, 14),
      actualLinuxX86TargetExecution: true,
    });
    console.log(mode, name, 'passed');
  }
await writeFile(
  ROOT + '/capacity-results.json',
  JSON.stringify(
    {
      kind: 'Actual native A0 full-word source and table emission across legacy function/node/16-bit operand boundaries, actual x86 runtime',
      reports,
    },
    null,
    2,
  ) + '\n',
);
