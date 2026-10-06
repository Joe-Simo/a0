/**
 * What would a smaller canonical syntax do to the `tokens-kernel` losses of the ledger? A deterministic, local analysis (no model, no subject):
 * each hypothetical rewrite of the canonical text of the ten lang-axes kernels is counted in o200k tokens (js-tiktoken) and compared with the
 * competitors' kernel tokens of results/lang-axes.json, entry by entry against the recorded canonical losses of results/loss-ledger.json.
 * A rewrite listed here is NOT implemented in the language: it measures what a design would cost or save, and says nothing about whether a
 * model writes it correctly (that needs fresh subjects).
 *
 *   node dist/tools/canon-syntax-tokens.js   -> results/canon-syntax-tokens.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { getEncoding } from 'js-tiktoken';
import { KERNELS } from './exec-bench-kernels.js';

const enc = getEncoding('o200k_base');
const tokens = (text: string): number => enc.encode(text).length;

interface Variant {
  readonly id: string;
  readonly what: string;
  readonly rewrite: (a0: string) => string;
}

/** `fn name T... -> T` header to `fn name -> T` when every parameter is u32 (the arity comes from the highest pN). */
const dropU32Params = (a0: string): string => a0.replace(/^(fn \S+)((?: u32)+) -> /, '$1 -> ');
const dropEnd = (a0: string): string => a0.replace(/\nend$/, '');
/** `ret X` as the last line becomes the value of the last node: the line is dropped when X is the last node id. */
const dropRet = (a0: string): string => {
  const lines = a0.split('\n');
  const ret = lines.findIndex((l) => l.startsWith('ret '));
  const last = lines[ret - 1]?.split(' ')[0];
  if (ret > 0 && lines[ret]?.slice(4) === last) lines.splice(ret, 1);
  return lines.join('\n');
};

const VARIANTS: readonly Variant[] = [
  {
    id: 'no-end',
    what: 'drop the `end` line (a function ends at the next `fn` or the end of the file)',
    rewrite: dropEnd,
  },
  {
    id: 'no-ret',
    what: 'drop `ret X` when X is the last node (the last node is the result)',
    rewrite: dropRet,
  },
  {
    id: 'no-u32-params',
    what: 'leave out the parameter types of an all-u32 header (`fn f -> u32`)',
    rewrite: dropU32Params,
  },
  {
    id: 'no-end-no-ret',
    what: 'both of the first two',
    rewrite: (a) => dropEnd(dropRet(a)),
  },
  {
    id: 'no-end-no-ret-no-u32-params',
    what: 'all three (the canonical form with the dense form’s header, terminator and result conventions, still one node per line with an id)',
    rewrite: (a) => dropU32Params(dropEnd(dropRet(a))),
  },
];

const TOKEN_KERNELS: ReadonlySet<string> = new Set([
  'affine',
  'rotl',
  'clamp',
  'mix',
  'ident',
  'noop',
  'chain3',
  'branchy',
  'arrfill',
  'loop64',
]);
const lang = JSON.parse(readFileSync('results/lang-axes.json', 'utf8')) as {
  tokens: Record<
    string,
    {
      kernels?: Record<string, { kernel: number }>;
      dense?: { kernels: Record<string, { kernel: number }> };
    }
  >;
};
const ledger = JSON.parse(readFileSync('results/loss-ledger.json', 'utf8')) as {
  entries: { axis: string; kernel: string; competitor: string; a0: number; other: number }[];
};
const losses = ledger.entries.filter((e) => e.axis === 'tokens-kernel');

const rows = KERNELS.filter((k) => TOKEN_KERNELS.has(k.name)).map((k) => {
  const base = tokens(k.a0);
  const byVariant = Object.fromEntries(VARIANTS.map((v) => [v.id, tokens(v.rewrite(k.a0))]));
  return { kernel: k.name, canonical: base, ...byVariant };
});
const kernelTokens = (name: string, id: string): number => {
  const row = rows.find((r) => r.kernel === name) as Record<string, number | string>;
  return row[id] as number;
};

const closes = Object.fromEntries(
  VARIANTS.map((v) => {
    const closed = losses.filter((e) => kernelTokens(e.kernel, v.id) <= e.other);
    const byKernel: Record<string, number> = {};
    for (const e of closed) byKernel[e.kernel] = (byKernel[e.kernel] ?? 0) + 1;
    return [v.id, { closes: closed.length, of: losses.length, byKernel }];
  }),
);

writeFileSync(
  'results/canon-syntax-tokens.json',
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      tool: 'tools/canon-syntax-tokens.ts',
      tokenizer: 'o200k_base (js-tiktoken)',
      meaning:
        'Hypothetical rewrites of the canonical A0 text of the ten lang-axes kernels, counted in tokens, and how many of the recorded canonical tokens-kernel losses of results/loss-ledger.json each would close (the competitor count unchanged). Nothing here is implemented in the language and no model wrote any rewrite: it measures the token side of a design only, not whether models write it correctly.',
      noteNoop:
        "The A0 noop kernel carries three identity operations on purpose (the optimizer must not add work; tools/exec-bench-kernels.ts), while every competitor's noop source is `return x`: its token losses compare programs of different structure and are recorded as they are, not redefined.",
      variants: VARIANTS.map((v) => ({ id: v.id, what: v.what })),
      kernels: rows,
      denseForComparison: Object.fromEntries(
        Object.entries(lang.tokens.a0?.dense?.kernels ?? {}).map(([k, v]) => [k, v.kernel]),
      ),
      closesLosses: closes,
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify(
    { closes: Object.fromEntries(Object.entries(closes).map(([k, v]) => [k, v.closes])), rows },
    null,
    1,
  ),
);
