// Unchanged lifecycle/loop/deep source fixtures with measured pre-candidate TS O0
// allocation expectations. This test data is independent of the A0 candidate.
export const LIFECYCLE = [
  {
    name: 'scalar call',
    source:
      'fn peek u32x8 u32 -> u32\nv get p0 p1\nret v\nend\nfn nonzero u32x8 u32 -> bool\nv get p0 p1\nb ne v 0\nret b\nend\nfn sum u32 u32 u32x8 -> u32\nv get p2 p1\ns add p0 v\nret s\nend\nfn more u32 u32 u32x8 -> bool\nv get p2 p1\nb le p0 v\nret b\nend\nfn copy u32x8 -> u32x8\nret p0\nend\nfn copyrec (u32,u32) -> (u32,u32)\nret p0\nend\nfn step u32x8 u32 u32x8 -> u32x8\ni add p1 7\nv get p2 i\nw add v 1\nn set p0 p1 w\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nv call peek a p1\nb set a p1 p0\nx get b p1\nr add v x\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 1,
      slices: 0,
      copiedElements: 0,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
      },
    },
  },
  {
    name: 'boolean call',
    source:
      'fn peek u32x8 u32 -> u32\nv get p0 p1\nret v\nend\nfn nonzero u32x8 u32 -> bool\nv get p0 p1\nb ne v 0\nret b\nend\nfn sum u32 u32 u32x8 -> u32\nv get p2 p1\ns add p0 v\nret s\nend\nfn more u32 u32 u32x8 -> bool\nv get p2 p1\nb le p0 v\nret b\nend\nfn copy u32x8 -> u32x8\nret p0\nend\nfn copyrec (u32,u32) -> (u32,u32)\nret p0\nend\nfn step u32x8 u32 u32x8 -> u32x8\ni add p1 7\nv get p2 i\nw add v 1\nn set p0 p1 w\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nq call nonzero a p1\nv select q p0 p1\nb set a p1 p0\nx get b p1\nr add v x\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 1,
      slices: 0,
      copiedElements: 0,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
      },
    },
  },
  {
    name: 'scalar fold',
    source:
      'fn peek u32x8 u32 -> u32\nv get p0 p1\nret v\nend\nfn nonzero u32x8 u32 -> bool\nv get p0 p1\nb ne v 0\nret b\nend\nfn sum u32 u32 u32x8 -> u32\nv get p2 p1\ns add p0 v\nret s\nend\nfn more u32 u32 u32x8 -> bool\nv get p2 p1\nb le p0 v\nret b\nend\nfn copy u32x8 -> u32x8\nret p0\nend\nfn copyrec (u32,u32) -> (u32,u32)\nret p0\nend\nfn step u32x8 u32 u32x8 -> u32x8\ni add p1 7\nv get p2 i\nw add v 1\nn set p0 p1 w\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nv fold sum 16 0 a\nb set a p1 p0\nx get b p1\nr add v x\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 1,
      slices: 0,
      copiedElements: 0,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
      },
    },
  },
  {
    name: 'scalar loop',
    source:
      'fn peek u32x8 u32 -> u32\nv get p0 p1\nret v\nend\nfn nonzero u32x8 u32 -> bool\nv get p0 p1\nb ne v 0\nret b\nend\nfn sum u32 u32 u32x8 -> u32\nv get p2 p1\ns add p0 v\nret s\nend\nfn more u32 u32 u32x8 -> bool\nv get p2 p1\nb le p0 v\nret b\nend\nfn copy u32x8 -> u32x8\nret p0\nend\nfn copyrec (u32,u32) -> (u32,u32)\nret p0\nend\nfn step u32x8 u32 u32x8 -> u32x8\ni add p1 7\nv get p2 i\nw add v 1\nn set p0 p1 w\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nv loop more sum 16 0 a\nb set a p1 p0\nx get b p1\nr add v x\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 1,
      slices: 0,
      copiedElements: 0,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
      },
    },
  },
  {
    name: 'array call retains an alias',
    source:
      'fn peek u32x8 u32 -> u32\nv get p0 p1\nret v\nend\nfn nonzero u32x8 u32 -> bool\nv get p0 p1\nb ne v 0\nret b\nend\nfn sum u32 u32 u32x8 -> u32\nv get p2 p1\ns add p0 v\nret s\nend\nfn more u32 u32 u32x8 -> bool\nv get p2 p1\nb le p0 v\nret b\nend\nfn copy u32x8 -> u32x8\nret p0\nend\nfn copyrec (u32,u32) -> (u32,u32)\nret p0\nend\nfn step u32x8 u32 u32x8 -> u32x8\ni add p1 7\nv get p2 i\nw add v 1\nn set p0 p1 w\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nold call copy a\nb set a 0 p1\nx get old 0\ny get b 0\nr add x y\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 2,
      slices: 1,
      copiedElements: 8,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        'u32-slice': {
          allocations: 1,
          elements: 8,
        },
      },
    },
  },
  {
    name: 'record call retains an alias',
    source:
      'fn peek u32x8 u32 -> u32\nv get p0 p1\nret v\nend\nfn nonzero u32x8 u32 -> bool\nv get p0 p1\nb ne v 0\nret b\nend\nfn sum u32 u32 u32x8 -> u32\nv get p2 p1\ns add p0 v\nret s\nend\nfn more u32 u32 u32x8 -> bool\nv get p2 p1\nb le p0 v\nret b\nend\nfn copy u32x8 -> u32x8\nret p0\nend\nfn copyrec (u32,u32) -> (u32,u32)\nret p0\nend\nfn step u32x8 u32 u32x8 -> u32x8\ni add p1 7\nv get p2 i\nw add v 1\nn set p0 p1 w\nret n\nend\nfn go u32 u32 -> u32\na rec p0 p1\nold call copyrec a\nb put a 0 p1\nx at old 0\ny at b 0\nr add x y\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 2,
      slices: 1,
      copiedElements: 2,
      byKind: {
        literal: {
          allocations: 1,
          elements: 2,
        },
        'record-slice': {
          allocations: 1,
          elements: 2,
        },
      },
    },
  },
  {
    name: 'old storage read after update',
    source:
      'fn peek u32x8 u32 -> u32\nv get p0 p1\nret v\nend\nfn nonzero u32x8 u32 -> bool\nv get p0 p1\nb ne v 0\nret b\nend\nfn sum u32 u32 u32x8 -> u32\nv get p2 p1\ns add p0 v\nret s\nend\nfn more u32 u32 u32x8 -> bool\nv get p2 p1\nb le p0 v\nret b\nend\nfn copy u32x8 -> u32x8\nret p0\nend\nfn copyrec (u32,u32) -> (u32,u32)\nret p0\nend\nfn step u32x8 u32 u32x8 -> u32x8\ni add p1 7\nv get p2 i\nw add v 1\nn set p0 p1 w\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nv call peek a 0\nb set a 0 p1\nx get a 0\ny get b 0\ns add v x\nr add s y\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 2,
      slices: 1,
      copiedElements: 8,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        'u32-slice': {
          allocations: 1,
          elements: 8,
        },
      },
    },
  },
  {
    name: 'state also passed as an extra',
    source:
      'fn peek u32x8 u32 -> u32\nv get p0 p1\nret v\nend\nfn nonzero u32x8 u32 -> bool\nv get p0 p1\nb ne v 0\nret b\nend\nfn sum u32 u32 u32x8 -> u32\nv get p2 p1\ns add p0 v\nret s\nend\nfn more u32 u32 u32x8 -> bool\nv get p2 p1\nb le p0 v\nret b\nend\nfn copy u32x8 -> u32x8\nret p0\nend\nfn copyrec (u32,u32) -> (u32,u32)\nret p0\nend\nfn step u32x8 u32 u32x8 -> u32x8\ni add p1 7\nv get p2 i\nw add v 1\nn set p0 p1 w\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nb fold step 9 a a\nx get b 0\ny get b 1\nr add x y\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 2,
      slices: 1,
      copiedElements: 8,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        'u32-slice': {
          allocations: 1,
          elements: 8,
        },
      },
    },
  },
  {
    name: 'fold result',
    source:
      'fn step u32x8 u32 u32 -> u32x8\nv get p0 p1\nw add v p2\nn set p0 p1 w\nret n\nend\nfn pred u32x8 u32 u32 -> bool\nb lt p1 3\nret b\nend\nfn nested u32x8 u32 u32 -> u32x8\nn fold step 17 p0 p2\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nb fold nested 9 a p1\nx get a 0\ny get b 0\nr add x y\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 2,
      slices: 1,
      copiedElements: 8,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        'u32-slice': {
          allocations: 1,
          elements: 8,
        },
      },
    },
  },
  {
    name: 'zero-trip result',
    source:
      'fn step u32x8 u32 u32 -> u32x8\nv get p0 p1\nw add v p2\nn set p0 p1 w\nret n\nend\nfn pred u32x8 u32 u32 -> bool\nb lt p1 3\nret b\nend\nfn nested u32x8 u32 u32 -> u32x8\nn fold step 0 p0 p2\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nb fold nested 9 a p1\nx get a 0\ny get b 0\nr add x y\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 2,
      slices: 1,
      copiedElements: 8,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        'u32-slice': {
          allocations: 1,
          elements: 8,
        },
      },
    },
  },
  {
    name: 'early-exit loop result',
    source:
      'fn step u32x8 u32 u32 -> u32x8\nv get p0 p1\nw add v p2\nn set p0 p1 w\nret n\nend\nfn pred u32x8 u32 u32 -> bool\nb lt p1 3\nret b\nend\nfn nested u32x8 u32 u32 -> u32x8\nn loop pred step 17 p0 p2\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nb fold nested 9 a p1\nx get a 0\ny get b 0\nr add x y\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 2,
      slices: 1,
      copiedElements: 8,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        'u32-slice': {
          allocations: 1,
          elements: 8,
        },
      },
    },
  },
  {
    name: 'essential extra-argument snapshot',
    source:
      'fn take u32x8 u32 u32x8 -> u32x8\nret p2\nend\nfn nested u32x8 u32 u32x8 -> u32x8\nv add p1 99\na set p0 p1 v\nn fold take 1 a p2\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nb fold nested 9 a a\nx get a 0\ny get b 0\nr add x y\nret r\nend\n',
    entry: 'go',
    counts: {
      allocations: 11,
      slices: 10,
      copiedElements: 80,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        'u32-slice': {
          allocations: 10,
          elements: 80,
        },
      },
    },
  },
  {
    name: 'shared fields in a nested record',
    source:
      'fn step (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)\nh at p0 0\nold at p0 1\nc at p0 2\nv get h p1\na set h p1 p2\nn add c v\ns rec a old n\nret s\nend\nfn nested (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)\nn fold step 17 p0 p2\nret n\nend\nfn go u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\ns rec a a p0\nr fold nested 9 s p1\nh at r 0\nold at r 1\nc at r 2\nx get a 0\ny get h 0\nz get old 0\nu add x y\nv add u z\nw add v c\nret w\nend\n',
    entry: 'go',
    counts: {
      allocations: 29,
      slices: 18,
      copiedElements: 144,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        literal: {
          allocations: 10,
          elements: 30,
        },
        'u32-slice': {
          allocations: 18,
          elements: 144,
        },
      },
    },
  },
  {
    name: 'disjoint owned field',
    source:
      'fn step (u32x8,u32) u32 u32 -> (u32x8,u32)\nh at p0 0\nc at p0 1\nv get h p1\nw add v p2\na set h p1 w\nn add c v\ns rec a n\nret s\nend\nfn probe u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\ns rec a p0\nr fold step 17 s p1\nh at r 0\nc at r 1\nx get h 0\ny get a 0\nz mul x 31\nv add z y\nw add v c\nret w\nend\n',
    entry: 'probe',
    counts: {
      allocations: 4,
      slices: 1,
      copiedElements: 8,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        literal: {
          allocations: 2,
          elements: 4,
        },
        'u32-slice': {
          allocations: 1,
          elements: 8,
        },
      },
    },
  },
  {
    name: 'shared initializer fields retain distinct values',
    source:
      'fn step (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)\nh at p0 0\nold at p0 1\nc at p0 2\nv get h p1\na set h p1 p2\nx get old p1\nn add c x\nq add n v\ns rec a old q\nret s\nend\nfn probe u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\nb arr p1 p0 8 7 6 5 4 3\ns rec a a p0\nr fold step 17 s p1\nh at r 0\nk at r 1\nc at r 2\nx get h 0\ny get k 0\nu get a 0\nv mul x 31\nw mul y 7\nz add v w\nq add z u\nout add q c\nret out\nend\n',
    entry: 'probe',
    counts: {
      allocations: 6,
      slices: 2,
      copiedElements: 16,
      byKind: {
        'u32-constructor': {
          allocations: 2,
          elements: 16,
        },
        literal: {
          allocations: 2,
          elements: 6,
        },
        'u32-slice': {
          allocations: 2,
          elements: 16,
        },
      },
    },
  },
  {
    name: 'duplicate field projections keep an old view',
    source:
      'fn step (u32x8,u32) u32 u32 -> (u32x8,u32)\nh at p0 0\nold at p0 0\nc at p0 1\na set h p1 p2\nx get old p1\nn add c x\ns rec a n\nret s\nend\nfn probe u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\ns rec a p0\nr fold step 17 s p1\nh at r 0\nc at r 1\nx get h 0\ny get a 0\nz mul x 31\nv add z y\nw add v c\nret w\nend\n',
    entry: 'probe',
    counts: {
      allocations: 21,
      slices: 18,
      copiedElements: 144,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        literal: {
          allocations: 2,
          elements: 4,
        },
        'u32-slice': {
          allocations: 18,
          elements: 144,
        },
      },
    },
  },
  {
    name: 'borrowed field escapes in an earlier holder record',
    source:
      'fn step (u32x8,u32) u32 u32 -> (u32x8,u32)\nh at p0 0\nholder rec h p2\nc at p0 1\na set h p1 p2\nold at holder 0\nx get old p1\nn add c x\ns rec a n\nret s\nend\nfn probe u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\ns rec a p0\nr fold step 17 s p1\nh at r 0\nc at r 1\nx get h 0\ny get a 0\nz mul x 31\nv add z y\nw add v c\nret w\nend\n',
    entry: 'probe',
    counts: {
      allocations: 38,
      slices: 18,
      copiedElements: 144,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        literal: {
          allocations: 19,
          elements: 38,
        },
        'u32-slice': {
          allocations: 18,
          elements: 144,
        },
      },
    },
  },
  {
    name: 'whole parent escapes through an identity call',
    source:
      'fn identity (u32x8,u32) -> (u32x8,u32)\nret p0\nend\nfn step (u32x8,u32) u32 u32 -> (u32x8,u32)\nold call identity p0\nh at p0 0\nc at p0 1\na set h p1 p2\nk at old 0\nx get k p1\nn add c x\ns rec a n\nret s\nend\nfn probe u32 u32 -> u32\na arr p0 p1 3 4 5 6 7 8\ns rec a p0\nr fold step 17 s p1\nh at r 0\nc at r 1\nx get h 0\ny get a 0\nz mul x 31\nv add z y\nw add v c\nret w\nend\n',
    entry: 'probe',
    counts: {
      allocations: 38,
      slices: 18,
      copiedElements: 144,
      byKind: {
        'u32-constructor': {
          allocations: 1,
          elements: 8,
        },
        literal: {
          allocations: 19,
          elements: 38,
        },
        'u32-slice': {
          allocations: 18,
          elements: 144,
        },
      },
    },
  },
] as const;
