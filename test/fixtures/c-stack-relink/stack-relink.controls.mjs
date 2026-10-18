/** Correctness controls only. No elapsed-time, RSS or latency samples are collected. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { compile } from '../../../dist/src/backends.js';
import { run } from '../../../dist/src/core.js';
import { nativeSourceApi } from '../../../dist/src/source-native.js';
import { loadNativeSourcePackage } from '../../../dist/src/source-native-package.js';
import { readWasmWords } from '../../../dist/src/wasm-words.js';
import { writeReport } from '../../../dist/tools/scrub-results.js';
import { verifySourceCostFrozenC } from '../../../dist/tools/source-cost-control.js';
import { cases as specCases } from '../arena-spec-verifier/cases.mjs';
import { configuration, hash, identity, relinkStack } from './stack-relink.mjs';

const paths = configuration();
const source = identity();
const linked = await relinkStack(paths);
const modules = await Promise.all(
  ['baseline', 'candidate'].map(
    async (name) => new WebAssembly.Module(await readFile(join(paths.out, name, 'frontend.wasm'))),
  ),
);
const packagePath = process.env.A0_STACK_PACKAGE;
assert.ok(packagePath, 'A0_STACK_PACKAGE required');
const packageBytes = await readFile(join(packagePath, 'manifest.json'));
assert.equal(
  hash(packageBytes),
  '8031ed6c6ddae333de799dcbd061f14af64dde8c355dda484b25fda042fd7fed',
);
const packageManifest = JSON.parse(packageBytes);
const companions = {};
for (const file of ['format.wasm', 'diagnostic.wasm']) {
  const bytes = await readFile(join(packagePath, file));
  assert.equal(hash(bytes), packageManifest.components[file].sha256);
  companions[file] = { bytes, module: new WebAssembly.Module(bytes) };
}
const observations = [];
// These A0 evaluator faults return normally; they are not arbitrary Wasm traps.
const diagnosticCases = [
  ['unknown-call', 'fn bad\nx missing A\nret x\nend\n', 'A0102'],
  ['spec-mismatch', '# Ω😀\nfn twice\nex 7 -> 15\nret mul A 2\nend\n', 'A0715'],
  ...[
    'all-example-types-before-first-value',
    'pre-false',
    'strict-body-trap',
    'body-fuel-refusal',
  ].map((name) => {
    const value = specCases.find((item) => item.name === name);
    assert.ok(value, name);
    return [name, value.nativeSource ?? value.source, `A${String(value.id).padStart(4, '0')}`];
  }),
];

function engine(module, companion = false) {
  const api = new WebAssembly.Instance(module).exports;
  const events = [];
  const host = nativeSourceApi(
    {
      ...api,
      malloc(size) {
        const pointer = api.malloc(size);
        events.push({ op: 'malloc', size, pointer });
        return pointer;
      },
      free(pointer) {
        events.push({ op: 'free', pointer });
        api.free(pointer);
      },
    },
    undefined,
    companion
      ? { load: () => companions['diagnostic.wasm'].module, verification: true }
      : undefined,
    companion ? { load: () => companions['format.wasm'].module } : undefined,
  );
  return { api, host, events };
}
function pair(companion = false) {
  return modules.map((module) => engine(module, companion));
}
function close(engines) {
  for (const value of engines) value.host.close();
  global.gc?.();
}

function sameResult(a, b) {
  for (const key of ['ok', 'status', 'state', 'specState', 'origins'])
    assert.deepEqual(a[key], b[key], key);
  if (a.ok) {
    assert.deepEqual(a.program, b.program);
    assert.equal(a.typed.functions.length, b.typed.functions.length);
    for (const [index, fn] of a.typed.functions.entries()) {
      const other = b.typed.functions[index];
      assert.equal(fn.name, other.name);
      assert.deepEqual(fn.types, other.types);
      assert.equal(fn.profile, other.profile);
      assert.equal(fn.staticIterations, other.staticIterations);
      assert.equal(fn.literalIterations, other.literalIterations);
      assert.deepEqual([...fn.calls.keys()], [...other.calls.keys()]);
      for (const [name, callee] of fn.calls) assert.equal(callee, a.typed.byName.get(name));
      for (const [name, callee] of other.calls) assert.equal(callee, b.typed.byName.get(name));
    }
  } else {
    assert.deepEqual(a.diagnostic?.packet, b.diagnostic?.packet);
    assert.equal(a.diagnostic?.rendered.ok, b.diagnostic?.rendered.ok);
    assert.equal(a.diagnostic?.rendered.error?.id, b.diagnostic?.rendered.error?.id);
  }
}

/** Compare every live logical allocation, not selected frontend tables or normalized words. */
function sameLive(engines, label) {
  const [left, right] = engines;
  const pages = {};
  for (const [name, count] of [
    ['frontend_state', 128],
    ['frontend_specs', 128],
    ['frontend_verification', 768],
  ]) {
    const a = Array.from(readWasmWords(left.api.memory.buffer, left.api[name](), count));
    const b = Array.from(readWasmWords(right.api.memory.buffer, right.api[name](), count));
    assert.deepEqual(a, b, `${label}:${name}`);
    pages[name] = a;
  }
  assert.equal(left.api.frontend_status(), right.api.frontend_status());
  const tokens = engines.map(({ api }) => api.frontend_arena_token());
  if (tokens[0] || tokens[1]) assert.equal(tokens[0] - tokens[1], linked.heapDelta);
  else assert.deepEqual(tokens, [0, 0]);
  assert.equal(left.events.length, right.events.length);
  for (const [index, event] of left.events.entries()) {
    const other = right.events[index];
    assert.equal(event.op, other.op);
    assert.equal(event.size, other.size);
    assert.equal(event.pointer - other.pointer, linked.heapDelta);
  }
  const arena = [];
  for (let handle = 1; ; handle++) {
    const count = left.api.frontend_view_length(handle);
    assert.equal(count, right.api.frontend_view_length(handle), `${label}: allocation length`);
    if (!count) {
      assert.equal(left.api.frontend_view(handle), 0);
      assert.equal(right.api.frontend_view(handle), 0);
      break;
    }
    const pointers = engines.map(({ api }) => api.frontend_view(handle));
    assert.equal(pointers[0] - pointers[1], linked.heapDelta);
    const bytes = engines.map(({ api }, i) =>
      Buffer.from(api.memory.buffer, pointers[i], count * 4),
    );
    assert.equal(Buffer.compare(bytes[0], bytes[1]), 0, `${label}: complete allocation ${handle}`);
    arena.push({
      handle,
      words: count,
      sha256: hash(bytes[0]),
      baselinePointer: pointers[0],
      candidatePointer: pointers[1],
    });
  }
  const logicalMemory = engines.map(({ api }) => api.memory.buffer.byteLength);
  assert.equal(logicalMemory[0] - logicalMemory[1], linked.heapDelta);
  observations.push({
    label,
    status: left.api.frontend_status(),
    pages,
    arena,
    arenaWords: arena.reduce((sum, row) => sum + row.words, 0),
    logicalMemory,
    mallocFreeEvents: left.events.length,
    heapDelta: linked.heapDelta,
  });
}
function action(engines, label, call) {
  const result = engines.map(({ host }) => call(host));
  sameResult(...result);
  sameLive(engines, label);
  return result;
}

