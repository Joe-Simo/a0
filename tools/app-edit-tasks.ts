/**
 * The application-scale edit set (docs/history/2026-10-06-app-edit-preregistration.md), sealed by
 * tools/app-edit-tasks.sha256: 14 maintenance change requests to the A0 front end (lexer and parser),
 * each with the plain-language instruction both sides see, the A0 functions its view opens, the hidden
 * tests, a reference reply per side and a wrong-but-plausible reply per side (tools/app-edit-bench.ts
 * self-check: references pass, the start programs fail, the wrong replies apply and fail).
 *
 * Tests: `lex` compares the token triples (kind start length) of compiler/lex.a0 `lexsrc` and refLex;
 * `parse` compares the listed fields of the word IR of compiler/parse.a0 `parseio` and refParse; `same`
 * requires the whole word IR of the unedited reference (refParse as shipped), so the change leaves
 * those programs alone. The expected values were computed once from the TypeScript reference reply and
 * are confirmed by the A0 reference reply, which is written independently in A0.
 */

import type { WordIr } from './ref-parse.js';

export type AppTest =
  | { readonly kind: 'lex'; readonly src: string; readonly expect: readonly number[] }
  | { readonly kind: 'parse'; readonly src: string; readonly expect: Partial<WordIr> }
  | { readonly kind: 'same'; readonly src: string };
export interface AppTask {
  readonly id: string;
  /** One line for reports. */
  readonly summary: string;
  /** The change request, the same text on both sides. */
  readonly instruction: string;
  /** The A0 functions opened under e handles (e0, e1, ...), before the program handle. */
  readonly a0Targets: readonly string[];
  readonly tests: readonly AppTest[];
  /** Reference replies: A0 edit lines, a unified diff of front.ts. */
  readonly reference: { readonly a0: string; readonly ts: string };
  /** A wrong-but-plausible reply per side that applies and that the tests catch. */
  readonly wrong: { readonly a0: string; readonly ts: string; readonly why: string };
}

/** SHA-256 of the two start programs (the linked A0 front end as formatted, the TypeScript file shown). */
export const START_SHA256 = {
  a0: '82d6b798b2646d0c16a60e0c90331f1a7a394d6153d0f1a80de91a069c40fd1e',
  ts: '1a4337745c6b0ce21c649b176c29739a8c398a8ecf730f43340ba764ddf99b6c',
};

