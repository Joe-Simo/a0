const inc = 'fn inc u32 -> u32\nex 0 -> 1\npre lt p0 10\npost gt r p0\nx add p0 1\nret x\nend\n';
const entry = 'use "leaf.a0"\nfn entry u32 -> u32\nex 2 -> 3\nx call inc p0\nret x\nend\n';
const failure = 'fn bad u32 -> u32\nex 1 -> 3\nx add p0 1\nret x\nend\n';
export const cases = [
  { name: 'leaf-and-entry-specs', files: { 'leaf.a0': inc, 'entry.a0': entry } },
  {
    name: 'spec-import-callee',
    files: {
      'leaf.a0': 'fn pred u32 -> bool\nret lt p0 10\nend\n',
      'entry.a0':
        'use "leaf.a0"\nfn f u32 -> u32\nex 2 -> 3\npre call pred p0\nx add p0 1\nret x\nend\n',
    },
  },
  {
    name: 'checked-spec-import',
    files: {
      'leaf.a0':
        'fn checked u32 -> (u32,bool)\nex 4294967295 -> (0,false)\nr cadd p0 1\nret r\nend\n',
      'entry.a0':
        'use "leaf.a0"\nfn f u32 -> (u32,bool)\nex 3 -> (4,true)\nx call checked p0\nret x\nend\n',
    },
  },
  {
    name: 'diamond-repeated-specs',
    files: {
      'leaf.a0': inc,
      'left.a0': 'use "leaf.a0"\nfn left -> u32\nex -> 4\nret call inc 3\nend\n',
      'right.a0': 'use "leaf.a0"\nfn right -> u32\nex -> 5\nret call inc 4\nend\n',
      'entry.a0':
        'use "left.a0"\nuse "right.a0"\nuse "leaf.a0"\nfn entry -> u32\nex -> 9\nx call left\ny call right\nret add x y\nend\n',
    },
  },
  {
    name: 'leaf-example-failure',
    files: { 'leaf.a0': failure, 'entry.a0': entry.replace('inc p0', 'bad p0') },
  },
  {
    name: 'entry-example-failure',
    files: { 'leaf.a0': inc, 'entry.a0': entry.replace('ex 2 -> 3', 'ex 2 -> 4') },
  },
  {
    name: 'early-spec-before-later-type',
    files: { 'leaf.a0': failure, 'entry.a0': 'use "leaf.a0"\nfn entry u32 -> bool\nret p0\nend\n' },
  },
  {
    name: 'own-body-before-own-spec',
    files: {
      'leaf.a0': 'fn bad u32 -> bool\nex 1 -> true\nret p0\nend\n',
      'entry.a0': 'use "leaf.a0"\nfn f -> u32\nret 0\nend\n',
    },
  },
  {
    name: 'whole-parse-before-spec',
    files: {
      'leaf.a0': failure,
      'entry.a0': 'use "leaf.a0"\nfn entry -> u32\nx add 1\nret 0\nend\n',
    },
  },
  {
    name: 'perfile-malformed-spec-before-use',
    files: { 'entry.a0': 'use "absent.a0"\nfn f -> u32\nex bad\nret 0\nend\n' },
  },
  {
    name: 'valid-wrong-example-does-not-preempt-missing-use',
    files: { 'entry.a0': 'use "absent.a0"\n' + failure },
  },
  {
    name: 'entry-grammar-before-leaf-grammar',
    files: {
      'leaf.a0': 'fn leaf -> u32\nex bad\nret 0\nend\n',
      'entry.a0': 'use "leaf.a0"\nfn entry -> u32\nx add 1\nret 0\nend\n',
    },
  },
  {
    name: 'profile-before-duplicate-before-spec',
    files: { 'leaf.a0': 'profile strict\n' + failure, 'entry.a0': 'use "leaf.a0"\n' + failure },
  },
  {
    name: 'duplicate-before-spec',
    files: { 'leaf.a0': failure, 'entry.a0': 'use "leaf.a0"\n' + failure },
  },
  {
    name: 'strict-profile-and-spec',
    files: { 'leaf.a0': 'profile strict\n' + inc, 'entry.a0': 'profile strict\n' + entry },
  },
  {
    name: 'strict-divzero-in-leaf-example',
    files: {
      'leaf.a0': 'profile strict\nfn bad u32 -> u32\nex 0 -> 0\nx div 1 p0\nret x\nend\n',
      'entry.a0': 'profile strict\nuse "leaf.a0"\nfn entry -> u32\nret 0\nend\n',
    },
  },
  {
    name: 'strict-override-traps-spec',
    override: 2,
    files: {
      'leaf.a0': 'fn bad u32 -> u32\nex 0 -> 4294967295\nx div 1 p0\nret x\nend\n',
      'entry.a0': 'use "leaf.a0"\nfn entry -> u32\nret 0\nend\n',
    },
  },
  {
    name: 'canonical-override-preserves-safe-spec',
    override: 1,
    files: { 'leaf.a0': 'profile strict\n' + inc, 'entry.a0': 'profile strict\n' + entry },
  },
  {
    name: 'post-failure-original-line',
    files: { 'leaf.a0': inc.replace('post gt r p0', 'post lt r p0'), 'entry.a0': entry },
  },
  {
    name: 'pre-failure-original-line',
    files: { 'leaf.a0': inc.replace('ex 0 -> 1', 'ex 20 -> 21'), 'entry.a0': entry },
  },
  {
    name: 'spec-type-early-before-later-body',
    files: {
      'leaf.a0': 'fn bad u32 -> u32\nex true -> 0\nret p0\nend\n',
      'entry.a0': 'use "leaf.a0"\nfn entry u32 -> bool\nret p0\nend\n',
    },
  },
  {
    name: 'spec-contract-earlier-functions-only',
    files: {
      'leaf.a0': 'fn pred u32 -> bool\nret true\nend\n',
      'entry.a0':
        'use "leaf.a0"\nfn entry u32 -> u32\npre call future p0\nret p0\nend\nfn future u32 -> bool\nret true\nend\n',
    },
  },
  {
    name: 'later-parse-after-parent-spec',
    files: {
      'leaf.a0': 'fn f -> u32\nx add 1\nret 0\nend\n',
      'entry.a0': 'use "leaf.a0"\n' + failure,
    },
  },
  {
    name: 'comment-use-survives-strip',
    files: {
      'leaf.a0': inc,
      'entry.a0': entry.replace('use "leaf.a0"', 'use "leaf.a0" # retained'),
    },
  },
  {
    name: 'unicode-newline-and-comments-origins',
    files: {
      'leaf.a0': '# λ😀\r\n' + inc.replaceAll('fn inc', 'fn\u00a0inc').replaceAll('\n', '\r\n'),
      'entry.a0': '# entry\n' + entry,
    },
  },
  {
    name: 'high-original-spec-spans',
    files: { 'leaf.a0': '#' + 'x'.repeat(131073) + '\n' + inc, 'entry.a0': entry },
  },
  {
    name: 'dense-unsupported-after-spec-parent',
    files: { 'entry.a0': 'use "leaf.a0d"\n' + failure, 'leaf.a0d': 'fn leaf -> u32\nret 0\nend\n' },
    unsupported: true,
  },
  {
    name: 'malformed-utf8-after-spec-parent',
    files: { 'entry.a0': 'use "leaf.a0"\n' + failure, 'leaf.a0': Buffer.from([0xff, 0x0a]) },
    unsupported: true,
  },
  {
    name: 'cycle-before-spec-evaluation',
    files: { 'leaf.a0': 'use "entry.a0"\n' + inc, 'entry.a0': entry },
  },
  {
    name: 'io-spec-signature-refusal',
    files: {
      'leaf.a0': 'fn bad io -> io\npre mov true\nret p0\nend\n',
      'entry.a0': 'use "leaf.a0"\nfn entry -> u32\nret 0\nend\n',
    },
  },
];
cases.push(
  {
    name: 'single-file-specs',
    files: { 'entry.a0': 'fn f u32 -> u32\nex 2 -> 3\nx add p0 1\nret x\nend\n' },
  },
  {
    name: 'unicode-profile-canonical-override-quirk-with-spec',
    override: 1,
    files: {
      'entry.a0':
        '\u00a0profile strict\nfn f u32 -> u32\nex 0 -> 4294967295\nx div 1 p0\nret x\nend\n',
    },
  },
  {
    name: 'multifile-example-fuel-origin',
    files: {
      'leaf.a0': 'fn step u32 u32 -> u32\nx mov p0\nret x\nend\n',
      'entry.a0': 'use "leaf.a0"\nfn f u32 -> u32\nex 9 -> 9\nx fold step 4000 p0\nret x\nend\n',
    },
  },
  {
    name: 'high-original-failing-spec-span',
    files: {
      'leaf.a0': '#' + 'x'.repeat(131073) + '\n' + inc.replace('post gt r p0', 'post lt r p0'),
      'entry.a0': entry,
    },
  },
);
