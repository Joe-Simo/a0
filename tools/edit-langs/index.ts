/** The further AI-edit languages defined by a LangSpec each (see spec.ts). */

import { C } from './c.js';
import { CHICKEN } from './chicken.js';
import { CLOJURE } from './clojure.js';
import { COMMONLISP } from './commonlisp.js';
import { DART } from './dart.js';
import { ELIXIR } from './elixir.js';
import { ERLANG } from './erlang.js';
import { FORTH } from './forth.js';
import { FORTRAN } from './fortran.js';
import { FSHARP } from './fsharp.js';
import { GROOVY } from './groovy.js';
import { GUILE } from './guile.js';
import { HASKELL } from './haskell.js';
import { HAXE } from './haxe.js';
import { JS } from './js.js';
import { JULIA } from './julia.js';
import { KOTLIN } from './kotlin.js';
import { LUA } from './lua.js';
import { NIM } from './nim.js';
import { OBJC } from './objc.js';
import { OCAML } from './ocaml.js';
import { PASCAL } from './pascal.js';
import { PERL } from './perl.js';
import { PHP } from './php.js';
import { PROLOG } from './prolog.js';
import { R } from './r.js';
import { RACKET } from './racket.js';
import { RUBY } from './ruby.js';
import { SCALA } from './scala.js';
import { SMALLTALK } from './smalltalk.js';
import type { LangSpec } from './spec.js';
import { SWIFT } from './swift.js';
import { TCL } from './tcl.js';
import { VB } from './vb.js';
import { ZIG } from './zig.js';

export const SPEC_LANGS = [
  'kotlin',
  'swift',
  'ruby',
  'php',
  'haskell',
  'ocaml',
  'elixir',
  'zig',
  'c',
  'js',
  'lua',
  'perl',
  'tcl',
  'objc',
  'fortran',
  'dart',
  'nim',
  'groovy',
  'clojure',
  'vb',
  'fsharp',
  'scala',
  'prolog',
  'forth',
  'guile',
  'smalltalk',
  'racket',
  'erlang',
  'commonlisp',
  'pascal',
  'r',
  'julia',
  'haxe',
  'chicken',
] as const;
export type SpecLang = (typeof SPEC_LANGS)[number];

export const SPECS: Readonly<Record<SpecLang, LangSpec>> = {
  kotlin: KOTLIN,
  swift: SWIFT,
  ruby: RUBY,
  php: PHP,
  haskell: HASKELL,
  ocaml: OCAML,
  elixir: ELIXIR,
  zig: ZIG,
  chicken: CHICKEN,
  haxe: HAXE,
  julia: JULIA,
  r: R,
  pascal: PASCAL,
  commonlisp: COMMONLISP,
  erlang: ERLANG,
  racket: RACKET,
  smalltalk: SMALLTALK,
  guile: GUILE,
  forth: FORTH,
  prolog: PROLOG,
  c: C,
  js: JS,
  lua: LUA,
  perl: PERL,
  tcl: TCL,
  objc: OBJC,
  fortran: FORTRAN,
  dart: DART,
  nim: NIM,
  groovy: GROOVY,
  clojure: CLOJURE,
  vb: VB,
  fsharp: FSHARP,
  scala: SCALA,
};
