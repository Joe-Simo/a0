// Handwritten source pairs. Neither spelling is produced by a compiler or formatter.
export const sharedCases = [
  {
    name: 'inferred-header-examples-and-contracts',
    canonical:
      'fn below_ten u32 -> bool\nx lt p0 10\nret x\nend\n' +
      'fn f u32 -> u32\nex 7 ->7\nex 9 ->9\npre call below_ten p0\npost eq r p0\nret p0\nend\n',
    flat:
      'fn below_ten _ -> bool\nx lt A 10\nret x\nend\n' +
      'fn f\nex 7 ->7\nex 9 ->9\npre below_ten A\npost eq r A\nret A\nend\n',
    status: 0,
  },
  {
    name: 'nested-record-array-literals',
    canonical:
      'fn keep (u32x2,(bool,u32)) -> (u32x2,(bool,u32))\n' +
      'ex ([1;2];(true;9)) ->([1;2];(true;9))\nret p0\nend\n',
    flat:
      'fn keep (_x2,(bool,_)) -> (_x2,(bool,_))\n' +
      'ex ([1,2] (true 9)) ->([1,2] (true 9))\nret A\nend\n',
    status: 0,
  },
  {
    name: 'array-trailing-separators',
    canonical: 'fn f u32x2 -> u32x2\nex [1;2;] ->[1;2;]\nret p0\nend\n',
    flat: 'fn f _x2 -> _x2\nex [1,2,] ->[1,2,]\nret A\nend\n',
    status: 0,
  },
  {
    name: 'record-trailing-separators',
    canonical: 'fn f (u32,bool) -> (u32,bool)\nex (1;true;) ->(1;true;)\nret p0\nend\n',
    flat: 'fn f (_,bool) -> (_,bool)\nex (1,true,) ->(1,true,)\nret A\nend\n',
    status: 0,
  },
  {
    name: 'singleton-record-separators',
    canonical: 'fn f (u32) -> (u32)\nex (7;) ->(7;)\nret p0\nend\n',
    flat: 'fn f (_) -> (_)\nex (7,) ->(7,)\nret A\nend\n',
    status: 0,
  },
  {
    name: 'nested-singleton-record-separators',
    canonical: 'fn f ((u32)) -> ((u32))\nex ((7;);) ->((7;);)\nret p0\nend\n',
    flat: 'fn f ((_)) -> ((_))\nex ((7,),) ->((7,),)\nret A\nend\n',
    status: 0,
  },
  {
    name: 'earlier-example-before-later-body-error',
    canonical:
      'fn f u32 -> u32\nex 1 ->2\nret p0\nend\n' +
      'fn later u32 -> u32\nx add true p0\nret x\nend\n',
    flat: 'fn f\nex 1 ->2\nret A\nend\nfn later\nx add true A\nret x\nend\n',
    status: 8,
    id: 715,
    kind: 3,
    visited: 1,
  },
  {
    name: 'whole-source-grammar-before-earlier-example',
    canonical:
      'fn f u32 -> u32\nex 1 ->2\nret p0\nend\n' + 'fn later u32 -> u32\nx add p0\nret x\nend\n',
    flat: 'fn f\nex 1 ->2\nret A\nend\nfn later\nx add A\nret x\nend\n',
    status: 6,
    id: 14,
    visited: 0,
  },
  {
    name: 'empty-array-remains-invalid',
    canonical: 'fn f u32x1 -> u32x1\nex [] ->[1]\nret p0\nend\n',
    flat: 'fn f _x1 -> _x1\nex [] ->[1]\nret A\nend\n',
    status: 6,
    id: 714,
  },
  {
    name: 'empty-record-remains-invalid',
    canonical: 'fn f (u32) -> (u32)\nex () ->(1;)\nret p0\nend\n',
    flat: 'fn f (_) -> (_)\nex () ->(1,)\nret A\nend\n',
    status: 6,
    id: 714,
  },
  {
    name: 'singleton-record-requires-separator',
    canonical: 'fn f (u32) -> (u32)\nex (1) ->(1;)\nret p0\nend\n',
    flat: 'fn f (_) -> (_)\nex (1) ->(1,)\nret A\nend\n',
    status: 6,
    id: 714,
  },
  {
    name: 'repeated-separators-remain-invalid',
    canonical: 'fn f u32x2 -> u32x2\nex [1;;2] ->[1;2]\nret p0\nend\n',
    flat: 'fn f _x2 -> _x2\nex [1,,2] ->[1,2]\nret A\nend\n',
    status: 6,
    id: 714,
  },
  {
    name: 'record-type-trailing-comma-remains-invalid',
    canonical: 'fn f (u32,) -> u32\nret 1\nend\n',
    flat: 'fn f (_,) -> _\nret 1\nend\n',
    status: 6,
    id: 1,
  },
  {
    name: 'record-type-semicolon-remains-invalid',
    canonical: 'fn f (u32;bool) -> u32\nret 1\nend\n',
    flat: 'fn f (_;bool) -> _\nret 1\nend\n',
    status: 6,
    id: 1,
  },
];

