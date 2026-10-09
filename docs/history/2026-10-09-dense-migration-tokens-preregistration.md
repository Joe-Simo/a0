# Dense migration, token measure: pre-registration (2026-10-09)

Written and committed before any measurement on migrated files.

## Question

If the in-tree A0 programs are written in the dense spelling (src/dense.ts), how many tokens do the
ten token kernels cost against every other language the loss ledger compares, and how many recorded
`tokens-kernel` losses would close? Earlier numbers (559 -> 296 tokens, 351 -> 66 losses) came from
converter output only; this measures migrated files on disk.

## Files

- Migrated: every `.a0` file `listSources()` (tools/dense-loader.ts) returns under corpus, examples,
  compiler and site, except `isReject` files, that `parse` accepts. Each is written as
  `dense/<same path>` with `formatDense(program, { known: arities(usedSignatures(file)) })`. The
  canonical files stay unchanged.
- The ten token kernels (`TOKEN_KERNELS`, sources `k.a0` in tools/exec-bench-kernels.ts) are written as
  `dense/kernels/<name>.a0` with `formatDense(parse(k.a0))` (no `normalizeProgram`, so the file reads back
  to the kernel's canonical text exactly).
- Read-back: a migrated file counts as migrated only when `parseDense` of the file text formats back to
  the file text, and the A0 reader (compiler/dense.a0 `canonfn`, through `readChunked` of
  tools/dense-chunk.ts at READER_CAPS, stubs for the used files) reads it to the canonical text
  (`formatProgram`) of the original, with no function refused. Anything else is reported with its
  reason (parse error, outside the reader's forms, refused up front, flagged, different text).

## Metric

The ledger's own: o200k_base tokens (js-tiktoken), as tools/lang-axes.ts counts them.
- `tokens-kernel`: tokens of the migrated kernel file text with its trailing newline removed.
- `tokens-program`: tokens of that text plus one newline (lang-axes's A0 program rule).
Competitor counts are taken unchanged from results/lang-axes.json `tokens.<lang>.kernels` for every
language there except `a0` (48 languages).

## Rule

The ledger's (tools/loss-ledger.ts `lower`, `isLoss`, noise 0 for token axes): gap = a0/other - 1;
loss when gap > 0, tie when gap = 0, win when gap < 0. Flips are counted against the 351 recorded
`lang-axes|*|tokens-kernel|*` entries of results/loss-ledger.json. The ledger is not updated.

The 2x question per kernel: is the dense kernel's count <= half the smallest count of any other
language on that kernel? Also reported for the sum over the ten kernels against the best single
language and against the sum of per-kernel bests. A no is reported as a no.
