import assert from 'node:assert/strict';

const scalar = (value) => {
  assert.ok(typeof value === 'number' || typeof value === 'boolean');
  return Number(value);
};
const cType = (type) => {
  assert.ok(type === 'u32' || type === 'bool' || type === 'io');
  return type === 'u32' ? 'uint32_t' : type === 'bool' ? 'bool' : 'a0_io*';
};
function nativeHeader(program) {
  const declarations = program.functions.flatMap((fn) => {
    if (!(fn.result === 'u32' || fn.result === 'bool')) return [];
    if (!fn.params.every((type) => type === 'u32' || type === 'bool' || type === 'io')) return [];
    return [
      `extern ${cType(fn.result)} a0_${fn.name}(${fn.params.map(cType).join(',') || 'void'});`,
    ];
  });
  return `#include <stdint.h>
#include <stdbool.h>
typedef struct { uint32_t input[256],ninput,position,output[1024],noutput; } a0_io;
${declarations.join('\n')}
extern void a0_abi_pack(uint32_t*,const uint32_t*,uint32_t,bool,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t);
static int sret_alias_probe(void) {
  uint32_t value[5] = {11,12,13,0,0};
  a0_abi_pack(value,value,4,true,17,19,23,29,77);
  return value[0] != 11 || value[1] != 77 || value[2] != 13 || value[3] != 92 || value[4] != 1;
}
`;
}
function caseInput(program, cases) {
  const names = new Map(program.functions.map((fn, i) => [fn.name, i]));
  return `${cases
    .map((item) =>
      [
        names.get(item.functionName),
        ...item.args.map(scalar),
        ...(item.input === undefined ? [] : [item.input.length, ...item.input]),
      ].join(' '),
    )
    .join('\n')}\n`;
}

export { caseInput, nativeHeader, scalar };