const indexPath = 'experiments/unification/frontend-a0/inputs/index.json';
const units = JSON.parse(await readFile(indexPath));
assert.equal(units.length, 6);
for (const unit of units)
  test(`stack relink: complete state and frozen emission for ${unit.unit}`, () => {
    const engines = pair();
    return (async () => {
      try {
        const raw = await readFile(join('experiments/unification/frontend-a0/inputs', unit.input));
        assert.equal(hash(raw), unit.inputSHA256);
        const input = JSON.parse(raw);
        const result = action(engines, unit.unit, (host) => host.parse(input.unified));
        assert.ok(result.every((value) => value.ok));
        const output = result.map((value) => compile(value.typed, 'c').text);
        assert.equal(output[0], output[1]);
        verifySourceCostFrozenC(output[0], unit.outputSHA256);
        const row = observations.at(-1);
        Object.assign(row, {
          frozenInputSHA256: hash(raw),
          sourceSHA256: hash(input.unified),
          functions: result[0].typed.functions.length,
          outputBytes: Buffer.byteLength(output[0]),
          outputSHA256: hash(output[0]),
          frozenOutputSHA256: unit.outputSHA256,
          oracle:
            'Exact frozen C output; only the historical first compiler-version banner may differ.',
        });
        if (unit.id === 0) {
          const grid = Array(32).fill(0);
          grid[15] = (1 << 14) | (1 << 15) | (1 << 16);
          const expected = Array(32).fill(0);
          expected[14] = expected[15] = expected[16] = 1 << 15;
          for (const value of result)
            assert.deepEqual(run(value.typed.byName.get('step'), [grid]), expected);
          row.independentLifeBlinker = true;
        }
      } finally {
        close(engines);
      }
    })();
  });

