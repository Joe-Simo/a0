# A0 status ledger

Updated 2026-09-29. Durable state for the next session: scope, evidence, blockers, next action.
Every claim below is either reproduced by a command in this repo or labelled as not run.

## Provenance

The starter archive `A0-Research-Starter.zip` was not present on the workstation, in
iCloud, or on GitHub (full-disk search, both GitHub accounts). This implementation was
rebuilt from `DESIGN.md` and the handoff spec (`HANDOFF.txt`). It follows the documented
package map and semantics but is not byte-identical to the original package; the
original report is kept as `results/verification-handoff-2026-09-29.json` and is *not*
reproduced evidence (different corpus generator, different case count). If the archive
turns up, reconcile against this tree rather than overwrite either.

## Design decisions recorded from the user (2026-09-29)

- Human readability is not a constraint. The representation is optimized for AI read/write
  cost and correctness; audit views may be derived, never the primary form.
- Any change must be rejected before commit if it fails parsing, typing, or revision
  matching; well-typed wrong behavior is caught by acceptance tests, not by syntax.
- Execution performance across targets is a goal with a ledger, not a claim; ties and
  losses stay visible.

## Implemented scope (v0.1.1)

- Types `u32`, `bool`; ops `mov add sub mul and or xor shl shr eq lt select` with exact
  wrapping/logical/unsigned semantics; positional params; one result; straight-line.
- **`call f a...`** (new): applies a function defined *earlier* in the program (acyclic,
  no recursion); typed against the callee; evaluated by interpreter and BigInt oracle;
  constant-folded and CSE'd; emitted as a call in JS/C/Java and as a module instance
  in SystemVerilog. Not implemented: loops, control-flow regions, memory, effects, I/O.
- Edits: self-contained patch (`patch name sha256 … end`) and session handle edits
  (`e0` + replaced lines). Replace-existing-nodes only. Handles are one-use and
  revision-bound. No insertion/deletion, no multi-function transactions, no network service.
- Emission cache keyed on compiler version, target, opt level, and **semantic revision**
  (own content + transitive callees); editing a callee invalidates callers (tested).
- Backends: JS (ES module with public input guards), C (also valid C++), Java, SystemVerilog.
- Safety principle (user requirement 2026-09-29): every model-authored program or edit is
  parsed, type-checked, and revision-matched *before* commit; a malformed edit is
  rejected with a diagnostic and the program is untouched. This does not stop a model
  from writing a wrong-but-well-typed program; acceptance tests do that (Gate A harness).

## Reproduced checks (this machine: macOS 27.2 arm64, Node v24.14.0, Bun 1.3.4)

| Check | Command | Result |
|---|---|---|
| Lint (Biome 2.2.4) | `bun run lint` | pass (previously blocked) |
| Typecheck (tsc 5.9.3, strict) | `bun run typecheck` | pass |
| Focused tests | `bun run test` | 12/12 pass |
| Interpreter vs oracle | `bun run verify` | 6593 cases pass |
| Optimizer vs oracle | `bun run verify` | 6593 pass |
| JS in Node | `bun run verify` | 6593 pass |
| C via Apple clang 21, UBSan | `bun run verify` | 6593 pass |
| C via GNU gcc-15, **no sanitizer** (macOS gcc has no libubsan) | `bun run verify` | 6593 pass |
| C-compatible source as C++17 via clang++, UBSan | `bun run verify` | 6593 pass |
| Java via Homebrew OpenJDK 27 | `bun run verify` | 6593 pass |
| WebAssembly (Homebrew clang 23 + wasm-ld, wasm32 freestanding) | `bun run verify` | 6593 pass, executed in Node's WebAssembly runtime; no browser/DOM test |
| SystemVerilog RTL simulation (Icarus 12, `-g2012`) | `bun run hw` | 6593 cases pass, 48 modules incl. call instances |
| SystemVerilog generic synthesis (Yosys 0.69 `synth` + `check -assert`) | `bun run hw` | pass; cell counts per module in `results/hardware.json` |
| Not run for hardware | — | FPGA place-and-route, real cell library, timing, area, power, sequential logic |

