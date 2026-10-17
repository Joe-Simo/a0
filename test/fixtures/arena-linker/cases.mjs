import assert from 'node:assert/strict';
export const fn = (name) => `fn ${name} u32 -> u32\nret add p0 1\nend\n`;
export const cases = [
  {
    name: 'diamond-unused-broken',
    files: {
      'shared.a0': fn('base'),
      'left.a0': `use "shared.a0"\n${fn('left')}`,
      'right.a0': `use "./shared.a0"\n${fn('right')}`,
      'main.a0': `use "left.a0"\nuse "sub/../right.a0"\nuse "left.a0"\n${fn('main')}`,
      'unused.a0': 'broken',
    },
  },
  {
    name: 'cycle',
    files: {
      'main.a0': `use "a.a0"\n${fn('main')}`,
      'a.a0': `use "main.a0"\n${fn('a')}`,
    },
  },
  {
    name: 'duplicate-cross-file',
    files: { 'lib.a0': fn('same'), 'main.a0': `use "lib.a0"\n${fn('same')}` },
  },
  {
    name: 'profile-before-duplicate',
    files: {
      'lib.a0': `profile strict\n${fn('same')}`,
      'main.a0': `use "lib.a0"\n${fn('same')}`,
    },
    override: 2,
  },
  {
    name: 'profile-override-canonical',
    files: {
      'lib.a0': `profile strict\n${fn('lib')}`,
      'main.a0': `profile strict\nuse "lib.a0"\n${fn('main')}`,
    },
    override: 1,
  },
  {
    name: 'profile-override-strict',
    files: { 'lib.a0': fn('lib'), 'main.a0': `use "lib.a0"\n${fn('main')}` },
    override: 2,
  },
  {
    name: 'outside-root',
    files: {
      'proj/main.a0': `use "../outside.a0"\n${fn('main')}`,
      'outside.a0': fn('outside'),
    },
    entry: 'proj/main.a0',
    root: 'proj',
  },
  {
    name: 'wrong-extension',
    files: {
      'data.txt': fn('data'),
      'main.a0': `use "data.txt"\n${fn('main')}`,
    },
  },
  {
    name: 'symlink-escape',
    files: {
      'proj/main.a0': `use "evil.a0"\n${fn('main')}`,
      'outside.a0': fn('outside'),
    },
    entry: 'proj/main.a0',
    root: 'proj',
    links: [['proj/evil.a0', 'outside.a0']],
  },
  {
    name: 'symlink-once',
    files: {
      'lib.a0': fn('lib'),
      'main.a0': `use "lib.a0"\nuse "alias.a0"\n${fn('main')}`,
    },
    links: [['alias.a0', 'lib.a0']],
  },
  {
    name: 'symlink-target-extension',
    files: {
      'data.txt': fn('data'),
      'main.a0': `use "alias.a0"\n${fn('main')}`,
    },
    links: [['alias.a0', 'data.txt']],
  },
  {
    name: 'dangling-symlink',
    files: { 'main.a0': `use "alias.a0"\n${fn('main')}` },
    links: [['alias.a0', 'gone.a0']],
  },
  {
    name: 'lexical-entry-realpath-used',
    files: { 'actual.a0': `use "actual.a0"\n${fn('main')}` },
    entry: 'alias.a0',
    links: [['alias.a0', 'actual.a0']],
  },
  {
    name: 'parse-before-missing-use',
    files: {
      'main.a0': 'use "gone.a0"\nfn main -> u32\nx add 1\nret x\nend\n',
    },
  },
  {
    name: 'within-duplicate-before-use',
    files: { 'main.a0': `use "gone.a0"\n${fn('same')}${fn('same')}` },
  },
  {
    name: 'missing-file',
    files: { 'main.a0': `use "gone.a0"\n${fn('main')}` },
  },
  {
    name: 'default-project-root',
    files: {
      'proj/package.json': '{}',
      'proj/dep.a0': fn('dep'),
      'proj/lib/main.a0': `use "../dep.a0"\n${fn('main')}`,
    },
    entry: 'proj/lib/main.a0',
    explicit: false,
  },
  {
    name: 'inside-dotdot-prefix',
    files: {
      '..inside/lib.a0': fn('lib'),
      'main.a0': `use "..inside/lib.a0"\n${fn('main')}`,
    },
  },
  {
    name: 'unicode-path-comments',
    files: {
      'λ.a0': `# header\n${fn('lib')}# tail\n`,
      'main.a0': `# import\nuse "λ.a0"\n# function\n${fn('main')}`,
    },
  },
  {
    name: 'empty-nonstandard-entry-extension',
    files: { 'entry.txt': '' },
    entry: 'entry.txt',
  },
  { name: 'source-size-limit', files: { 'main.a0': '#'.padEnd(2097153, 'a') } },
  {
    name: 'work-zero',
    files: { 'main.a0': fn('main') },
    scope: 'resource',
    work: 0,
    want: 4,
  },
  {
    name: 'dense-explicit-incomplete',
    files: { 'main.a0d': fn('main') },
    entry: 'main.a0d',
    scope: 'dense',
    want: 7,
  },
  {
    name: 'invalid-utf8-explicit-incomplete',
    files: {
      'main.a0': Uint8Array.from([35, 255, 10, ...new TextEncoder().encode(fn('main'))]),
    },
    scope: 'utf8',
    want: 7,
  },
];
const padded = (name, n) => {
  const prefix = `${fn(name)}#`;
  assert.ok(n >= prefix.length);
  return prefix.padEnd(n, 'a');
};
cases.push(
  {
    name: 'cross-file-call-return-sugar',
    files: {
      'lib.a0': fn('lib'),
      'main.a0': 'use "lib.a0"\nfn main u32 -> u32\na call lib p0\nret add a 3\nend\n',
    },
  },
  {
    name: 'trailing-use-comment-preserved',
    files: {
      'lib.a0': fn('lib'),
      'main.a0': `use "lib.a0" # comment survives regex\n${fn('main')}`,
    },
  },
  {
    name: 'unicode-profile-canonical-override',
    files: { 'main.a0': `\u00a0profile strict\n${fn('main')}` },
    override: 1,
  },
  {
    name: 'unicode-profile-after-dependency',
    files: {
      'lib.a0': `profile strict\n${fn('lib')}`,
      'main.a0': `\ufeffprofile strict\nuse "lib.a0"\n${fn('main')}`,
    },
  },
  {
    name: 'unicode-comment-kept-verbatim',
    files: {
      'main.a0': `# head\u2028use "unread.a0"\u2029tail\n${fn('main')}`,
    },
  },
  {
    name: 'blank-use-prefix-suffix',
    files: {
      'lib.a0': `\n\n${fn('lib')}`,
      'main.a0': `\n\t\nuse "lib.a0"\n\n\n${fn('main')}`,
    },
  },
  {
    name: 'fullwidth-byte-offsets',
    files: {
      'lib.a0': `#${'x'.repeat(140001)}\n${fn('lib')}`,
      'main.a0': `use "lib.a0"\n#${'y'.repeat(150003)}\n${fn('main')}`,
    },
  },
  {
    name: 'text-checked-types-and-aliases',
    files: {
      'lib.a0':
        'fn chars -> u32x2\nr text "λ"\nret r\nend\nfn checked u32 u32 -> (u32,bool)\nr cmul p0 p1\nret r\nend\n',
      'main.a0':
        'use "lib.a0"\nfn main u32 -> u32\na call chars\nb get a 0\nc call checked p0 7\nd at c 0\nret add b d\nend\n',
    },
  },
  {
    name: 'combined-source-exact-boundary',
    files: {
      'lib.a0': padded('lib', 1048576),
      'main.a0': `use "lib.a0"\n${padded('main', 1048574)}`,
    },
  },
  {
    name: 'combined-source-over-boundary',
    files: {
      'lib.a0': padded('lib', 1100000),
      'main.a0': `use "lib.a0"\n${padded('main', 1100000)}`,
    },
  },
  {
    name: 'spec-grammar-complete-awaiting-verifier',
    files: { 'main.a0': 'fn main u32 -> u32\nex 0 -> 1\nret add p0 1\nend\n' },
    scope: 'spec-grammar',
    want: 0,
  },
);

// Header removal preserves comments, CRLF, quoted path hashes and literal body separators.
cases.push(
  {
    name: 'header-comments-crlf-and-quoted-body-separators',
    files: {
      'lib#λ.a0': 'profile strict\r\nfn lib u32 -> u32\r\nret p0\r\nend\r\n',
      'main.a0':
        '\ufeffprofile\u00a0strict # mode \t\r\nuse\u2003"lib#λ.a0"\u00a0# import \u2009\r\nfn main -> u32x22\r\nx text "a\u2028profile strict\u2029z"\r\nret x\r\nend\r\n',
    },
  },
  {
    name: 'empty-dependency-trailing-use-comment-no-lf',
    files: { 'empty.a0': '# empty', 'main.a0': 'use "empty.a0" # last' },
  },
  {
    name: 'comment-only-profile-no-lf',
    files: { 'main.a0': 'profile strict # mode \t' },
  },
);