test('stack relink: malformed syntax, unknown calls and spec faults retain complete diagnostics and recovery', () => {
  const engines = pair(true);
  try {
    for (const [name, text, id] of [
      ...diagnosticCases,
      ['unfinished-aggregate', 'fn f -> u32x2\nex -> [1,\nret fill 1\nend\n'],
      ['missing-return', 'fn f\nx add A 1\nend\n'],
    ]) {
      const result = action(engines, name, (host) => host.parse(text));
      assert.ok(result.every((value) => !value.ok));
      if (id)
        for (const value of result) {
          assert.ok(value.diagnostic.rendered.ok);
          assert.equal(value.diagnostic.rendered.error.id, id);
        }
      assert.ok(
        action(engines, `${name}:recovery`, (host) =>
          host.parse('fn recover\nret add A 1\nend\n'),
        ).every((value) => value.ok),
      );
    }
  } finally {
    close(engines);
  }
});

test('stack relink: allocation budgets refuse and recover at the same exact boundaries', () => {
  const engines = pair();
  try {
    let refused = 0,
      accepted = 0;
    for (const budget of [0, 64, 256, 512, 1024, 2048, 4096, 16000000]) {
      const result = action(engines, `budget:${budget}`, (host) =>
        host.parse('fn addone\nret add A 1\nend\n', budget),
      );
      if (result[0].ok) accepted++;
      else {
        refused++;
        assert.equal(result[0].status, 4);
      }
    }
    assert.ok(refused && accepted);
    assert.ok(
      action(engines, 'budget:recovery', (host) => host.parse('fn recover\nret A\nend\n')).every(
        (value) => value.ok,
      ),
    );
  } finally {
    close(engines);
  }
});

test('stack relink: structured IR, unit graph checks and metadata retain complete allocation state', () => {
  const engines = pair(true);
  try {
    const program = {
      profile: 'strict',
      functions: [
        {
          name: 'authored',
          params: ['u32'],
          result: 'u32',
          nodes: [],
          ret: { kind: 'param', index: 0 },
        },
      ],
    };
    assert.ok(
      action(engines, 'structured-IR', (host) => host.checkProgram(program)).every(
        (value) => value.ok,
      ),
    );
    const text = [
      'profile strict\nfn inc\nret add A 1\nend\n',
      'profile strict\nuse "dep.a0"\nfn top\nex 7 -> 8\nret inc A\nend\n',
    ];
    const units = engines.map(({ host }) => text.map((source) => host.parseUnit(source)));
    assert.ok(units.flat().every((value) => value.ok));
    const result = engines.map(({ host }, i) => host.checkUnits(units[i], 'strict'));
    sameResult(...result);
    sameLive(engines, 'native-unit-graph');
    for (const value of result) {
      assert.ok(value.ok);
      assert.equal(run(value.typed.byName.get('top'), [7]), 8);
    }
    const formatted = engines.map(({ host }, i) =>
      host.format(result[i], { scope: 'program', mapping: true }),
    );
    assert.deepEqual(...formatted);
    assert.ok(formatted[0].ok);
    sameLive(engines, 'native-unit-graph:format');
    const revisions = engines.map(({ host }, i) => host.revision(result[i], { kind: 'semantic' }));
    assert.deepEqual(...revisions);
    assert.ok(revisions[0].ok);
    sameLive(engines, 'native-unit-graph:revision');
  } finally {
    close(engines);
  }
});

