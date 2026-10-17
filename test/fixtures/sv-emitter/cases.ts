export function directedFixtures() {
  const tests: [string, string, number][] = [
    [
      'bool-arr',
      'fn f bool -> bool\na arr p0 true false\nb set a 5 true\nr get b 2\nret r\nend\n',
      0,
    ],
    [
      'bool-record',
      'fn f bool -> bool\na rec p0 false true\nb put a 1 true\nr at b 1\nret r\nend\n',
      0,
    ],
    [
      'nested-record',
      'fn f u32 -> u32\na arr p0 9 7\nb rec true a\nc at b 1\nd set c 10 77\ne put b 1 d\nf at e 1\nr get f 1\nret r\nend\n',
      0,
    ],
    [
      'zero-trip',
      'fn b u32 u32 -> u32\nr add p0 1\nret r\nend\nfn f u32 -> u32\nr fold b 0 p0\nret r\nend\n',
      0,
    ],
    [
      'unroll-256',
      'fn b u32 u32 -> u32\nr add p0 1\nret r\nend\nfn f u32 -> u32\nr fold b 256 p0\nret r\nend\n',
      0,
    ],
    [
      'clock-257',
      'fn b u32 u32 -> u32\nr add p0 1\nret r\nend\nfn f u32 -> u32\nr fold b 257 p0\nret r\nend\n',
      0,
    ],
    [
      'clock-param',
      'fn b u32 u32 u32 -> u32\nr add p0 p2\nret r\nend\nfn f u32 u32 -> u32\nr fold b p0 p1 7\nret r\nend\n',
      0,
    ],
    [
      'clock-body',
      'fn b u32 u32 -> u32\nr div p0 2\nret r\nend\nfn f u32 -> u32\nr fold b 4 p0\nret r\nend\n',
      0,
    ],
    [
      'clock-predicate',
      'fn p u32 u32 -> bool\nx div p0 2\nr gt x 7\nret r\nend\nfn b u32 u32 -> u32\nr sub p0 1\nret r\nend\nfn f u32 u32 -> u32\nr loop p b p0 p1\nret r\nend\n',
      0,
    ],
    [
      'clock-call',
      'fn div u32 -> u32\nr div p0 3\nret r\nend\nfn caller u32 -> u32\na call div p0\nr add a 7\nret r\nend\n',
      0,
    ],
    ['io-only-result', 'fn f io -> io\nr write p0 7\nret r\nend\n', 0],
    [
      'io-call',
      'fn f io -> io\nr write p0 7\nret r\nend\nfn g io -> io\nr call f p0\nret r\nend\n',
      0,
    ],
    ['io-puts', 'fn f io -> u32\na arr 1 2 4294967295\nr puts p0 a\nret 7\nend\n', 0],
    [
      'io-fold',
      'fn b io u32 -> io\nr write p0 p1\nret r\nend\nfn f io u32 -> io\nr fold b p1 p0\nret r\nend\n',
      0,
    ],
    [
      'io-record-fold',
      'fn b (u32,io) u32 -> (u32,io)\nv at p0 0\nt at p0 1\nw write t v\nx add v 1\nr rec x w\nret r\nend\nfn f io u32 -> u32\ns rec 0 p0\nr fold b p1 s\nv at r 0\nt at r 1\nw write t v\nret v\nend\n',
      0,
    ],
    ['strict-scalar', 'profile strict\nfn f u32 -> u32\nr add p0 1\nret r\nend\n', 0],
    ['strict-div-literal', 'profile strict\nfn f u32 -> u32\nr div p0 3\nret r\nend\n', 0],
    ['strict-div-or', 'profile strict\nfn f u32 -> u32\nx or p0 1\nr div 55 x\nret r\nend\n', 0],
    [
      'strict-div-add',
      'profile strict\nfn f u32 -> u32\nx and p0 3\ny add x 1\nr div 55 y\nret r\nend\n',
      0,
    ],
    [
      'strict-safe-index',
      'profile strict\nfn f u32 -> u32\na arr 1 2 3 4\ni and p0 3\nr get a i\nret r\nend\n',
      0,
    ],
    [
      'strict-rem-index',
      'profile strict\nfn f u32 -> u32\na arr 1 2 3 4\ni rem p0 4\nr get a i\nret r\nend\n',
      0,
    ],
    ['strict-read', 'profile strict\nfn f io -> u32\nr read p0\nv at r 0\nret v\nend\n', 9],
    ['strict-div-unknown', 'profile strict\nfn f u32 u32 -> u32\nr div p0 p1\nret r\nend\n', 9],
    [
      'strict-index-unknown',
      'profile strict\nfn f u32 -> u32\na arr 1 2 3\nr get a p0\nret r\nend\n',
      9,
    ],
    ['array-1024', 'fn f u32x1024 -> u32\nr get p0 1023\nret r\nend\n', 0],
    ['array-1025', 'fn f u32x1025 -> u32\nr get p0 0\nret r\nend\n', 10],
    ['nested-array-limit', 'fn f u32x1025x2 -> u32\na get p0 0\nr get a 0\nret r\nend\n', 10],
    ['checked-before-array', 'fn f u32x1025 -> u32\na cadd 1 2\nr at a 0\nret r\nend\n', 8],
    [
      'strict-before-array',
      'profile strict\nfn f u32x1025 u32 -> u32\nr div p1 p1\nret r\nend\n',
      9,
    ],
    [
      'io-predicate',
      'fn p io u32 -> bool\nw write p0 1\nret true\nend\nfn b io u32 -> io\nw write p0 p1\nret w\nend\nfn f io -> io\nr loop p b 5 p0\nret r\nend\n',
      11,
    ],
  ];
  for (const op of ['cadd', 'csub', 'cmul', 'cdiv', 'crem'])
    tests.push([`checked-${op}`, `fn f u32 u32 -> u32\na ${op} p0 p1\nr at a 0\nret r\nend\n`, 8]);
  tests.push([
    'checked-cget',
    'fn f u32 -> u32\na arr 1 2 3\nb cget a p0\nr at b 0\nret r\nend\n',
    8,
  ]);
  for (const depth of [8, 9, 10]) {
    const body = Array.from({ length: depth }, (_, i) => `x${i} mov ${i ? `x${i - 1}` : '1'}`).join(
      '\n',
    );
    tests.push([
      `strict-depth${depth}`,
      `profile strict\nfn f u32 -> u32\n${body}\nr div p0 x${depth - 1}\nret r\nend\n`,
      depth <= 9 ? 0 : 9,
    ]);
  }
  return tests;
}
