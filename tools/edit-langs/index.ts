/** The eight further AI-edit languages defined by a LangSpec each (see spec.ts). */

import { ELIXIR } from './elixir.js';
import { HASKELL } from './haskell.js';
import { KOTLIN } from './kotlin.js';
import { OCAML } from './ocaml.js';
import { PHP } from './php.js';
import { RUBY } from './ruby.js';
import type { LangSpec } from './spec.js';
import { SWIFT } from './swift.js';
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
};
