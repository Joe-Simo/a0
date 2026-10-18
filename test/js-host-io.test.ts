import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, emitFunction, FunctionCache, functionEmissionKey } from '../src/backends.js';
import { A0Error, makeIo, parseAndValidate, run } from '../src/core.js';

type ReadWord = () => number | undefined;
type WriteWord = (word: number) => void;
interface BufferedToken {
  input: number[];
  position: number;
  output: number[];
}
interface HostModule {
  a0_make_host_io(read: ReadWord, write: WriteWord): object;
  a0_make_io(input: number[]): BufferedToken;
  pump(token: unknown, count: number): object;
  output(token: unknown): object;
  divide(denominator: number): number;
  fold_probe(array: Uint32Array, count: number, token: unknown): [Uint32Array, Uint32Array, object];
  loop_probe(array: Uint32Array, count: number, token: unknown): [Uint32Array, Uint32Array, object];
}

const PUMP = `fn step io u32 -> io
r read p0
v at r 0
t at r 1
out write t v
ret out
end
fn pump io u32 -> io
out fold step p1 p0
ret out
end
`;

const OUTPUT = `fn output io -> io
a write p0 19
words arr 0 4294967295 7
b puts a words
c write b 23
ret c
end
`;

const SNAPSHOTS = `fn change (u32x4,u32x4,io) u32 u32 -> (u32x4,u32x4,io)
a at p0 0
old at p0 1
t at p0 2
v get old p1
next add v p2
b set a p1 next
u write t v
out rec b old u
ret out
end
fn more (u32x4,u32x4,io) u32 u32 -> bool
b lt p1 2
ret b
end
fn fold_probe u32x4 u32 io -> (u32x4,u32x4,io)
initial rec p0 p0 p2
out fold change p1 initial 7
ret out
end
fn loop_probe u32x4 u32 io -> (u32x4,u32x4,io)
initial rec p0 p0 p2
out loop more change p1 initial 7
ret out
end
`;

const profile = (source: string, strict: boolean) =>
  strict ? `profile strict\n${source}` : source;

async function load(text: string): Promise<HostModule> {
  return import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
}

function diagnostic(error: unknown) {
  assert.ok(error instanceof Error);
  const value = error as A0Error;
  return { message: value.message, code: value.code, id: value.id, trap: value.trap };
}

test('JS host streams share function cache entries and restore the same default assembly', async () => {
  for (const strict of [false, true]) {
    const p = parseAndValidate(profile(PUMP, strict));
    for (const optimize of [false, true]) {
      const options = { optimize };
      const cache = new FunctionCache();
      const first = compile(p, 'js', options, cache);
      const host = compile(p, 'js', { ...options, jsIo: 'host' }, cache);
      const final = compile(p, 'js', options, cache);
      assert.equal(first.cacheMisses, p.functions.length);
      assert.equal(host.cacheHits, p.functions.length);
      assert.equal(final.cacheHits, p.functions.length);
      assert.equal(final.text, first.text);
      assert.equal(Object.hasOwn(await load(first.text), 'a0_make_host_io'), false);
      assert.equal(typeof (await load(host.text)).a0_make_host_io, 'function');
      for (const fn of p.functions) {
        assert.equal(
          functionEmissionKey('js', fn, options),
          functionEmissionKey('js', fn, { ...options, jsIo: 'host' }),
        );
        assert.equal(
          emitFunction('js', fn, options),
          emitFunction('js', fn, { ...options, jsIo: 'host' }),
        );
      }
    }
  }
});

test('JS host reads preserve all words, token identity and one callback per ordered effect', async () => {
  const mod = await load(compile(parseAndValidate(PUMP), 'js', { jsIo: 'host' }).text);
  const values = [0, 0xffffffff, 17, undefined, 0xffffffff];
  const events: unknown[] = [];
  let reads = 0;
  const token = mod.a0_make_host_io(
    () => {
      const value = values[reads++];
      events.push(['read', value]);
      return value;
    },
    (word) => events.push(['write', word]),
  );
  assert.equal(mod.pump(token, values.length), token);
  assert.equal(reads, values.length);
  assert.deepEqual(events, [
    ['read', 0],
    ['write', 0],
    ['read', 0xffffffff],
    ['write', 0xffffffff],
    ['read', 17],
    ['write', 17],
    ['read', undefined],
    ['write', 0],
    ['read', 0xffffffff],
    ['write', 0xffffffff],
  ]);
  assert.equal(mod.pump(token, 0), token);
  assert.equal(reads, values.length);
});