export const APP_TASKS: readonly AppTask[] = [
  {
    id: 'semicolon-comment',
    summary: 'a semicolon also starts a comment that runs to the end of the line',
    instruction:
      'Change request for the A0 front end (lexer and parser): a semicolon `;` must also start a comment, exactly like `#`: everything from it to the end of the line is dropped, the newline itself stays a token. `#` comments keep working.',
    a0Targets: ['lexstep'],
    tests: [
      {
        kind: 'lex',
        src: 'a ;x y\nb # c ; d\n',
        expect: [1, 0, 1, 5, 6, 1, 1, 7, 1, 5, 16, 1],
      },
      {
        kind: 'lex',
        src: 'x;y\n;\n"a;b" c\n',
        expect: [1, 0, 1, 5, 3, 1, 5, 5, 1, 3, 7, 3, 1, 12, 1, 5, 13, 1],
      },
      {
        kind: 'parse',
        src: '; header\nfn sq u32 -> u32 ; squares\na mul p0 p0 ;x\nret a\nend\n',
        expect: {
          code: 0,
          tok: 0,
          fns: [2, 1, 0, 0, 0, 1, 268435456],
          nodes: [4, 4, 2, 0, 0, 0],
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'issemi eq c 59 @ isat\niscom or ishash issemi @ issemi\nn4 select iscom 8 n3\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -68,1 +68,1 @@\n-    } else if (c === 35) {\n+    } else if (c === 35 || c === 59) {\n',
    },
    wrong: {
      a0: 'ishash eq c 59\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -64,1 +64,1 @@\n-    if (c === 32 || c === 9 || c === 13) i += 1;\n+    if (c === 32 || c === 9 || c === 13 || c === 59) i += 1;\n',
      why: 'A0: the semicolon replaces `#` instead of joining it; TS: the semicolon is skipped like a space, so the rest of its line is still tokens',
    },
  },
  {
    id: 'tab-is-error',
    summary: 'a tab is no longer whitespace but a one-byte error token',
    instruction:
      'Change request for the A0 front end (lexer and parser): a tab byte (9) must no longer be skipped as whitespace. It becomes a one-byte error token (kind 9, like any other byte the lexer does not know). Spaces (32) and carriage returns (13) are still skipped.',
    a0Targets: ['isspace'],
    tests: [
      {
        kind: 'lex',
        src: 'a\tb c\r\n',
        expect: [1, 0, 1, 9, 1, 1, 1, 2, 1, 1, 4, 1, 5, 6, 1],
      },
      {
        kind: 'lex',
        src: '\t\t#\tx\n"\t"\n',
        expect: [9, 0, 1, 9, 1, 1, 5, 5, 1, 3, 7, 1, 5, 9, 1],
      },
      {
        kind: 'parse',
        src: 'fn f u32 -> u32\n\ta add p0 1\nret a\nend\n',
        expect: {
          code: 1,
          tok: 6,
        },
      },
      {
        kind: 'parse',
        src: 'fn f u32 -> u32\r\na add p0 1\r\nret a\r\nend\r\n',
        expect: {
          code: 0,
          tok: 0,
          nodes: [4, 2, 2, 0, 0, 0],
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'a mov sp\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -64,1 +64,1 @@\n-    if (c === 32 || c === 9 || c === 13) i += 1;\n+    if (c === 32 || c === 13) i += 1;\n',
    },
    wrong: {
      a0: 'r mov sp\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -64,1 +64,1 @@\n-    if (c === 32 || c === 9 || c === 13) i += 1;\n+    if (c === 32) i += 1;\n',
      why: 'both: carriage returns stop being whitespace too',
    },
  },
  {
    id: 'fat-arrow',
    summary: '`=>` is accepted as a second spelling of the arrow token',
    instruction:
      'Change request for the A0 front end (lexer and parser): `=>` must be accepted as a second spelling of the arrow `->`: the lexer emits it as the arrow token (kind 4, length 2), so `fn f u32 => u32` is a valid header. An `=` that is not followed by `>` stays a one-byte error token (kind 9), also at the very end of the source.',
    a0Targets: ['lexstep', 'lexsrc'],
    tests: [
      {
        kind: 'lex',
        src: 'fn f u32 => u32\na = b\n',
        expect: [
          1, 0, 2, 1, 3, 1, 1, 5, 3, 4, 9, 2, 1, 12, 3, 5, 15, 1, 1, 16, 1, 9, 18, 1, 1, 20, 1, 5,
          21, 1,
        ],
      },
      {
        kind: 'lex',
        src: 'x==>y -> =',
        expect: [1, 0, 1, 9, 1, 1, 4, 2, 2, 1, 4, 1, 4, 6, 2, 9, 9, 1],
      },
      {
        kind: 'lex',
        src: '=',
        expect: [9, 0, 1],
      },
      {
        kind: 'parse',
        src: 'fn f u32 bool => u32\nret p0\nend\nfn g -> bool\nret true\nend\n',
        expect: {
          code: 0,
          tok: 0,
          fns: [2, 2, 0, 0, 0, 0, 536870912, 8, 0, 2, 1, 0, 0, 1073741825],
          tlist: [0, 1],
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'e0\niseq eq c 61 @ isat\nk10 eq p0 10 @ k9\nk610 or k6 k10 @ k10\narrow and k610 isgt\nemit or e1 k610\nclosed or c1 k610\nek0b select k10 9 ek0 @ ek0\nek1 select arrow 4 ek0b\nn2b select iseq 10 n2 @ n2\nn3 select isnl 5 n2b\ne1\nk10 eq pk 10 @ k9\no2 or o1 k10 @ o1\none or o2 k9\nkd select k10 9 pk @ len\nc call tokput3 out nout kd ps len pend\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -80,1 +80,1 @@\n-    } else if (c === 45 && b[i + 1] === 62) {\n+    } else if ((c === 45 || c === 61) && b[i + 1] === 62) {\n',
    },
    wrong: {
      a0: 'e0\niseq eq c 61 @ isat\nk10 eq p0 10 @ k9\nk610 or k6 k10 @ k10\narrow and k610 isgt\nemit or e1 k610\nclosed or c1 k610\nek0b select k10 9 ek0 @ ek0\nek1 select arrow 4 ek0b\nn2b select iseq 10 n2 @ n2\nn3 select isnl 5 n2b\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -83,0 +83,3 @@\n+    } else if (c === 61 && b[i + 1] === 62) {\n+      out.push(4, i, 2);\n+      i += 1;\n',
      why: 'A0: the pending `=` at the end of the source is never flushed (lexsrc unchanged); TS: the arrow advances one byte, so its `>` becomes an error token',
    },
  },
  {
    id: 'op-alias-mod',
    summary: '`mod` is accepted as a spelling of the `rem` operation',
    instruction:
      'Change request for the A0 front end (lexer and parser): accept `mod` as another spelling of the operation `rem`, the way `udiv` and `urem` are accepted for `div` and `rem`: a node `a mod p0 p1` gets the op code of `rem` in the word IR.',
    a0Targets: ['opcode'],
    tests: [
      {
        kind: 'parse',
        src: 'fn f u32 u32 -> u32\na mod p0 p1\nb rem a 3\nret mod b 2\nend\n',
        expect: {
          code: 0,
          tok: 0,
          nodes: [4, 11, 2, 0, 0, 0, 8, 11, 2, 2, 0, 0, 0, 11, 2, 4, 0, 0],
          args: [2, 0, 2, 1, 1, 0, 3, 3, 1, 1, 3, 2],
          fns: [2, 2, 0, 0, 0, 3, 268435458],
        },
      },
      {
        kind: 'parse',
        src: 'fn f u32 -> u32\na mods p0 1\nret a\nend\n',
        expect: {
          code: 2,
          tok: 7,
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'k40 eq p0 6044 @ r39\nr40 select k40 11 r39 @ k40\nret r40\n',
      ts: "--- a/front.ts\n+++ b/front.ts\n@@ -149,1 +149,1 @@\n-const IR_ALIASES: Readonly<Record<string, string>> = { udiv: 'div', urem: 'rem' };\n+const IR_ALIASES: Readonly<Record<string, string>> = { udiv: 'div', urem: 'rem', mod: 'rem' };\n",
    },
    wrong: {
      a0: 'k40 eq p0 6044 @ r39\nr40 select k40 10 r39 @ k40\nret r40\n',
      ts: "--- a/front.ts\n+++ b/front.ts\n@@ -145,1 +145,2 @@\n   'crem',\n   'cget',\n+  'mod',\n",
      why: 'A0: `mod` gets the op code of `div`; TS: `mod` becomes a new op word with its own code (38) instead of an alias of `rem`',
    },
  },
  {
    id: 'drop-unsigned-aliases',
    summary: 'the `udiv` and `urem` spellings are withdrawn',
    instruction:
      'Change request for the A0 front end (lexer and parser): withdraw the accepted spellings `udiv` and `urem`; only `div` and `rem` name those operations now. A node `a udiv p0 p1` then reads `udiv` as the name of a function it calls, which is a structure error when no earlier function has that name. The parser reports the first diagnostic as (code, token index), code 1 a parse error and 2 a structure error; token indexes count the tokens of the lexer (comments and spaces make no tokens; each newline is one).',
    a0Targets: ['opcode'],
    tests: [
      {
        kind: 'parse',
        src: 'fn f u32 u32 -> u32\na udiv p0 p1\nret a\nend\n',
        expect: {
          code: 2,
          tok: 8,
        },
      },
      {
        kind: 'parse',
        src: 'fn f u32 u32 -> u32\na div p0 p1\nret urem a p1\nend\n',
        expect: {
          code: 2,
          tok: 13,
        },
      },
      {
        kind: 'parse',
        src: 'fn urem u32 u32 -> u32\nret p0\nend\nfn g u32 -> u32\na urem p0 2\nb rem a 2\nret b\nend\n',
        expect: {
          code: 0,
          tok: 0,
          nodes: [8, 19, 2, 0, 0, 0, 9, 11, 2, 2, 0, 0],
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: '-k32\n-r32\n-k33\n-r33\nr34 select k34 32 r31\n',
      ts: "--- a/front.ts\n+++ b/front.ts\n@@ -149,1 +149,1 @@\n-const IR_ALIASES: Readonly<Record<string, string>> = { udiv: 'div', urem: 'rem' };\n+const IR_ALIASES: Readonly<Record<string, string>> = {};\n",
    },
    wrong: {
      a0: '-k32\n-r32\nr33 select k33 11 r31\n',
      ts: "--- a/front.ts\n+++ b/front.ts\n@@ -149,1 +149,1 @@\n-const IR_ALIASES: Readonly<Record<string, string>> = { udiv: 'div', urem: 'rem' };\n+const IR_ALIASES: Readonly<Record<string, string>> = { urem: 'rem' };\n",
      why: 'both: only `udiv` is withdrawn, `urem` is still read as `rem`',
    },
  },
  {
    id: 'text-escape-r',
    summary: 'the text-literal escape `\\r` decodes to a carriage return (13)',
    instruction:
      'Change request for the A0 front end (lexer and parser): in a `text "..."` literal the escape `\\r` must decode to a carriage return, byte 13, next to the existing `\\n` (10) and `\\t` (9). Any other escaped byte still stands for itself.',
    a0Targets: ['txtb'],
    tests: [
      {
        kind: 'parse',
        src: 'fn f -> u32\nt text "a\\rb\\n\\t\\\\\\"r"\nret 0\nend\n',
        expect: {
          code: 0,
          args: [3, 97, 3, 13, 3, 98, 3, 10, 3, 9, 3, 92, 3, 34, 3, 114],
        },
      },
      {
        kind: 'parse',
        src: 'fn f -> u32\nt text "\\r\\R"\nret 0\nend\n',
        expect: {
          code: 0,
          args: [3, 13, 3, 82],
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'isr eq c 114 @ ist\nm2 select isr 13 m1 @ m1\nv select e1 m2 c\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -579,1 +579,1 @@\n-                pushArg(3, e === 110 ? 10 : e === 116 ? 9 : e);\n+                pushArg(3, e === 110 ? 10 : e === 116 ? 9 : e === 114 ? 13 : e);\n',
    },
    wrong: {
      a0: 'isr eq c 82 @ ist\nm2 select isr 13 m1 @ m1\nv select e1 m2 c\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -579,1 +579,1 @@\n-                pushArg(3, e === 110 ? 10 : e === 116 ? 9 : e);\n+                pushArg(3, e === 110 ? 10 : e === 116 ? 9 : e === 82 ? 13 : e);\n',
      why: 'both: the escape is read on an uppercase `R` (82) instead of `r` (114)',
    },
  },
  {
    id: 'text-escape-zero',
    summary: 'the text-literal escape `\\0` decodes to a zero byte',
    instruction:
      'Change request for the A0 front end (lexer and parser): in a `text "..."` literal the escape `\\0` (a backslash, then the digit zero) must decode to the byte 0. A zero digit that is not escaped is still the byte 48, and the other escapes are unchanged.',
    a0Targets: ['txtb'],
    tests: [
      {
        kind: 'parse',
        src: 'fn f -> u32\nt text "0\\00\\n"\nret 0\nend\n',
        expect: {
          code: 0,
          args: [3, 48, 3, 0, 3, 48, 3, 10],
        },
      },
      {
        kind: 'parse',
        src: 'fn f -> u32\nt text "\\\\0\\0"\nret 0\nend\n',
        expect: {
          code: 0,
          args: [3, 92, 3, 48, 3, 0],
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'isz eq c 48 @ ist\nm2 select isz 0 m1 @ m1\nv select e1 m2 c\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -579,1 +579,1 @@\n-                pushArg(3, e === 110 ? 10 : e === 116 ? 9 : e);\n+                pushArg(3, e === 110 ? 10 : e === 116 ? 9 : e === 48 ? 0 : e);\n',
    },
    wrong: {
      a0: 'isz eq c 48 @ ist\nm2 select isz 0 m1 @ m1\nw0 select isz 0 c @ m2\nv select e1 m2 w0\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -579,1 +579,1 @@\n-                pushArg(3, e === 110 ? 10 : e === 116 ? 9 : e);\n+                pushArg(3, e === 110 ? 10 : e === 116 ? 9 : e === 0 ? 48 : e);\n',
      why: 'A0: the zero is decoded whether or not it was escaped; TS: the mapping is written the wrong way round (byte 0 to 48)',
    },
  },
  {
    id: 'profile-canonical',
    summary: 'a first line `profile canonical` is accepted as the explicit default profile',
    instruction:
      'Change request for the A0 front end (lexer and parser): the first line of a file may now also be `profile canonical`, the explicit spelling of the default. Like `profile strict` its two tokens are then ignored by the rest of the parse, but the profile reported in the word IR (the second word, `tok`, when there is no diagnostic) stays 0; `profile strict` still reports 1. Any other word after `profile` is still a parse error at that word. The parser reports the first diagnostic as (code, token index), code 1 a parse error and 2 a structure error; token indexes count the tokens of the lexer (comments and spaces make no tokens; each newline is one).',
    a0Targets: ['dirfix', 'pass1'],
    tests: [
      {
        kind: 'parse',
        src: 'profile canonical\nfn f u32 -> u32\nret p0\nend\n',
        expect: {
          code: 0,
          tok: 0,
          fns: [4, 1, 0, 0, 0, 0, 536870912],
          pool: [
            114, 101, 116, 118, 97, 108, 112, 114, 111, 102, 105, 108, 101, 99, 97, 110, 111, 110,
            105, 99, 97, 108, 102, 110, 102, 117, 51, 50, 114, 101, 116, 112, 48, 101, 110, 100,
          ],
        },
      },
      {
        kind: 'parse',
        src: '\nprofile strict\nfn f u32 -> u32\nret p0\nend\n',
        expect: {
          code: 0,
          tok: 1,
          fns: [4, 1, 0, 0, 0, 0, 536870912],
        },
      },
      {
        kind: 'parse',
        src: 'profile canonica\nfn f u32 -> u32\nret p0\nend\n',
        expect: {
          code: 1,
          tok: 1,
        },
      },
      {
        kind: 'parse',
        src: 'profile canonical x\nfn f u32 -> u32\nret p0\nend\n',
        expect: {
          code: 1,
          tok: 2,
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'e0\ncn call iscanon lo1 hi1 so1 @ st\nw9 eq n1 9 @ cn\nw1c and w1k w9 @ w9\nhasc and w1c cn @ w1c\nhasw or hasst hasc @ hasc\nnost select hasw false true\neb0 and isdir hasw\nokst and okd hasst @ okd\nokc and okd hasc @ okst\np1v select okst 1 0 @ okc\nprof select okc 2 p1v\nfn iscanon u32x128 u32x128 u32 -> bool\nb0 call dirbyte p0 p1 p2 0\nb1 call dirbyte p0 p1 p2 1\nb2 call dirbyte p0 p1 p2 2\nb3 call dirbyte p0 p1 p2 3\nb4 call dirbyte p0 p1 p2 4\nb5 call dirbyte p0 p1 p2 5\nb6 call dirbyte p0 p1 p2 6\nb7 call dirbyte p0 p1 p2 7\nb8 call dirbyte p0 p1 p2 8\ne0 eq b0 99\ne1 eq b1 97\ne2 eq b2 110\ne3 eq b3 111\ne4 eq b4 110\ne5 eq b5 105\ne6 eq b6 99\ne7 eq b7 97\ne8 eq b8 108\na0 and e0 e1\na1 and a0 e2\na2 and a1 e3\na3 and a2 e4\na4 and a3 e5\na5 and a4 e6\na6 and a5 e7\nr and a6 e8\nret r\nend\ne1\nokd ne prof 0\nps eq prof 1 @ okd\npv select ps 1 0 @ ps\nr rec x0 x1 ta2 x3 x4 x5 x6 x7 x8 x9 x10 err3 et3 x13 x14 x15 pv\n',
      ts: "--- a/front.ts\n+++ b/front.ts\n@@ -253,1 +253,1 @@\n-      if (word(ft + 1) !== 'strict') fail(1, ft + 1);\n+      if (word(ft + 1) !== 'strict' && word(ft + 1) !== 'canonical') fail(1, ft + 1);\n@@ -256,1 +256,1 @@\n-        strict = true;\n+        strict = word(ft + 1) === 'strict';\n",
    },
    wrong: {
      a0: 'e0\ncn call iscanon lo1 hi1 so1 @ st\nw9 eq n1 9 @ cn\nw1c and w1k w9 @ w9\nhasc and w1c cn @ w1c\nhasw or hasst hasc @ hasc\nnost select hasw false true\neb0 and isdir hasw\nfn iscanon u32x128 u32x128 u32 -> bool\nb0 call dirbyte p0 p1 p2 0\nb1 call dirbyte p0 p1 p2 1\nb2 call dirbyte p0 p1 p2 2\nb3 call dirbyte p0 p1 p2 3\nb4 call dirbyte p0 p1 p2 4\nb5 call dirbyte p0 p1 p2 5\nb6 call dirbyte p0 p1 p2 6\nb7 call dirbyte p0 p1 p2 7\nb8 call dirbyte p0 p1 p2 8\ne0 eq b0 99\ne1 eq b1 97\ne2 eq b2 110\ne3 eq b3 111\ne4 eq b4 110\ne5 eq b5 105\ne6 eq b6 99\ne7 eq b7 97\ne8 eq b8 108\na0 and e0 e1\na1 and a0 e2\na2 and a1 e3\na3 and a2 e4\na4 and a3 e5\na5 and a4 e6\na6 and a5 e7\nr and a6 e8\nret r\nend\n',
      ts: "--- a/front.ts\n+++ b/front.ts\n@@ -253,1 +253,1 @@\n-      if (word(ft + 1) !== 'strict') fail(1, ft + 1);\n+      if (word(ft + 1) !== 'strict' && word(ft + 1) !== 'canonical') fail(1, ft + 1);\n",
      why: 'both: `profile canonical` is accepted but reported as the strict profile (1)',
    },
  },
  {
    id: 'array-length-limit',
    summary: 'array lengths in type words are limited to 4096',
    instruction:
      'Change request for the A0 front end (lexer and parser): tighten the array types of headers. Every length in an array type word (each group of `u32xAxB`, `boolxA`, and the `xA` suffix of a record type) must now be at most 4096; a larger one is a parse error at that type word, as a zero length already is. The parser reports the first diagnostic as (code, token index), code 1 a parse error and 2 a structure error; token indexes count the tokens of the lexer (comments and spaces make no tokens; each newline is one).',
    a0Targets: ['grpb', 'arrword'],
    tests: [
      {
        kind: 'parse',
        src: 'fn f u32x4096 -> u32\nret 0\nend\n',
        expect: {
          code: 0,
          tok: 0,
          types: [1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 4096, 0],
        },
      },
      {
        kind: 'parse',
        src: 'fn f u32x4097 -> u32\nret 0\nend\n',
        expect: {
          code: 1,
          tok: 2,
        },
      },
      {
        kind: 'parse',
        src: 'fn f u32 u32x5000x2 -> u32\nret 0\nend\n',
        expect: {
          code: 1,
          tok: 3,
        },
      },
      {
        kind: 'parse',
        src: 'fn f u32 -> (u32,bool)x9999\nret 0\nend\n',
        expect: {
          code: 1,
          tok: 9,
        },
      },
      {
        kind: 'parse',
        src: 'fn f boolx2x4096 -> boolx8000\nret 0\nend\n',
        expect: {
          code: 1,
          tok: 4,
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'e0\nsmall le v 4096 @ pos\npos2 and pos small @ small\ngok and have pos2\ne1\nsmall le v 4096 @ pos\npos2 and pos small @ small\ngok and have pos2\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -353,1 +353,1 @@\n-        if (n === undefined || n === 0) return undefined;\n+        if (n === undefined || n === 0 || n > 4096) return undefined;\n',
    },
    wrong: {
      a0: 'e1\nsmall le v 4096 @ pos\npos2 and pos small @ small\ngok and have pos2\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -353,1 +353,1 @@\n-        if (n === undefined || n === 0) return undefined;\n+        if (n === undefined || n === 0 || n >= 4096) return undefined;\n',
      why: 'A0: only the last group of a type word is checked (grpb unchanged); TS: 4096 itself is refused',
    },
  },
  {
    id: 'param-limit',
    summary: 'a function header may declare at most 8 parameters',
    instruction:
      'Change request for the A0 front end (lexer and parser): a function header may now declare at most 8 parameters. A header with more is a parse error at its arrow token `->`. The parser reports the first diagnostic as (code, token index), code 1 a parse error and 2 a structure error; token indexes count the tokens of the lexer (comments and spaces make no tokens; each newline is one).',
    a0Targets: ['p3tok'],
    tests: [
      {
        kind: 'parse',
        src: 'fn f u32 u32 u32 u32 u32 u32 u32 u32 -> u32\nret p7\nend\n',
        expect: {
          code: 0,
          tok: 0,
          fns: [2, 8, 0, 0, 0, 0, 536870919],
        },
      },
      {
        kind: 'parse',
        src: 'fn f u32 u32 u32 u32 u32 u32 u32 u32 bool -> u32\nret p7\nend\n',
        expect: {
          code: 1,
          tok: 11,
        },
      },
      {
        kind: 'parse',
        src: 'fn g -> u32\nret 1\nend\nfn f (u32,u32) u32x2 bool u32 u32 u32 u32 u32 (bool,bool) -> u32\nret 0\nend\n',
        expect: {
          code: 1,
          tok: 29,
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'many gt cnt 8 @ np2\neamany and earrow many @ many\nbad7 or bad6 eamany @ bad6\nbad and bad7 noerr\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -446,1 +446,2 @@\n         if (mode !== 1 || depth !== 0) fail(1, i);\n+        else if (stk.length - 1 > 8) fail(1, i);\n',
    },
    wrong: {
      a0: 'many gt cnt 9 @ np2\neamany and earrow many @ many\nbad7 or bad6 eamany @ bad6\nbad and bad7 noerr\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -446,1 +446,2 @@\n         if (mode !== 1 || depth !== 0) fail(1, i);\n+        else if (stk.length > 8) fail(1, i);\n',
      why: 'both: off by one (A0 allows 9; TS counts the stack sentinel and refuses 8)',
    },
  },
  {
    id: 'duplicate-fn-structure',
    summary:
      'a second function with an existing name becomes a structure error (2), not a parse error',
    instruction:
      'Change request for the A0 front end (lexer and parser): a function header whose name an earlier function already has must now be reported as a structure error (code 2) instead of a parse error (code 1), still at the name token of the second header. A reserved word as a function name stays a parse error (1). The parser reports the first diagnostic as (code, token index), code 1 a parse error and 2 a structure error; token indexes count the tokens of the lexer (comments and spaces make no tokens; each newline is one).',
    a0Targets: ['p4hdr'],
    tests: [
      {
        kind: 'parse',
        src: 'fn f u32 -> u32\nret p0\nend\nfn f u32 -> u32\nret 1\nend\n',
        expect: {
          code: 2,
          tok: 12,
        },
      },
      {
        kind: 'parse',
        src: 'fn a -> u32\nret 0\nend\nfn b -> u32\nret 1\nend\nfn a -> bool\nret true\nend\n',
        expect: {
          code: 2,
          tok: 21,
        },
      },
      {
        kind: 'parse',
        src: 'fn ret u32 -> u32\nret p0\nend\n',
        expect: {
          code: 1,
          tok: 1,
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'err2 select bad 2 err\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -400,1 +400,2 @@\n-        if (k !== 1 || RESERVED_KEYS.includes(key(i)) || findFn(symAt(i), nfns) < nfns) fail(1, i);\n+        if (k !== 1 || RESERVED_KEYS.includes(key(i))) fail(1, i);\n+        else if (findFn(symAt(i), nfns) < nfns) fail(2, i);\n',
    },
    wrong: {
      a0: 'err2 select bad 2 err\net2 select bad p1 errtok\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -400,1 +400,1 @@\n-        if (k !== 1 || RESERVED_KEYS.includes(key(i)) || findFn(symAt(i), nfns) < nfns) fail(1, i);\n+        if (k !== 1 || RESERVED_KEYS.includes(key(i)) || findFn(symAt(i), nfns) < nfns) fail(2, i);\n',
      why: 'A0: the diagnostic names the header number instead of its name token; TS: a reserved function name becomes a structure error too',
    },
  },
  {
    id: 'number-leading-zero',
    summary: 'a number literal with a leading zero (other than 0 itself) is a parse error',
    instruction:
      'Change request for the A0 front end (lexer and parser): a number operand written with a leading zero, such as `007` or `00`, is now a parse error at that number, like a number with a non-digit byte. `0` itself and numbers such as `10` and `100` are still fine; parameters (`p0`, `p12`) are not affected. The parser reports the first diagnostic as (code, token index), code 1 a parse error and 2 a structure error; token indexes count the tokens of the lexer (comments and spaces make no tokens; each newline is one).',
    a0Targets: ['p1tok'],
    tests: [
      {
        kind: 'parse',
        src: 'fn f u32 -> u32\na add p0 007\nret a\nend\n',
        expect: {
          code: 1,
          tok: 9,
        },
      },
      {
        kind: 'parse',
        src: 'fn f u32 -> u32\na add p0 0\nb add a 100\nret 00\nend\n',
        expect: {
          code: 1,
          tok: 17,
        },
      },
      {
        kind: 'parse',
        src: 'fn f u32 -> u32\na add p0 0\nb add a 10\nret b\nend\n',
        expect: {
          code: 0,
          tok: 0,
          args: [2, 0, 3, 0, 1, 0, 3, 10],
          fns: [2, 1, 0, 0, 0, 2, 268435457],
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'lz0 eq c0 48 @ dig\nlz1 gt len 1 @ lz0\nlz2 and lz0 lz1 @ lz1\nlz and lz2 k2 @ lz2\nnlz select lz false true @ lz\ndigok and dig nlz @ nlz\ndb select digok 2048 0\n',
      ts: "--- a/front.ts\n+++ b/front.ts\n@@ -516,3 +516,4 @@\n       if (kind(i) === 2) {\n+        if (len(i) > 1 && b[start(i)] === 48) return 'bad';\n         const v = digits(start(i), len(i));\n         return v === undefined ? 'bad' : [3, v];\n",
    },
    wrong: {
      a0: 'lz0 eq c0 48 @ dig\nlz and lz0 k2 @ lz0\nnlz select lz false true @ lz\ndigok and dig nlz @ nlz\ndb select digok 2048 0\n',
      ts: "--- a/front.ts\n+++ b/front.ts\n@@ -516,3 +516,4 @@\n       if (kind(i) === 2) {\n+        if (b[start(i)] === 48) return 'bad';\n         const v = digits(start(i), len(i));\n         return v === undefined ? 'bad' : [3, v];\n",
      why: 'both: every number starting with 0 is refused, `0` itself included',
    },
  },
  {
    id: 'unreserve-patch',
    summary: 'the word `patch` is no longer reserved',
    instruction:
      'Change request for the A0 front end (lexer and parser): the word `patch` is no longer reserved. It may now name a function and a node like any other identifier. The other reserved words (`fn`, `ret`, `end`, `true`, `false`) stay reserved. The parser reports the first diagnostic as (code, token index), code 1 a parse error and 2 a structure error; token indexes count the tokens of the lexer (comments and spaces make no tokens; each newline is one).',
    a0Targets: ['kwcode'],
    tests: [
      {
        kind: 'parse',
        src: 'fn patch u32 -> u32\npatch add p0 1\nret patch\nend\nfn g u32 -> u32\na patch p0\nret a\nend\n',
        expect: {
          code: 0,
          tok: 0,
          fns: [2, 1, 0, 0, 0, 1, 268435456, 8, 1, 1, 0, 1, 1, 268435456],
          nodes: [2, 2, 2, 0, 0, 0, 9, 19, 1, 2, 0, 0],
          args: [2, 0, 3, 1, 2, 0],
        },
      },
      {
        kind: 'parse',
        src: 'fn f u32 -> bool\nfalse eq p0 1\nret false\nend\n',
        expect: {
          code: 1,
          tok: 6,
        },
      },
      {
        kind: 'parse',
        src: 'fn f u32 -> bool\na eq p0 1\nret false\nend\n',
        expect: {
          code: 0,
          tok: 0,
          fns: [2, 1, 0, 1, 0, 1, 1073741824],
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: '-k7\n-r7\nret r6\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -183,1 +183,1 @@\n-const RESERVED_KEYS = [KW.fn, KW.ret, KW.end, KW.true, KW.false, KW.patch];\n+const RESERVED_KEYS = [KW.fn, KW.ret, KW.end, KW.true, KW.false];\n',
    },
    wrong: {
      a0: '-k6\n-r6\nr7 select k7 7 r5\n',
      ts: '--- a/front.ts\n+++ b/front.ts\n@@ -400,1 +400,1 @@\n-        if (k !== 1 || RESERVED_KEYS.includes(key(i)) || findFn(symAt(i), nfns) < nfns) fail(1, i);\n+        if (k !== 1 || [KW.fn, KW.ret, KW.end, KW.true, KW.false].includes(key(i)) || findFn(symAt(i), nfns) < nfns) fail(1, i);\n',
      why: 'A0: the keyword removed is `false` (the key 10349683), not `patch` (15172680); TS: `patch` is freed as a function name only, a node named `patch` is still refused',
    },
  },
  {
    id: 'use-alias-import',
    summary: '`import "file.a0"` is accepted as a second spelling of a `use` line',
    instruction:
      'Change request for the A0 front end (lexer and parser): a line `import "file.a0"` must be accepted as a second spelling of `use "file.a0"`, with the same rules (only before the first function, one string, then the end of the line) and the same entry in the `uses` table of the word IR.',
    a0Targets: ['kwcode'],
    tests: [
      {
        kind: 'parse',
        src: 'import "a.a0"\nuse "b.a0"\nimport "a.a0"\nfn f -> u32\nret 0\nend\n',
        expect: {
          code: 0,
          tok: 0,
          uses: [2, 4, 2],
          pool: [
            114, 101, 116, 118, 97, 108, 105, 109, 112, 111, 114, 116, 97, 46, 97, 48, 117, 115,
            101, 98, 46, 97, 48, 102, 110, 102, 117, 51, 50, 114, 101, 116, 101, 110, 100,
          ],
          fns: [6, 0, 0, 0, 0, 0, 805306368],
        },
      },
      {
        kind: 'parse',
        src: 'fn f -> u32\nret 0\nend\nimport "a.a0"\n',
        expect: {
          code: 1,
          tok: 10,
        },
      },
      {
        kind: 'parse',
        src: 'import x\nfn f -> u32\nret 0\nend\n',
        expect: {
          code: 1,
          tok: 1,
        },
      },
      {
        kind: 'same',
        src: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
      },
      {
        kind: 'same',
        src: '# a small program\nuse "lib.a0"\nfn inc u32 -> u32\na add p0 1 # one more\nret a\nend\nfn g u32x4 (u32,bool) -> u32\nb at p1 0\nc get p0 2\nd call inc c\ne div d 3\nf select true e b\nt text "hi\\n"\nret f\nend\n',
      },
      {
        kind: 'same',
        src: 'fn h u32x4x2 boolx3 -> (u32,u32x4)\nx get p0 1\ny get x 0\nz rec y x\nret z\nend\nfn k u32 u32 -> u32\nret sub p0 p1\nend\n',
      },
    ],
    reference: {
      a0: 'k8 eq p0 1421396227 @ r7\nr8 select k8 4 r7 @ k8\nret r8\n',
      ts: "--- a/front.ts\n+++ b/front.ts\n@@ -175,1 +175,2 @@\n   use: keyOf('use'),\n+  import: keyOf('import'),\n@@ -279,1 +280,1 @@\n-      } else if (atLine && key(i) === KW.use) {\n+      } else if (atLine && (key(i) === KW.use || key(i) === KW.import)) {\n@@ -536,1 +537,1 @@\n-        } else if (kk === KW.use) mode = 10;\n+        } else if (kk === KW.use || kk === KW.import) mode = 10;\n",
    },
    wrong: {
      a0: 'k8 eq p0 1421396227 @ r7\nr8 select k8 1 r7 @ k8\nret r8\n',
      ts: "--- a/front.ts\n+++ b/front.ts\n@@ -175,1 +175,2 @@\n   use: keyOf('use'),\n+  import: keyOf('import'),\n@@ -279,1 +280,1 @@\n-      } else if (atLine && key(i) === KW.use) {\n+      } else if (atLine && (key(i) === KW.use || key(i) === KW.import)) {\n",
      why: 'A0: `import` is given the keyword code of `fn` (1), not of `use` (4); TS: the body pass still refuses an `import` line at the top level',
    },
  },
];
