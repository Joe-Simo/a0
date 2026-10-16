import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from '../../../dist/src/core.js';
import { link } from '../../../dist/src/link.js';
import { runTool } from '../../../dist/src/toolchain.js';
import { cases } from './cases.mjs';
import { decode as decodeParser } from './decode.mjs';
import { fixtures as originFixtures, projectOracle } from './origin-cases.mjs';

const root = process.argv[2],
  mode = process.argv[3];
assert.ok(root);
assert.ok(mode === 'sources' || mode === 'origins');
process.chdir(root);
const U = 4294967295;
const psOffsets = [32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 68, 71, 74];
const lsOffsets = [32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 68, 74, 77, 100, 103, 106, 109];
const text = (s) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(s);
function decode(b) {
  let at = 0;
  const word = () => {
    assert.ok(at + 4 <= b.length);
    const n = b.readUInt32LE(at);
    at += 4;
    return n;
  };
  const words = (n) => Array.from({ length: n }, word);
  const bytes = () => Uint8Array.from(words(word()));
  const ps = (source) => {
    const start = at;
    const p = words(128);
    for (const _off of psOffsets) words(word());
    for (let i = word(); i > 0; i--) bytes();
    const framed = Buffer.alloc(at - start + 4);
    framed.writeUInt32LE(p[0], 0);
    b.copy(framed, 4, start, at);
    return decodeParser(framed, text(source));
  };
  const status = word(),
    state = words(128),
    tables = new Map();
  for (const off of lsOffsets) tables.set(off, words(word()));
  const files = Array.from({ length: word() }, () => {
    const path = text(bytes()),
      raw = bytes();
    const parsed = word() ? ps(raw) : undefined;
    return { path, raw, parsed };
  });
  const combined = Uint8Array.from(tables.get(41));
  const parsed = word() ? ps(combined) : undefined;
  const calls = Array.from({ length: 4 }, () => {
    const lo = word(),
      hi = word();
    return BigInt(lo) | (BigInt(hi) << 32n);
  });
  assert.equal(at, b.length);
  return {
    status,
    state,
    tables,
    files,
    parsed,
    combined,
    order: tables.get(35).map((id) => files[id].path),
    calls,
  };
}
const flat = (rows) => rows.flat();
const rows = (words, width) =>
  Array.from({ length: words.length / width }, (_, i) => words.slice(i * width, (i + 1) * width));
