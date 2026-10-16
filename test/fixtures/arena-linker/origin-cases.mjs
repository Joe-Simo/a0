// Independent interval intersections. No production compiler/helper imports.
const U = 4294967295;
const row = (a, b, c, d) => [a, b, c, d];
export function projectOracle(origins, start, length) {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(length) ||
    start < 0 ||
    length < 0 ||
    start > U ||
    length > U ||
    BigInt(start) + BigInt(length) > BigInt(U)
  )
    return { status: 3, fragments: [] };
  let total = 0;
  for (const r of origins) {
    if (r.length !== 4 || r[0] !== total || r[1] <= 0 || BigInt(r[0]) + BigInt(r[1]) > BigInt(U))
      return { status: 3, fragments: [] };
    total = r[0] + r[1];
  }
  if (start > total || length > total - start) return { status: 3, fragments: [] };
  const finish = start + length,
    fragments = [];
  for (const [base, n, file, original] of origins) {
    const lo = Math.max(base, start),
      hi = Math.min(base + n, finish);
    if (lo >= hi) continue;
    const mapped = BigInt(original) + BigInt(lo - base);
    if (mapped + BigInt(hi - lo) > BigInt(U)) return { status: 3, fragments: [] };
    fragments.push(row(lo - start, hi - lo, file, Number(mapped)));
  }
  return { status: 0, fragments };
}
export function fixtures() {
  const regular = [row(0, 3, 0, 10), row(3, 2, U, 0), row(5, 4, 2, 100)];
  const cases = [];
  const add = (name, origins, start, length, initial = []) => {
    const expected = projectOracle(origins, start, length);
    cases.push({
      name,
      origins,
      query: [start, length],
      initial,
      initialCapacityWords: initial.length * 4,
      expected: {
        ...expected,
        first: initial.length,
        count: expected.status === 0 ? expected.fragments.length : 0,
      },
    });
  };
  add('source0-empty', [], 0, 0);
  add('source0-outside-empty', [], 1, 0);
  add('eof-empty', regular, 9, 0, [row(7, 1, 9, 11)]);
  add('outside-eof-empty', regular, 10, 0);
  add('begin-empty', regular, 0, 0);
  add('whole-source', regular, 0, 9);
  add('first-partial', regular, 1, 1);
  add('fragmented-span', regular, 2, 5, [row(99, 2, 8, 70)]);
  add('exact-boundaries', regular, 3, 2);
  add('after-synthetic', regular, 5, 4);
  add('synthetic-coordinate-advances', [row(0, 8, U, 25)], 2, 3);
  add('full-u32-position', [row(0, U - 4, 3, 0), row(U - 4, 4, 4, 200)], U - 3, 2);
  add('full-u32-eof', [row(0, U, 5, 0)], U, 0);
  add('query-overflow', [row(0, U, 5, 0)], U, 1);
  add('query-end-outside', regular, 8, 2);
  add('original-offset-high', [row(0, 4, 12, U - 4)], 2, 2);
  add('original-span-overflow', [row(0, 4, 12, U - 3)], 2, 2);
  add('observed-gap', [row(0, 3, 0, 0), row(4, 2, 1, 10)], 2, 3, [row(88, 1, 2, 3)]);
  add('first-selected-prior-gap', [row(0, 3, 0, 0), row(4, 2, 1, 10)], 4, 1);
  add('observed-overlap', [row(0, 4, 0, 0), row(3, 2, 1, 10)], 2, 3);
  add('first-not-zero', [row(1, 3, 0, 0)], 1, 1);
  add('zero-length-segment', [row(0, 2, 0, 0), row(2, 0, 1, 2), row(2, 3, 2, 4)], 0, 5);
  add('combined-segment-overflow', [row(0, 2, 0, 0), row(U - 1, 3, 1, 0)], 0, 1);
  // Allocation failure after one successful tail STORE: caller must return original metadata.
  const resourceOrigins = [row(0, 2, 0, 10), row(2, 2, 1, 20), row(4, 2, 2, 30)];
  cases.push({
    name: 'resource-after-unpublished-tail',
    origins: resourceOrigins,
    query: [0, 6],
    initial: [row(99, 1, 77, 10)],
    initialCapacityWords: 8,
    maxWords: 20,
    expected: { status: 4, fragments: [], first: 1, count: 0 },
  });
  return cases;
}
