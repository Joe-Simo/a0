import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { link } from '../../../dist/src/link.js';
export const los = [32, 35, 38, 41, 44, 50, 53, 56, 59, 62, 68, 74, 77, 100, 103, 106, 109];
export const mos = [32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 68, 71, 74, 97, 100, 103, 106];
export async function fixture(root, item) {
  await mkdir(root, { recursive: true });
  for (const [name, text] of Object.entries(item.files)) await writeFile(join(root, name), text);
  const reads = [];
  let expected, error;
  try {
    expected = await link(
      join(root, 'entry.a0'),
      async (path) => {
        reads.push(path);
        return readFile(path, 'utf8');
      },
      {
        root,
        profile: item.override === 2 ? 'strict' : item.override === 1 ? 'canonical' : undefined,
      },
    );
  } catch (e) {
    error = e;
  }
  return { root, entry: join(root, 'entry.a0'), reads, expected, error };
}
export function observe(a, r) {
  const [s, q, l] = r,
    [v, m, p, b, em, ae] = q,
    lt = new Map(los.map((o) => [o, a.vector(l, o)])),
    mt = new Map(mos.map((o) => [o, a.vector(m, o)])),
    files = Array.from({ length: l[33] / 12 }, (_, i) => {
      const x = lt.get(32).slice(i * 12, (i + 1) * 12);
      return { row: x, path: a.text(x[0], x[1]), source: a.words(x[2], x[3]) };
    });
  return {
    s: Array.from(s),
    v: Array.from(v),
    m: Array.from(m),
    p: Array.from(p),
    b: Array.from(b),
    em: Array.from(em),
    ae: Array.from(ae),
    l: Array.from(l),
    lt,
    mt,
    files,
    symbols: Array.from({ length: m[67] }, (_, i) => {
      const e = mt.get(62).slice(i * 5, i * 5 + 5);
      return a.text(e[0], e[2], e[1]);
    }),
    fragments: a.vector(s, 32),
    path: a.text(s[20], s[21]),
    reads: [...a.reads],
  };
}
const rows = (a, n) => Array.from({ length: a.length / n }, (_, i) => a.slice(i * n, (i + 1) * n));
export function intervals(segments, start, len) {
  const end = start + len,
    out = [];
  for (const [at, n, f, orig] of rows(segments, 4)) {
    const lo = Math.max(at, start),
      hi = Math.min(at + n, end);
    if (lo < hi) out.push([lo - start, hi - lo, f, f === 0xffffffff ? 0 : orig + lo - at]);
  }
  return out;
}
export function compare(g, item, ref) {
  const { s, v, m, l, lt, mt, files } = g;
  assert.equal(s[1], 1, item.name);
  assert.equal(s[2], 0x41304c56);
  assert.equal(s[3], 1);
  assert.equal(s[0], v[0], item.name + ' status except metadata IO error');
  if (!item.unsupported) {
    assert.deepEqual(g.reads, ref.reads, item.name + ' source read order');
    if (ref.error) {
      if (ref.error.id) {
        assert.equal(s[5], Number(ref.error.id.slice(1)), item.name + ': ' + ref.error.message);
        assert.notEqual(s[0], 0);
      } else {
        assert.equal(s[0], 8);
        assert.equal(s[4], 1);
      }
    } else {
      assert.equal(s[0], 0, item.name + ' ' + s.slice(0, 30));
      assert.equal(s[18], 1);
      assert.equal(v[1], 11);
      assert.equal(m[0], 0);
      assert.equal(m[96], 1);
      assert.equal(s[17], 1);
      assert.equal(l[121], 1);
      assert.equal(l[120], 1);
      assert.equal(l[0], 0);
      assert.equal(m[6], l[41]);
      assert.equal(m[7], l[42]);
      assert.equal(m[8], ref.expected.program.profile === 'strict' ? 1 : 0);
      const combined = Buffer.from(lt.get(41)).toString('utf8');
      assert.equal(combined, ref.expected.text);
      const symbols = g.symbols;
      const frows = rows(mt.get(41), 14);
      assert.deepEqual(
        frows.map((r) => symbols[r[0]]),
        ref.expected.program.functions.map((f) => f.name),
      );
      for (let fi = 0; fi < frows.length; fi++) {
        const f = ref.expected.program.functions[fi],
          fm = frows[fi];
        assert.equal(fm[5], f.nodes.length);
        assert.deepEqual(mt.get(103).slice(fi * 3, fi * 3 + 1), [f.literalIterations]);
        const ns = rows(mt.get(44), 14).slice(fm[4], fm[4] + fm[5]);
        assert.deepEqual(
          ns.map((n) => symbols[n[0]]),
          f.nodes.map((n) => n.id),
        );
      }
      const spec = rows(mt.get(56), 6),
        refs = rows(lt.get(77), 4),
        frags = rows(lt.get(100), 4),
        segments = lt.get(44);
      assert.equal(refs.length, spec.length);
      assert.ok(spec.length > 0, item.name + ' nonempty original specs');
      for (let i = 0; i < spec.length; i++) {
        const r = refs[i];
        assert.deepEqual(r.slice(0, 2), spec[i].slice(3, 5));
        const actual = frags.slice(r[2], r[2] + r[3]),
          expected = intervals(segments, r[0], r[1]);
        assert.deepEqual(actual, expected);
        for (const [off, n, f, orig] of actual)
          if (f !== 0xffffffff)
            assert.deepEqual(
              lt.get(41).slice(r[0] + off, r[0] + off + n),
              files[f].source.slice(orig, orig + n),
            );
      }
    }
  } else {
    assert.equal(s[0], 7, item.name);
    assert.equal(s[4], 1);
    assert.equal(s[18], 0);
    assert.equal(v[1], 11);
  }
  if (s[19] === 2) {
    const expected = intervals(lt.get(44), s[10], s[11]);
    assert.deepEqual(
      rows(g.fragments, 4).slice(s[35], s[35] + s[36]),
      expected,
      item.name + ' selected diagnostic origin',
    );
    if (expected.length && expected[0][2] !== 0xffffffff)
      assert.equal(g.path, files[expected[0][2]].path);
  } else if (s[19] === 1 && s[12] < files.length) assert.equal(g.path, files[s[12]].path);
  return {
    name: item.name,
    status: s[0],
    id: s[5],
    stage: s[4],
    files: files.length,
    functions: m[42] / 14,
    specRows: mt.get(56).length / 6,
    verified: s[18],
    locationMode: s[19],
    path: g.path,
    originFragments: s[36],
  };
}