test('JS host puts writes its length and words between neighboring effects', async () => {
  for (const strict of [false, true]) {
    const mod = await load(
      compile(parseAndValidate(profile(OUTPUT, strict)), 'js', { jsIo: 'host' }).text,
    );
    const words: number[] = [];
    const token = mod.a0_make_host_io(
      () => assert.fail('output-only source must not read'),
      (word) => words.push(word),
    );
    assert.equal(mod.output(token), token);
    assert.deepEqual(words, [19, 3, 0, 0xffffffff, 7, 23]);
    const refused = new Error('independent puts refusal');
    const partial: number[] = [];
    const failed = mod.a0_make_host_io(
      () => assert.fail('output-only source must not read'),
      (word) => {
        partial.push(word);
        if (word === 0xffffffff) throw refused;
      },
    );
    assert.throws(
      () => mod.output(failed),
      (error) => error === refused,
    );
    assert.deepEqual(partial, [19, 3, 0, 0xffffffff]);
  }
});

test('JS strict host EOF has independent interpreter attribution and never consumes a valid zero or max', async () => {
  const p = parseAndValidate(profile(PUMP, true));
  const mod = await load(compile(p, 'js', { jsIo: 'host' }).text);
  const fn = p.byName.get('pump');
  assert.ok(fn);
  const expectedIo = makeIo([0, 0xffffffff]);
  let expected: unknown;
  try {
    run(fn, [expectedIo, 3]);
  } catch (error) {
    expected = error;
  }
  assert.ok(expected instanceof A0Error && expected.id === 'A0712');
  const events: unknown[] = [];
  let reads = 0;
  const token = mod.a0_make_host_io(
    () => {
      const value = [0, 0xffffffff][reads++];
      events.push(['read', value]);
      return value;
    },
    (word) => events.push(['write', word]),
  );
  assert.throws(
    () => mod.pump(token, 3),
    (error) => {
      assert.deepEqual(diagnostic(error), diagnostic(expected));
      return true;
    },
  );
  assert.equal(reads, 3);
  assert.deepEqual(events, [
    ['read', 0],
    ['write', 0],
    ['read', 0xffffffff],
    ['write', 0xffffffff],
    ['read', undefined],
  ]);
  const recovered: number[] = [];
  const fresh = mod.a0_make_host_io(
    () => 0,
    (word) => recovered.push(word),
  );
  assert.equal(mod.pump(fresh, 1), fresh);
  assert.deepEqual(recovered, [0]);
});

test('JS host streams refuse malformed callbacks, results and foreign tokens without retries', async () => {
  for (const strict of [false, true]) {
    const p = parseAndValidate(
      profile(
        PUMP +
          `fn divide u32 -> u32
r div 19 p0
ret r
end
`,
        strict,
      ),
    );
    const mod = await load(compile(p, 'js', { jsIo: 'host' }).text);
    const recovery = () => {
      if (!strict) return;
      for (const name of ['pump', 'divide'] as const) {
        const fn = p.byName.get(name);
        assert.ok(fn);
        let expected: unknown;
        try {
          run(fn, name === 'pump' ? [makeIo([]), 1] : [0]);
        } catch (error) {
          expected = error;
        }
        assert.ok(expected instanceof A0Error);
        const eof = mod.a0_make_host_io(
          () => undefined,
          () => assert.fail('EOF must not write'),
        );
        assert.throws(
          () => (name === 'pump' ? mod.pump(eof, 1) : mod.divide(0)),
          (error) => {
            assert.deepEqual(diagnostic(error), diagnostic(expected));
            return true;
          },
        );
      }
    };
    for (const value of [undefined, null, 0, {}, 'read']) {
      assert.throws(() => mod.a0_make_host_io(value as ReadWord, () => {}), TypeError);
      assert.throws(() => mod.a0_make_host_io(() => 0, value as WriteWord), TypeError);
    }
    for (const value of [null, {}, { input: [], position: 0, output: [] }, 0])
      assert.throws(() => mod.pump(value, 0), TypeError);
    for (const value of [null, false, '0', -1, 0.5, NaN, Infinity, 0x1_0000_0000, {}]) {
      let reads = 0,
        writes = 0;
      const token = mod.a0_make_host_io(
        () => {
          reads++;
          return value as number;
        },
        () => {
          writes++;
        },
      );
      assert.throws(() => mod.pump(token, 1), RangeError);
      assert.equal(reads, 1);
      assert.equal(writes, 0);
      recovery();
    }
    const readError = new Error('independent read refusal');
    const readEvents: string[] = [];
    const readToken = mod.a0_make_host_io(
      () => {
        readEvents.push('read');
        throw readError;
      },
      () => {
        readEvents.push('write');
      },
    );
    assert.throws(
      () => mod.pump(readToken, 1),
      (error) => error === readError,
    );
    assert.deepEqual(readEvents, ['read']);
    recovery();
    const writeError = new Error('independent write refusal');
    const writeEvents: string[] = [];
    const writeToken = mod.a0_make_host_io(
      () => {
        writeEvents.push('read');
        return 0;
      },
      () => {
        writeEvents.push('write');
        throw writeError;
      },
    );
    assert.throws(
      () => mod.pump(writeToken, 1),
      (error) => error === writeError,
    );
    assert.deepEqual(writeEvents, ['read', 'write']);
    recovery();
  }
});