// This oracle uses the exact public JS regular expressions, independently of A0 scans.
function pass(input, original, regex) {
  const s = text(input),
    out = new Uint8Array(input.length),
    map = new Uint32Array(input.length);
  let at = 0,
    from = 0;
  for (const m of s.matchAll(regex)) {
    const start = Buffer.byteLength(s.slice(0, m.index)),
      end = start + Buffer.byteLength(m[0]);
    out.set(input.subarray(from, start), at);
    map.set(original.subarray(from, start), at);
    at += start - from;
    from = end;
  }
  out.set(input.subarray(from), at);
  map.set(original.subarray(from), at);
  at += input.length - from;
  return { bytes: out.slice(0, at), map: map.slice(0, at) };
}
function strip(input) {
  const a = pass(
    input,
    Uint32Array.from({ length: input.length }, (_, i) => i),
    /^\s*use\s+"[^"]*"\s*$/gm,
  );
  return pass(a.bytes, a.map, /^[ \t]*profile[ \t]+strict[ \t]*(#.*)?$/gm);
}
function combine(files, order) {
  const parts = [],
    segments = [],
    directory = [];
  let length = 0,
    line = 1;
  for (let i = 0; i < order.length; i++) {
    const id = order[i],
      body = strip(files[id].raw);
    if (i) {
      parts.push(Uint8Array.of(10));
      segments.push([length, 1, U, 0]);
      length++;
    }
    const base = length;
    parts.push(body.bytes);
    let at = 0;
    while (at < body.bytes.length) {
      const start = at;
      at++;
      while (at < body.bytes.length && body.map[at] === body.map[at - 1] + 1) at++;
      segments.push([base + start, at - start, id, body.map[start]]);
    }
    let lc = 1;
    for (const b of body.bytes) if (b === 10) lc++;
    directory.push([id, line, lc, base]);
    line += lc;
    length += body.bytes.length;
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, segments, directory };
}
function checkOrigins(got, expected) {
  assert.ok(got.parsed);
  const p = got.parsed,
    table = (o) => p.tables.get(o),
    all = [];
  function check(off, queries) {
    const refs = rows(got.tables.get(off), 4);
    assert.equal(refs.length, queries.length, `refs${off} count`);
    for (let i = 0; i < queries.length; i++) {
      const [start, len] = queries[i],
        projected = projectOracle(expected, start, len);
      assert.equal(projected.status, 0, `ref${off}/${i} valid span`);
      assert.deepEqual(
        refs[i],
        [start, len, all.length, projected.fragments.length],
        `ref${off}/${i}`,
      );
      all.push(...projected.fragments);
    }
  }
  if (got.status === 0) {
    check(
      53,
      rows(table(41), 14).map((f) => {
        const line = rows(table(32), 10)[f[7]];
        return [line[3], line[4]];
      }),
    );
    check(
      56,
      rows(table(44), 14).flatMap((n) => [
        [n[7], n[8]],
        [n[9], n[10]],
      ]),
    );
    check(
      74,
      rows(table(47), 5).map((a) => [a[2], a[3]]),
    );
    check(
      77,
      rows(table(56), 6).map((s) => [s[3], s[4]]),
    );
    check(
      103,
      rows(table(32), 10).map((l) => [l[1], l[2]]),
    );
    check(
      106,
      rows(table(53), 3).map((u) => [u[0], u[1]]),
    );
  } else if (got.status === 6 && got.state[5] === 5) check(109, [[got.state[96], got.state[97]]]);
  assert.deepEqual(got.tables.get(100), flat(all), 'all projected fragments');
  for (const [combinedStart, len, first, count] of [
    ...rows(got.tables.get(53), 4),
    ...rows(got.tables.get(56), 4),
    ...rows(got.tables.get(74), 4),
    ...rows(got.tables.get(77), 4),
    ...rows(got.tables.get(103), 4),
    ...rows(got.tables.get(106), 4),
    ...rows(got.tables.get(109), 4),
  ]) {
    const frags = all.slice(first, first + count);
    for (const [relative, n, file, original] of frags) {
      if (file !== U)
        assert.deepEqual(
          got.files[file].raw.subarray(original, original + n),
          got.combined.subarray(combinedStart + relative, combinedStart + relative + n),
          'copied original bytes',
        );
    }
    assert.equal(
      frags.reduce((n, r) => n + r[1], 0),
      len,
      'full span covered',
    );
  }
}
async function sourceCases(level) {
  const base = join(root, `fixtures-O${level}`);
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });
  const report = [];
  for (let index = 0; index < cases.length; index++) {
    const c = cases[index];
    if (
      level === 0 &&
      new Set([
        'source-size-limit',
        'fullwidth-byte-offsets',
        'combined-source-exact-boundary',
        'combined-source-over-boundary',
      ]).has(c.name)
    )
      continue;
    const dir = join(base, String(index));
    await mkdir(dir, { recursive: true });
    for (const [name, data] of Object.entries(c.files)) {
      const p = join(dir, name);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
    }
    for (const [name, target] of c.links ?? []) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await symlink(join(dir, target), join(dir, name));
    }
    const entry = join(dir, c.entry ?? 'main.a0'),
      boundary = join(dir, c.root ?? ''),
      explicit = c.explicit !== false;
    const r = runTool(
      join(root, `driver-O${level}`),
      [
        entry,
        boundary,
        explicit ? '1' : '0',
        String(c.override ?? 0),
        c.dense ? '1' : '0',
        String(c.work ?? U),
        join(root, 'output.bin'),
      ],
      { cwd: root, timeoutMs: 90000 },
    );
    assert.ok(r.ok, `${c.name}: ${r.stderr}`);
    const got = decode(await readFile(join(root, 'output.bin')));
    assert.equal(got.state[94], 2, 'link schema2');
    if (c.scope) {
      assert.equal(got.status, c.want, c.name);
    } else {
      const reads = [];
      let linked, error;
      try {
        linked = await link(
          entry,
          async (p) => {
            reads.push(p);
            return readFile(p, 'utf8');
          },
          {
            ...(explicit ? { root: boundary } : {}),
            ...(c.override ? { profile: c.override === 1 ? 'canonical' : 'strict' } : {}),
          },
        );
      } catch (e) {
        error = e;
      }
      assert.deepEqual(
        got.files.map((f) => f.path),
        reads,
        `${c.name} A0 chose paths/order`,
      );
      assert.equal(got.calls[1], BigInt(reads.length), `${c.name} reads`);
      if (error) {
        if (error.id) {
          assert.equal(got.status, 6, c.name);
          assert.equal(got.state[1], Number(error.id.slice(1)), c.name);
          if (error.line !== undefined) assert.equal(got.state[95], error.line, c.name);
        } else {
          assert.equal(got.status, 8, c.name);
          assert.equal(got.state[4], 2, c.name);
        }
      } else {
        assert.equal(got.status, 0, c.name);
        assert.deepEqual(
          got.order,
          linked.sources.map((s) => s.path),
          c.name,
        );
        assert.equal(got.state[11], linked.program.profile === 'strict' ? 1 : 0, c.name);
        assert.equal(text(got.combined), linked.text, c.name);
      }
      if (got.state[120]) {
        const expected = combine(got.files, got.tables.get(35));
        assert.deepEqual(got.combined, expected.bytes, `${c.name} exact stripped combined bytes`);
        assert.deepEqual(
          got.tables.get(44),
          flat(expected.segments),
          `${c.name} exact original copy origins`,
        );
        assert.deepEqual(
          got.tables.get(50),
          flat(expected.directory),
          `${c.name} legacy source directory`,
        );
        const fileRows = rows(got.tables.get(32), 12);
        for (const [id, _line, lc, base] of expected.directory) {
          assert.equal(fileRows[id][10], base);
          assert.equal(fileRows[id][11], lc);
        }
        if (got.status === 0) {
          let parsed = parse(text(expected.bytes));
          if (got.state[10] === 2 || (!got.state[10] && fileRows[0][7] === 1))
            parsed = { ...parsed, profile: 'strict' };
          assert.deepEqual(got.parsed?.program, parsed, `${c.name} full combined parsed Program`);
        } else {
          const d = expected.directory.find(
            (row) => got.state[95] >= row[1] && got.state[95] < row[1] + row[2],
          );
          if (d) {
            assert.equal(got.state[115], d[0]);
            assert.equal(got.state[116], got.state[95] - d[1] + 1);
            assert.equal(got.state[2], d[0]);
          }
        }
        checkOrigins(got, expected.segments);
      }
      for (const file of got.files)
        if (file.parsed?.status === 0)
          assert.deepEqual(
            file.parsed.program,
            parse(text(file.raw)),
            `${c.name} original perfile IR`,
          );
    }
    report.push({
      name: c.name,
      status: 'passed',
      result: got.status,
      files: got.files.length,
      readRequests: got.calls[1].toString(),
      combinedParsed: !!got.state[120],
      combinedBytes: got.combined.length,
      originFragments: (got.tables.get(100)?.length ?? 0) / 4,
      scope: c.scope ?? 'canonical POSIX graph, exact combined text/parse, original spans',
    });
    console.log(c.name, 'pass');
  }
  return report;
}
async function projectionCases(level) {
  const projectionReport = [];
  for (const c of originFixtures()) {
    const ow = flat(c.origins),
      initial = flat(c.initial);
    const words = [
      c.maxWords ?? 100000,
      ow.length,
      ...ow,
      initial.length,
      c.initialCapacityWords,
      ...initial,
      ...c.query,
    ];
    const input = Buffer.alloc(words.length * 4);
    words.forEach((w, i) => {
      input.writeUInt32LE(w, i * 4);
    });
    await writeFile(join(root, 'project-input.bin'), input);
    const r = runTool(
      join(root, `driver-O${level}`),
      ['project', join(root, 'project-input.bin'), join(root, 'project-output.bin')],
      { cwd: root },
    );
    assert.ok(r.ok, `${c.name}: ${r.stderr}`);
    const output = await readFile(join(root, 'project-output.bin'));
    const w = Array.from({ length: output.length / 4 }, (_, i) => output.readUInt32LE(i * 4));
    assert.equal(w[0], c.expected.status, c.name);
    assert.equal(w[1], c.expected.first, c.name);
    assert.equal(w[2], c.expected.count, c.name);
    assert.equal(w[4], w[6]);
    assert.deepEqual(w.slice(7), flat([...c.initial, ...c.expected.fragments]), c.name);
    if (w[0]) {
      assert.equal(w[4], initial.length, c.name);
      assert.equal(w[5], c.initialCapacityWords, c.name);
    }
    projectionReport.push({ name: c.name, status: 'passed', result: w[0] });
    console.log('projection', c.name, 'pass');
  }
  return projectionReport;
}
const reports = [];
for (const level of [0, 2]) {
  const result = mode === 'sources' ? await sourceCases(level) : await projectionCases(level);
  reports.push({ level, cases: result.length });
}
console.log(JSON.stringify({ mode, reports }));
