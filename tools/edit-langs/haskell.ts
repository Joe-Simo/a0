/**
 * Haskell: u32 values are Data.Word.Word32 (wrapping arithmetic, unsigned compares);
 * records are tuples, u32x4 and grid arrays are [Word32] lists indexed with !!. Module Lib
 * (the candidate) and Main (the driver) are built with ghc -O0 into one executable.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
import type { FillerFunction } from '../ai-edit-tasks-c.js';
import {
  arrayElem,
  BUILD_MS,
  failure,
  type LangCase,
  type LangSpec,
  RUN_MS,
  recordFields,
  signature,
  tool,
} from './spec.js';

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return `(${v} :: Word32)`;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i] ?? arrayElem(t)));
  return fields.length > 0 ? `(${items.join(', ')})` : `[${items.join(', ')}]`;
}

function render(expr: string, t: Type | undefined, depth = 0): string {
  if (t === 'bool') return `(if ${expr} then "true" else "false")`;
  const fields = recordFields(t);
  if (fields.length > 0) {
    const names = fields.map((_, i) => `v${depth}_${i}`);
    const parts = fields
      .map((ft, i) => render(names[i] as string, ft, depth + 1))
      .join(' ++ "," ++ ');
    return `((\\(${names.join(', ')}) -> "[" ++ ${parts} ++ "]") ${expr})`;
  }
  const elem = arrayElem(t);
  if (elem !== undefined)
    return `("[" ++ intercalate "," (map (\\e${depth} -> ${render(`e${depth}`, elem, depth + 1)}) ${expr}) ++ "]")`;
  return `show (${expr} :: Word32)`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => ` ${literal(a, params[k])}`).join('');
      return `  putStrLn ("R${i} " ++ ${render(`(${t.fn}${args})`, result)})`;
    })
    .join('\n');
  return `module Main (main) where\n\nimport Data.List (intercalate)\nimport Data.Word (Word32)\nimport Lib\n\nmain :: IO ()\nmain = do\n${body}\n  putStrLn "DONE"\n`;
}

const W = 'Word32';
const U4 = '[Word32]';

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: `fits :: ${W} -> ${W} -> Bool\nfits a b = a < b\n`,
    reference: `fits :: ${W} -> ${W} -> Bool\nfits a b = a <= b\n`,
  },
  'b-sumfrom-eight': {
    source: `sumfrom :: ${W} -> ${W}\nsumfrom x = foldl (\\s i -> s + i) x [0 .. 4]\n`,
    reference: `sumfrom :: ${W} -> ${W}\nsumfrom x = foldl (\\s i -> s + i) x [0 .. 7]\n`,
  },
  'b-rot8-constant': {
    source: `rot8 :: ${W} -> ${W}\nrot8 x = shiftL x 8 .|. shiftR x 23\n`,
    reference: `rot8 :: ${W} -> ${W}\nrot8 x = shiftL x 8 .|. shiftR x 24\n`,
  },
  'b-onlyone-xor': {
    source: 'onlyone :: Bool -> Bool -> Bool\nonlyone a b = a || b\n',
    reference: 'onlyone :: Bool -> Bool -> Bool\nonlyone a b = a /= b\n',
  },
  'b-avgfloor-nowrap': {
    source: `avgfloor :: ${W} -> ${W} -> ${W}\navgfloor a b = shiftR (a + b) 1\n`,
    reference: `avgfloor :: ${W} -> ${W} -> ${W}\navgfloor a b = (a .&. b) + shiftR (xor a b) 1\n`,
  },
  'b-sumsq-array': {
    source: `sumsq :: ${U4} -> ${W}\nsumsq a = foldl (\\s i -> s + a !! i) 0 [0 .. 3]\n`,
    reference: `sumsq :: ${U4} -> ${W}\nsumsq a = foldl (\\s i -> s + a !! i * a !! i) 0 [0 .. 3]\n`,
  },
  'b-inrange-inclusive': {
    source: `inrange :: ${W} -> ${W} -> ${W} -> Bool\ninrange x lo hi = x > lo && x < hi\n`,
    reference: `inrange :: ${W} -> ${W} -> ${W} -> Bool\ninrange x lo hi = x >= lo && x <= hi\n`,
  },
  'b-bounds-largest': {
    source: `bounds :: ${U4} -> (${W}, ${W})\nbounds a = foldl step (0xFFFFFFFF, 0) [0 .. 3]\n  where\n    step (lo, hi) i =\n      let x = a !! i\n      in (if x < lo then x else lo, if x < hi then x else hi)\n`,
    reference: `bounds :: ${U4} -> (${W}, ${W})\nbounds a = foldl step (0xFFFFFFFF, 0) [0 .. 3]\n  where\n    step (lo, hi) i =\n      let x = a !! i\n      in (if x < lo then x else lo, if x > hi then x else hi)\n`,
  },
  'b-checksum-poly': {
    source: `checksum :: ${U4} -> ${W}\nchecksum a = foldl (\\h i -> xor h (a !! i)) 0 [0 .. 3]\n`,
    reference: `checksum :: ${U4} -> ${W}\nchecksum a = foldl (\\h i -> h * 31 + a !! i) 7 [0 .. 3]\n`,
  },
  'b-norm2-dot': {
    source: `dot :: ${U4} -> ${U4} -> ${W}\ndot a b = foldl (\\s i -> s + a !! i * b !! i) 0 [0 .. 3]\n`,
    reference: `dot :: ${U4} -> ${U4} -> ${W}\ndot a b = foldl (\\s i -> s + a !! i * b !! i) 0 [0 .. 3]\nnorm2 :: ${U4} -> ${W}\nnorm2 a = dot a a\n`,
  },
  'b-pctof-limit': {
    source: `limit :: ${W} -> ${W} -> ${W} -> ${W}\nlimit x lo hi =\n  let b = if x < lo then lo else x\n  in if b > hi then hi else b\n`,
    reference: `limit :: ${W} -> ${W} -> ${W} -> ${W}\nlimit x lo hi =\n  let b = if x < lo then lo else x\n  in if b > hi then hi else b\npctof :: ${W} -> ${W} -> ${W}\npctof part whole =\n  let n = part * 100\n      q = if whole == 0 then 0xFFFFFFFF else div n whole\n  in limit q 0 100\n`,
  },
  'b-hamming-popcnt': {
    source: `popcnt :: ${W} -> ${W}\npopcnt x = foldl (\\s i -> s + (shiftR x i .&. 1)) 0 [0 .. 31]\n`,
    reference: `popcnt :: ${W} -> ${W}\npopcnt x = foldl (\\s i -> s + (shiftR x i .&. 1)) 0 [0 .. 31]\nhamming :: ${W} -> ${W} -> ${W}\nhamming a b = popcnt (xor a b)\n`,
  },
};

const FILLER = `affine :: Word32 -> Word32 -> Word32 -> Word32
affine x scale offset = x * scale + offset
clamp :: Word32 -> Word32 -> Word32
clamp x hi = if hi < x then hi else x
rotl :: Word32 -> Word32 -> Word32
rotl x n = shiftL x (fromIntegral (n .&. 31)) .|. shiftL x (fromIntegral ((32 - n) .&. 31))
sq :: Word32 -> Word32
sq x = x * x
quad :: Word32 -> Word32
quad x = sq x
absdiff :: Word32 -> Word32 -> Word32
absdiff a b = a - b
combine4 :: Word32 -> Word32 -> Word32 -> Word32 -> Word32
combine4 a b c d = a + b + c + d
min2 :: Word32 -> Word32 -> Word32
min2 a b = if b < a then b else a
sumto :: Word32 -> Word32
sumto n = foldl (\\s i -> s + i) 0 (takeWhile (< n) [0 ..])
countup :: Word32 -> Word32 -> Word32
countup limit cap = go 0 0
  where
    go k s = if k < cap && s < limit then go (k + 1) (s + 1) else s
pick :: (Word32, Bool) -> Word32
pick r = fst r
byte1 :: Word32 -> Word32
byte1 x = shiftR x 8 .&. 0xFF
sadd :: Word32 -> Word32 -> Word32
sadd a b = a + b
is_even :: Word32 -> Bool
is_even x = x .&. 1 == 0
addi :: Word32 -> Word32 -> Word32
addi acc i = acc + i
inc :: Word32 -> Word32 -> Word32 -> Word32
inc s i limit = s + 1
below :: Word32 -> Word32 -> Word32 -> Bool
below s i limit = s < limit
addel :: Word32 -> Word32 -> [Word32] -> Word32
addel acc i a = acc + a !! fromIntegral (mod i 4)
minmax :: (Word32, Word32) -> Word32 -> [Word32] -> (Word32, Word32)
minmax (lo, hi) i a =
  let x = a !! fromIntegral (mod i 4)
      nlo = if x < lo then x else lo
      nhi = if x < hi then x else hi
  in (nlo, nhi)
mixel :: Word32 -> Word32 -> [Word32] -> Word32
mixel acc i a = xor acc (a !! fromIntegral (mod i 4))
dstep :: Word32 -> Word32 -> [Word32] -> [Word32] -> Word32
dstep acc i a b = acc + a !! fromIntegral (mod i 4) * b !! fromIntegral (mod i 4)
pstep :: Word32 -> Word32 -> Word32 -> Word32
pstep acc i x = acc + (shiftR x (fromIntegral (i .&. 31)) .&. 1)
nb :: [Word32] -> Word32 -> Word32 -> Word32
nb grid r c =
  let row = grid !! fromIntegral (mod r 32)
  in shiftR row (fromIntegral (c .&. 31)) .&. 1
count :: [Word32] -> Word32 -> Word32 -> Word32
count grid r c =
  let ru = r - 1
      rd = r + 1
      cl = c - 1
      cr = c + 1
  in nb grid ru cl + nb grid ru c + nb grid ru cr + nb grid r cl
       + nb grid r cr + nb grid rd cl + nb grid rd c + nb grid rd cr
bitstep :: Word32 -> Word32 -> Word32 -> Word32
bitstep acc i x = acc + (shiftR x (fromIntegral (i .&. 31)) .&. 1)
popcount :: Word32 -> Word32
popcount x = foldl (\\n i -> bitstep n i x) 0 [0 .. 31]
rowpop :: Word32 -> Word32 -> [Word32] -> Word32
rowpop acc i grid = acc + popcount (grid !! fromIntegral (mod i 32))
population :: [Word32] -> Word32
population grid = foldl (\\n i -> rowpop n i grid) 0 [0 .. 31]
`;

function fillerText(f: FillerFunction): string {
  const s = f.spec;
  const u = (e: string): string => `${f.name} :: ${W} -> ${W}\n${f.name} x = ${e}\n`;
  const b = (e: string): string => `${f.name} :: ${W} -> ${W} -> ${W}\n${f.name} a b = ${e}\n`;
  switch (s.template) {
    case 'lin':
      return u(`x * ${s.m} + ${s.c}`);
    case 'xs':
      return u(`xor x (shiftR x ${s.s})`);
    case 'cap':
      return u(`if x < ${s.c} then x else ${s.c}`);
    case 'pair':
      return b(`xor (a + b) ${s.c}`);
    case 'sum':
      return u(`${s.g} x + ${s.h} x`);
    case 'mixin':
      return b(`xor (${s.g} a) b`);
  }
}

export const HASKELL: LangSpec = {
  semantics:
    'Integers are unsigned 32-bit Data.Word.Word32: +, -, * wrap modulo 2^32 and comparisons are unsigned; use Data.Bits (.&., .|., xor, shiftL, shiftR) and mask shift counts to 5 bits (.&. 31), since shifting a Word32 by 32 or more gives 0. Division by zero gives 4294967295; remainder by zero gives the dividend. Records are tuples and u32x4 arrays are [Word32] lists indexed with !!; every function has its type signature line first. The file is module Lib (everything exported), built with ghc -O0 together with a Main driver that imports it.',
  head: /^([a-z_][A-Za-z0-9_']*) ::/,
  file: (body) =>
    `module Lib where\n\nimport Data.Bits (shiftL, shiftR, xor, (.&.), (.|.))\nimport Data.Word (Word32)\n\n${body}`,
  b: B,
  filler: FILLER,
  fillerText,
  driver,
  compileLabel: 'ghc',
  async buildAndRun(dir, source, drv) {
    const ghc = tool('ghc', 'A0_GHC', ['/opt/homebrew/bin/ghc']);
    await writeFile(join(dir, 'Lib.hs'), source, 'utf8');
    await writeFile(join(dir, 'Main.hs'), drv, 'utf8');
    const exe = join(dir, 'main');
    const build = runTool(
      ghc,
      ['-O0', '-v0', `-i${dir}`, '-outputdir', join(dir, 'out'), '-o', exe, join(dir, 'Main.hs')],
      { cwd: dir, timeoutMs: BUILD_MS },
    );
    if (!build.ok) return failure('ghc', build);
    const run = runTool(exe, [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