test('stack relink: detached snapshots, stale/foreign results and close preserve independent lifetimes', () => {
  const engines = pair(true);
  try {
    const first = action(engines, 'lifetime:first', (host) =>
      host.parse('# Ω😀\nfn old\nret A\nend\n'),
    );
    const saved = first.map((value) =>
      JSON.stringify({ state: value.state, specs: value.specState, program: value.program }),
    );
    const next = action(engines, 'lifetime:next', (host) =>
      host.parse('fn next\nret add A 1\nend\n'),
    );
    for (const [i, { host }] of engines.entries()) {
      assert.equal(
        JSON.stringify({
          state: first[i].state,
          specs: first[i].specState,
          program: first[i].program,
        }),
        saved[i],
      );
      assert.throws(() => host.format(first[i]), /current result owned/);
      assert.throws(() => host.revision(first[i]), /current result owned/);
      assert.throws(() => host.format(next[1 - i]), /current result owned/);
      host.close();
      host.close();
      assert.throws(() => host.parse('fn closed\nret A\nend\n'), /closed/);
      assert.throws(() => host.checkProgram({ functions: [] }), /closed/);
      assert.throws(() => host.format(next[i]), /closed/);
    }
    sameLive(engines, 'lifetime:closed');
    const peers = pair(true);
    try {
      assert.ok(
        action(peers, 'lifetime:fresh-instance', (host) =>
          host.parse('fn fresh\nret A\nend\n'),
        ).every((value) => value.ok),
      );
    } finally {
      close(peers);
    }
  } finally {
    close(engines);
  }
});

test('stack relink: unchanged package formatter, revisions and verified diagnostics share both frontend arenas', async () => {
  const relinkBytes = await readFile(join(paths.out, 'relink.json'));
  const candidate = structuredClone(packageManifest);
  candidate.components['frontend.wasm'] = {
    ...candidate.components['frontend.wasm'],
    bytes: linked.artifacts.candidate.bytes,
    sha256: linked.artifacts.candidate.sha256,
    buildSHA256: hash(relinkBytes),
  };
  const candidateBytes = Buffer.from(JSON.stringify(candidate));
  await writeFile(join(paths.out, 'candidate/package-manifest.json'), candidateBytes);
  const packages = await Promise.all(
    [
      [packageBytes, 'baseline'],
      [candidateBytes, 'candidate'],
    ].map(async ([manifest, name]) =>
      loadNativeSourcePackage(manifest, hash(manifest), (file) =>
        file === 'frontend.wasm'
          ? readFile(join(paths.out, name, file))
          : Promise.resolve(companions[file].bytes),
      ),
    ),
  );
  const engines = packages.map((value) => value.instantiate());
  try {
    const text =
      '# package Ω😀\nfn pair _ -> (u32,bool)\nx add A 7\ny eq x 12\nz rec x y\nret z\nend\n';
    const parsed = engines.map((host) => host.parse(text));
    sameResult(...parsed);
    for (const value of parsed) {
      assert.ok(value.ok);
      assert.deepEqual(run(value.typed.byName.get('pair'), [5]), [12, true]);
    }
    const formatted = engines.map((host, i) =>
      host.format(parsed[i], { scope: 'program', mapping: true }),
    );
    assert.deepEqual(...formatted);
    assert.ok(formatted[0].ok);
    const revisions = engines.map((host, i) => host.revision(parsed[i], { kind: 'semantic' }));
    assert.deepEqual(...revisions);
    assert.ok(revisions[0].ok);
    for (const [name, text, id] of diagnosticCases) {
      const result = engines.map((host) => host.parse(text));
      sameResult(...result);
      for (const value of result) {
        assert.ok(!value.ok && value.diagnostic.rendered.ok);
        assert.equal(value.diagnostic.rendered.error.id, id);
      }
      observations.push({
        label: `package:${name}`,
        id,
        diagnosticJSONSHA256: hash(result[0].diagnostic.packet.json),
      });
    }
  } finally {
    for (const value of engines) value.close();
  }
});

after(async () => {
  assert.deepEqual(identity(), source);
  await writeReport(join(paths.out, 'controls.json'), {
    schema: 1,
    source,
    scope:
      'Correctness and complete logical arena/verifier state only. Heap pointers differ solely by the proven link stack delta. No timing/RSS/latency result.',
    inputIndexSHA256: hash(await readFile(indexPath)),
    observations,
  });
});