test('JS host tokens belong to their generated module and refuse foreign brands before effects', async () => {
  const text = compile(parseAndValidate(PUMP), 'js', { jsIo: 'host' }).text;
  const first = await load(text);
  const second = await load(`${text}\n// Distinct generated module instance for brand control.\n`);
  let reads = 0,
    writes = 0;
  const token = (mod: HostModule) =>
    mod.a0_make_host_io(
      () => {
        reads++;
        return 0;
      },
      () => {
        writes++;
      },
    );
  for (const [owner, foreign] of [
    [first, second],
    [second, first],
  ] as const) {
    assert.throws(() => foreign.pump(token(owner), 1), TypeError);
    assert.throws(() => foreign.pump(owner.a0_make_io([0]), 1), TypeError);
  }
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('JS host assembly retains buffered token observations and exhaustion behavior', async () => {
  for (const strict of [false, true]) {
    const p = parseAndValidate(profile(PUMP, strict));
    const mod = await load(compile(p, 'js', { jsIo: 'host' }).text);
    const buffered = await load(compile(p, 'js').text);
    const input = [0, 0xffffffff];
    const token = mod.a0_make_io(input);
    const control = buffered.a0_make_io(input);
    assert.notEqual(token.input, input);
    input[0] = 19;
    if (strict) {
      let expected: unknown;
      try {
        buffered.pump(control, 3);
      } catch (error) {
        expected = error;
      }
      assert.throws(
        () => mod.pump(token, 3),
        (error) => {
          assert.deepEqual(diagnostic(error), diagnostic(expected));
          return true;
        },
      );
    } else {
      assert.equal(mod.pump(token, 3), token);
      assert.equal(buffered.pump(control, 3), control);
    }
    assert.equal(token.position, 2);
    assert.deepEqual(token.input, control.input);
    assert.deepEqual(token.output, control.output);
  }
});

test('JS host effects preserve shared array fields, caller snapshots, zero folds and early loops', async () => {
  for (const strict of [false, true]) {
    const p = parseAndValidate(profile(SNAPSHOTS, strict));
    for (const optimize of [false, true]) {
      const mod = await load(compile(p, 'js', { jsIo: 'host', optimize }).text);
      for (const name of ['fold_probe', 'loop_probe'] as const)
        for (const count of [0, 1, 4]) {
          const fn = p.byName.get(name);
          assert.ok(fn);
          const before = [0, 0xffffffff, 17, 31];
          const input = Uint32Array.from(before);
          const expectedIo = makeIo([]);
          const expected = run(fn, [[...before], count, expectedIo]);
          assert.ok(Array.isArray(expected));
          const words: number[] = [];
          const token = mod.a0_make_host_io(
            () => assert.fail('snapshot source must not read'),
            (word) => words.push(word),
          );
          const actual = mod[name](input, count, token);
          assert.deepEqual([...actual[0]], expected[0]);
          assert.deepEqual([...actual[1]], expected[1]);
          assert.deepEqual([...input], before);
          assert.equal(actual[2], token);
          assert.deepEqual(words, expectedIo.output);
          if (count > 0) {
            actual[0][0] = 99;
            assert.deepEqual([...actual[1]], before);
            assert.deepEqual([...input], before);
          }
        }
    }
  }
});
