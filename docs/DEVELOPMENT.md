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