// Adjacency is a separate legacy capability from explicit and trailing separators.
export const legacyAdjacencyCases = [
  {
    name: 'adjacent-nested-arrays-without-separator',
    canonical: 'fn f (u32x1,u32x1) -> (u32x1,u32x1)\nex ([1][2]) ->([1][2])\nret p0\nend\n',
    flat: 'fn f (_x1,_x1) -> (_x1,_x1)\nex ([1] [2]) ->([1] [2])\nret A\nend\n',
    status: 0,
  },
  {
    name: 'adjacent-number-and-boolean-without-separator',
    canonical: 'fn f (u32,bool) -> (u32,bool)\nex (1true) ->(1true)\nret p0\nend\n',
    flat: 'fn f (_,bool) -> (_,bool)\nex (1 true) ->(1 true)\nret A\nend\n',
    status: 0,
  },
];

// Native parser inputs use the explicit flat aggregate contract. Historical
// canonical/flat pairs above remain unchanged as migration and semantic oracles.
export const nativeSpecInputs = {
  'nested-record-array-literals': {
    canonical:
      'fn keep (u32x2,(bool,u32)) -> (u32x2,(bool,u32))\n' +
      'ex ([1 2] (true 9)) ->([1 2] (true 9))\nret p0\nend\n',
  },
  'array-trailing-separators': {
    canonical: 'fn f u32x2 -> u32x2\nex [1 2] ->[1 2]\nret p0\nend\n',
    flat: 'fn f _x2 -> _x2\nex [1,2] ->[1,2]\nret A\nend\n',
  },
  'record-trailing-separators': {
    canonical: 'fn f (u32,bool) -> (u32,bool)\nex (1 true) ->(1 true)\nret p0\nend\n',
    flat: 'fn f (_,bool) -> (_,bool)\nex (1,true) ->(1,true)\nret A\nend\n',
  },
  'singleton-record-separators': {
    canonical: 'fn f (u32) -> (u32)\nex (7,) ->(7,)\nret p0\nend\n',
  },
  'nested-singleton-record-separators': {
    canonical: 'fn f ((u32)) -> ((u32))\nex ((7,),) ->((7,),)\nret p0\nend\n',
  },
  'repeated-separators-remain-invalid': {
    canonical: 'fn f u32x2 -> u32x2\nex [1,,2] ->[1 2]\nret p0\nend\n',
  },
  'adjacent-nested-arrays-without-separator': {
    canonical: 'fn f (u32x1,u32x1) -> (u32x1,u32x1)\nex ([1] [2]) ->([1] [2])\nret p0\nend\n',
  },
  'adjacent-number-and-boolean-without-separator': {
    canonical: 'fn f (u32,bool) -> (u32,bool)\nex (1 true) ->(1 true)\nret p0\nend\n',
  },
};
