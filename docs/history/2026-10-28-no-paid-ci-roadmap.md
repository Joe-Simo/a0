# Cumulative roadmap under the current execution constraints

The goal remains universal A0 correctness and competitive runtime, output size, compilation cost and other measured resource axes. The cloud milestones establish scoped improvements, not universal superiority. The historical 616-entry ledger remains separate from newer same-host comparisons.

Completed and preserved work includes the recreated compiler correctness fixes; JavaScript scalar record folds, array-loop inlining and private-function pruning; native arithmetic reductions and guarded SSE4.1 dispatch; and bounded larger JavaScript record folds. The [earlier scoped scoreboard](../../results/retained-scoreboard.json), [JavaScript UTF-8 report](../../results/js-wide-fold-summary.json), and [new native report](../../results/native-inline-summary.json) record their scopes and limitations. This milestone removes the redundant native loop-inlining cap while preserving the expanded-code budget. Prior checkpoints and failed experiments remain recoverable through Library archives.

Useful work this Linux environment can complete next:

- Investigate the remaining native histogram and dot-product gaps with unchanged algorithms, correctness oracles and representative controls. Retain ISA-specific paths only with feature guards and executable fallback coverage.
- Investigate the remaining JavaScript sorting and UTF-8 gaps. Prefer eliminating redundant work or allocations before expanding more loop bodies.
- Measure code size and warm/cold compilation alongside runtime. Existing private-function pruning reduced JavaScript output, while several speed improvements increased code size; neither tradeoff is hidden.
- Run Linux native, C, JavaScript, direct and C-derived Wasm, JVM, .NET, behavioral checks, self-host C checks, and available equivalence proofs. Continue preserving exact source trees, raw logs, rejected probes and repeatable artifacts.

Release requirements this environment cannot establish include the outstanding Mac/Windows and other platform-specific checks, hardware simulation/synthesis and unavailable accelerator/toolchain checks. Emitting hardware text is not simulation or synthesis. A passing light/available gate is not a full release gate. Timing does not establish energy consumption, and process RSS does not establish all memory behavior.

A genuinely zero-cost complete route would require existing authorized resources for every missing platform, with their exact toolchains and results bound to this tree, or an independently established service route with no charges. Neither route is currently established. Joe's Mac/Safari, Actions, pushes, deployments, paid services, new credentials and billing changes remain prohibited. No permission to use those routes or exception to AGENTS.md is inferred. Independent local development and evidence preservation continue while release stays blocked.