Corpus: 48 seeded functions, seed 0xa0beef / input seed 0x12345678, 115 call sites,
sha in `results/verification.json`. Deterministic generated inputs, not application evidence.

Bug found and fixed by hardware simulation: SV emitted `literal[4:0]` for shifts by a
constant (illegal). Regression test added. This is the first counterexample the hardware
gate produced and the reason the gate exists.

## Measurements (evidence level stated per row)

### Token probe (`bun run tokens`, js-tiktoken o200k_base / cl100k_base — OpenAI encodings, NOT Claude's tokenizer)

| Fixture | bytes | o200k tokens | Verdict vs baseline |
|---|---|---|---|
| affine in A0 | 62 | 30 | **loss** vs hand-written C (29); win vs TS (35); ~tie vs Python (32) |
| A0 session edit | 14 | 9 | win vs TS line-replace session edit (20), TS search/replace (42), unified diff (79) |
| A0 self-contained patch | 93 | 48 | loss vs TS search/replace (42); win vs unified diff |
| MODEL_GUIDE.txt (setup A0 must pay) | — | ~489 | pure overhead; TS setup note ~48 |
| 48-fn corpus A0 vs emitted JS/C/Java | 42.7 kB | 23k vs 45–52k | not fair: baselines are machine-generated, not hand-written |

Level: local payload token counts. Not an AI-task experiment. The session-edit win is
largely a protocol effect; the 2×2 harness exists to separate it from the language effect.

### Execution micro-benchmark (`bun run exec-bench`, clang -O2 no sanitizer; Node JIT warm)

affine, rotl, clamp, mix: **tie** in C (identical within noise, e.g. 4.478 vs 4.479 ns/call
including generator) and **tie** in JS, with emitted JS consistently 2–4 % slower because
public functions keep input guards. Level: scalar micro-kernels; not startup, memory,
energy, or applications. No performance superiority is demonstrated or expected here.

### Gate A: 2×2 AI-edit experiment (`bun run experiment`)

Harness implemented and self-checked (reference solutions pass, originals fail, in all
four cells: A0/TS × conventional/structured). Whole-task accounting: setup, view, output,
provider usage, calls, validation failures, repairs, wall time; reasoning tokens recorded
as null. **Status: unrun.** Requires `A0_ALLOW_PAID_MODEL_CALLS=1` plus Anthropic
credentials (none configured on this machine); default model `claude-opus-5-5`, 3 trials
per cell. Only three tasks exist; expand before drawing conclusions.

## Repository

Private GitHub repo `Joe-Simo/a0` (verified `isPrivate: true`), branch `main`, project
at repo root, `bun.lock` committed, `dist/` and `node_modules/` ignored. Commits are
listed by `git log`; the push is verified against `origin/main` after each commit.

## Blockers / not done

- `A0-Research-Starter.zip` absent (see Provenance).
- Paid model runs not authorized; Gate A unrun.
- No Claude-tokenizer counts (needs `count_tokens` with credentials; free but blocked).
- Not implemented: loops/regions, memory/arrays, effects, .NET, GPU, mobile packaging,
  library import/FFI, persistent artifact cache, network edit service, fuzzing.

## Next concrete action

1. Add structured control flow: a bounded `loop` region with an explicit trip count and
   loop-carried values (software) that lowers to a counted loop in JS/C/Java and to an
   unrolled or FSM form in SV, with evaluator, oracle, optimizer safeguards
   (no hoisting across iterations without proof), backends, and tests together.
2. Expand the Gate A task set (≥10 held-out tasks incl. multi-function edits) and run it
   when authorized; report per-cell accepted-change cost with uncertainty.
