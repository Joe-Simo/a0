/**
 * Erlang/OTP: u32 values are (arbitrary-precision) integers masked with band 16#FFFFFFFF after
 * every operation that can leave the range; u32x4 arrays are lists, records are tuples.
 * The candidate module is compiled with erlc, the driver module separately, run with erl.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
import {
  BUILD_MS,
  failure,
  type LangCase,
  type LangSpec,
  RUN_MS,
  recordFields,
  signature,
  tool,
} from './spec.js';

const M = '16#FFFFFFFF';

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i]));
  return fields.length > 0 ? `{${items.join(', ')}}` : `[${items.join(', ')}]`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `    io:format("R${i} ~s~n", [fmt(mod:${t.fn}(${args}))]),`;
    })
    .join('\n');
  return `-module(driver).
-export([main/0]).

fmt(V) when is_integer(V) -> integer_to_list(V);
fmt(V) when is_boolean(V) -> atom_to_list(V);
fmt(V) when is_tuple(V) -> fmt(tuple_to_list(V));
fmt(V) when is_list(V) -> "[" ++ lists:flatten(lists:join(",", [fmt(X) || X <- V])) ++ "]".

main() ->
${body}
    io:format("DONE~n").
`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'fits(A, B) ->\n    A < B.\n',
    reference: 'fits(A, B) ->\n    A =< B.\n',
  },
  'b-sumfrom-eight': {
    source: `sumfrom(X) ->\n    lists:foldl(fun(I, S) -> (S + I) band ${M} end, X, lists:seq(0, 4)).\n`,
    reference: `sumfrom(X) ->\n    lists:foldl(fun(I, S) -> (S + I) band ${M} end, X, lists:seq(0, 7)).\n`,
  },
  'b-rot8-constant': {
    source: `rot8(X) ->\n    ((X bsl 8) bor (X bsr 23)) band ${M}.\n`,
    reference: `rot8(X) ->\n    ((X bsl 8) bor (X bsr 24)) band ${M}.\n`,
  },
  'b-onlyone-xor': {
    source: 'onlyone(A, B) ->\n    A orelse B.\n',
    reference: 'onlyone(A, B) ->\n    A =/= B.\n',
  },
  'b-avgfloor-nowrap': {
    source: `avgfloor(A, B) ->\n    ((A + B) band ${M}) bsr 1.\n`,
    reference: 'avgfloor(A, B) ->\n    (A band B) + ((A bxor B) bsr 1).\n',
  },
  'b-sumsq-array': {
    source: `sumsq(A) ->\n    lists:foldl(fun(I, S) -> (S + lists:nth(I + 1, A)) band ${M} end, 0, lists:seq(0, 3)).\n`,
    reference: `sumsq(A) ->\n    lists:foldl(fun(I, S) -> X = lists:nth(I + 1, A), (S + X * X) band ${M} end, 0, lists:seq(0, 3)).\n`,
  },
  'b-inrange-inclusive': {
    source: 'inrange(X, Lo, Hi) ->\n    X > Lo andalso X < Hi.\n',
    reference: 'inrange(X, Lo, Hi) ->\n    X >= Lo andalso X =< Hi.\n',
  },
  'b-bounds-largest': {
    source: `bounds(A) ->\n    lists:foldl(fun(I, {Lo, Hi}) ->\n        X = lists:nth(I + 1, A),\n        {if X < Lo -> X; true -> Lo end, if X < Hi -> X; true -> Hi end}\n    end, {${M}, 0}, lists:seq(0, 3)).\n`,
    reference: `bounds(A) ->\n    lists:foldl(fun(I, {Lo, Hi}) ->\n        X = lists:nth(I + 1, A),\n        {if X < Lo -> X; true -> Lo end, if X > Hi -> X; true -> Hi end}\n    end, {${M}, 0}, lists:seq(0, 3)).\n`,
  },
  'b-checksum-poly': {
    source:
      'checksum(A) ->\n    lists:foldl(fun(I, H) -> H bxor lists:nth(I + 1, A) end, 0, lists:seq(0, 3)).\n',
    reference: `checksum(A) ->\n    lists:foldl(fun(I, H) -> (H * 31 + lists:nth(I + 1, A)) band ${M} end, 7, lists:seq(0, 3)).\n`,
  },
  'b-norm2-dot': {
    source: `dot(A, B) ->\n    lists:foldl(fun(I, S) -> (S + lists:nth(I + 1, A) * lists:nth(I + 1, B)) band ${M} end, 0, lists:seq(0, 3)).\n`,
    reference: `dot(A, B) ->\n    lists:foldl(fun(I, S) -> (S + lists:nth(I + 1, A) * lists:nth(I + 1, B)) band ${M} end, 0, lists:seq(0, 3)).\nnorm2(A) ->\n    dot(A, A).\n`,
  },
  'b-pctof-limit': {
    source:
      'limit(X, Lo, Hi) ->\n    B = if X < Lo -> Lo; true -> X end,\n    if B > Hi -> Hi; true -> B end.\n',
    reference: `limit(X, Lo, Hi) ->\n    B = if X < Lo -> Lo; true -> X end,\n    if B > Hi -> Hi; true -> B end.\npctof(Part, Whole) ->\n    N = (Part * 100) band ${M},\n    Q = if Whole == 0 -> ${M}; true -> N div Whole end,\n    limit(Q, 0, 100).\n`,
  },
  'b-hamming-popcnt': {
    source: `popcnt(X) ->\n    lists:foldl(fun(I, S) -> (S + ((X bsr I) band 1)) band ${M} end, 0, lists:seq(0, 31)).\n`,
    reference: `popcnt(X) ->\n    lists:foldl(fun(I, S) -> (S + ((X bsr I) band 1)) band ${M} end, 0, lists:seq(0, 31)).\nhamming(A, B) ->\n    popcnt(A bxor B).\n`,
  },
};

export const ERLANG: LangSpec = {
  semantics: `Integers are unsigned 32-bit held in Erlang bignums: mask every arithmetic result with band ${M} (bsl/bsr for shifts, mask shift counts to 5 bits); comparisons are unsigned. u32x4 arrays are lists, records are tuples. Division by zero gives 4294967295; remainder by zero gives the dividend. The file is a module compiled with erlc.`,
  head: /^([a-z][A-Za-z0-9_]*)\(/,
  file: (body) => `-module(mod).\n-compile([export_all, nowarn_export_all]).\n\n${body}`,
  b: B,
  driver,
  compileLabel: 'erlc',
  async buildAndRun(dir, source, drv) {
    const erlc = tool('erlc', 'A0_ERLC', ['/opt/homebrew/bin/erlc']);
    const erl = tool('erl', 'A0_ERL', ['/opt/homebrew/bin/erl']);
    await writeFile(join(dir, 'mod.erl'), source, 'utf8');
    await writeFile(join(dir, 'driver.erl'), drv, 'utf8');
    const mod = runTool(erlc, ['-o', dir, join(dir, 'mod.erl')], { cwd: dir, timeoutMs: BUILD_MS });
    if (!mod.ok) return failure('erlc', mod);
    const d = runTool(erlc, ['-o', dir, join(dir, 'driver.erl')], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!d.ok) return failure('driver', d);
    const run = runTool(
      erl,
      ['-noshell', '-pa', dir, '-s', 'driver', 'main', '-s', 'init', 'stop'],
      {
        cwd: dir,
        timeoutMs: RUN_MS,
      },
    );
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
