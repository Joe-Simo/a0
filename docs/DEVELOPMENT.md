# Development loop (ledger)

How A0 is developed, and how to read the tools. The binding rules are in `AGENTS.md`; this file is the
reference and the place measured loop timings are explained.

## Tools (all under `tools/dev/`, entry `a0-dev`)

Each tool is standalone and deterministic, and prints machine-readable output with `--json`. Build
with `bun run build`, then `node dist/tools/dev/a0-dev.js <command>` or `bun run a0-dev -- <command>`.

| Command | What it decides | Floor |
|---|---|---|
| `scope` | gate steps a diff needs, each with its reason | static map: import closures plus leaf-backend rules; unmapped files run everything |
| `plan` | batches and order for merging branches | `merge-tree` conflicts, shared files, shared core, shared steps |
| `gate` | runs steps one at a time with timeouts and logs | writes a tree-bound gate note on a pass; refuses to push on a missing step |
| `drive` | merges branches that carry passing notes, one combined gate per batch | reverts only the branch that caused a confirmed loss |
| `claims` | numeric and comparative claims need `results/*.json` | flags unsupported claims and speed claims recorded above load 10 |
| `decide` | real regression, flake, pre-existing, unexplained | history in `.a0-cache/gate-history.json` |
| `classify` | why a model reply failed | rules: truncation, format slip, protocol ambiguity, model error |
| `queue` | failure groups ranked by rows, generality, cost | reads `results/*.json` |
| `prereview` | hunks that patch a symptom | pattern rules over added lines |
| `tests` | tests a diff can affect (`--run` runs only those) | import closure of each test file |
| `order` | riskiest-first step order and sentinels | prior failure chance per cost, blended with history |
| `check` | `stuck`, `bench-validity`, `launch-gate`, `rank`, `verify-report` | pure rules over measured inputs |
| `loop` | per-step wall-clock, baseline against assisted | `results/dev-loop.json`, quiet runs only |

## Extension points

Every tool accepts additions only. `scope --add-steps=a,b` adds gate steps to the floor, and
`plan --couple=a:b` declares coupling the rules cannot see. Nothing can remove a step the floor chose.
A wrapper that adds decisions must label them as hypotheses in its own output.

## Gate notes

`refs/notes/a0-gate` holds one JSON note per gated commit: tree id, steps run, light or full, result.
`a0-dev note [<rev>]` prints it. The note is valid only while `<rev>^{tree}` equals the recorded tree.
Notes are repository metadata: fetch and push the notes ref explicitly if they must travel.

## Loop timing

`gate --mode=baseline|assisted` appends each step's wall-clock and the 1-minute load to
`results/dev-loop.json`. `a0-dev loop` prints per-step medians for both modes and their ratio, using
only entries at load 10 or below, and only when each mode has at least three of them. A speedup is
published from that file or not at all.

## Gate speed

- **Build once.** `bun run build` is `tsc --incremental` with its build-info file in `dist/`, so a build with nothing changed costs seconds, and deleting `dist/` forces a full rebuild. The gate builds once and runs each step's `node dist/...` command directly; every package script still builds first, so each step runs on its own.
- **Step cache.** A gate step is keyed by a hash of the files it reads (import closure plus data files such as examples, compiler sources, results inputs for the site), its command, `COMPILER_VERSION`, the node version and the platform. A step whose key equals the key of its last passing run on this machine is skipped and printed as `cached (key)`; the result line shows `step=cached(<key12>)`. The cache is `.a0-cache/step-cache.json` (git-ignored). Timing steps (`exec-bench`, `lang-axes`, `bench`, `par-bench`, `wasm-bench`, `edit-loop-bench`, `native-check`) never cache. The key does not cover installed toolchains: after upgrading clang, java or a simulator, run `a0-dev gate --no-cache`.
- **Results merge by kind.** `.gitattributes` maps the gate-regenerated pass/fail files (verification, equivalence, hardware, behavior, selfhost, selfhost-c, bootstrap*, app, dotnet, gpu) to the `a0-results` driver, "keep the current side", and every other `results/*.json` (timings and measurements) to `a0-measurements` (`tools/dev/merge-results.ts`): a run with a `loadGate` is never dropped for one without, then the lower recorded load wins, then the newer `generatedAt`; logs (`entries`) are unioned; with no rule the merge conflicts. `a0-dev setup` (also run by `drive`) configures both in the clone. `a0-dev gate --commit-results` (always on in `drive`) commits the regenerated results as one commit after a pass and writes the gate note on that commit.
- **Scheduler.** Phases: lint and typecheck together, the build, test and site together, then each heavy step alone, riskiest first, stopping at the first failure. Overlap is bounded by `floor(cores * 0.6 - load1)`, at most 4, and is 1 above load 10; `--max-parallel=N` overrides. Step timings are written to `results/dev-loop.json` only at load 10 or below.
