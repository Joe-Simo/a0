# Single-syntax status and acceptance blockers

This is the current implementation map, not a public cutover announcement. The goal remains
one public grammar, specification, formatter and editing protocol. Canonical/strict are
semantic profiles, not two authoring grammars. Old spellings remain compatibility inputs
until a validated migration and cutover; their historical benchmark rows are not one unified score.

## Completed candidate integration

| Component | Implemented and tested boundary | Evidence |
| --- | --- | --- |
| Grammar and graph migration | Candidate parser/printer and staged conversion preserve originals, imports, revisions and outputs in the retained fixtures. This is not proof for every repository input. | `results/unified-source-migration.json`, `results/cli-source-migration.json` |
| CLI | Check, run, emit, patch, revision and legacy import use the same explicit candidate binding. Public default remains unchanged. | `results/cli-source-boundary.json` |
| MCP and LSP | Candidate editing/views/saves, diagnostics, formatting and completions share the bound frontend. Legacy import stays explicit. | `results/mcp-source-compat.json`, `results/lsp-source-compat.json` |
| Guides and initialization | Candidate starter code, generated guides/hooks and idempotent initialization are executable tests, including conflict refusal and rollback. | `results/source-candidate-init.json` |
| Sealed sessions and hooks | Candidate reader is integrated without a mounted plaintext tree; synthetic encrypted-session controls preserve revisions and outputs. The current review fixes additional cancellation races. | `results/source-sealed-hooks.json`, `results/security-session-review.json` |
| Diagnostics and relocation | All 90 runnable catalog examples execute with the candidate; 60 remain explicitly non-runnable. Isolated project/compiler relocation and launcher regeneration are tested. | `results/source-explain-relocation.json` |
| Editor assets | Candidate grammar/highlighting, snippets and trusted project launcher binding are implemented; extension typecheck/bundle passed. A real editor-host/platform matrix remains pending. | `results/source-editor-grammar.json` |

Some historical evidence files retain their old `remaining` lists. Later rows above supersede
those integration-only items; they do not waive the acceptance gates below.

## Native-cost evidence: still a blocker

The older matched six-input control in `results/lsp-source-compat.json` records the following
A0-owned native-frontend / frozen historical Canonical-reader latency ratios. These are the
original same-host measurements, not measurements rerun by this review and not global wins.

| Input | Recorded ratio |
| --- | ---: |
| `examples/life.a0` | 3.759 |
| `site/lib/frame.a0` | 4.696 |
| `site/page.a0` | 5.323 |
| `site/docs.a0` | 4.580 |
| `compiler/boot.a0` | 6.541 |
| `compiler/parse_arena.a0` | 4.978 |

The later readonly-leaf experiment at `77548a7f` was rejected: its six-input geometric mean
ratio against `7b5e0f9a` was 0.990392, below its predeclared 5% improvement requirement.
It is a different comparison and must not be multiplied into the older table. Bulk-write
experiments were also rejected. The historical 616-loss ledger has not been refreshed into
a global current scoreboard. See `results/security-session-review.json` for the carried-forward
experiment records and [the ownership design](design/native-frontend-ownership.md) for the next
required causal investigation. No further micro-optimization loop is justified by these results.

The later explicit local-arena experiment is recorded in `results/local-arena.json`.
Against `a143fb20` on six fixed inputs, its later-call ratio is 0.6078 and its module
shrinks by 17,334 bytes, with peak runtime RSS up to 4.45% higher and build CPU about
6.47% higher. It preserves the default executable and is opt-in only. This does not
replace the historical table, establish parity with the current host reader, or
clear platform/AI cutover gates. See [the checked local contract](design/local-arena-contract.md).

The retained security fences also have a cost: the prior synthetic cold 100-entry cache-write
control measured 47.504 ms before versus 61.933 ms after. This is neither a native frontend
measurement nor a reason to remove safety checks; broad protection cost targets remain pending.

## Completed aggregate diagnostic coverage

The candidate now renders completed aggregate example mismatches from its native
values and declared types, including nested arrays/records and dependency-owned
locations. The older aggregate-only result added 3,360 Wasm bytes and had mixed
resource controls; it did not establish a speedup or satisfy native-cost acceptance.
The fresh C-derived, direct-Wasm and JavaScript qualification covers 66 source cases,
including runtime traps, complete diagnostic JSON and executable repairs. All 15
control tests passed without skips. This supersedes the older runtime-trap refusal
limitation only for the checked cases. See `results/source-compiled-diagnostics-20261102.json`
and the preserved historical `results/source-spec-aggregate-diagnostics.json`.
The frozen blinded-study preparation remains preserved separately at `122ffbde`;
no model subjects or paid API calls were run by this follow-up.

## Exact remaining gates

The internal standalone entrypoint now supplies its executable explicitly to project
initialization. Generated launchers therefore no longer import the removed build checkout.
The Linux relocation, revision, rollback and compatibility controls are recorded in
`results/source-standalone-init.json`. The ordinary Node-checkout binding remains unchanged;
the release script and public defaults are not switched. The generated launcher still uses
Node to start the executable, so this is not a Node-free packaging or startup-cost claim.

| Gate | Work still required | Can it be completed here without paid services? |
| --- | --- | --- |
| Full language coverage | The [repeatable source coverage audit](SOURCE-COVERAGE.md) checks repository graphs and static real test programs, including the checked operations and specifications missing from the ordinary corpus. Dynamic generators, external projects, capacity combinations and full candidate diagnostic edits still require expansion; this is not exhaustive proof. | Local deterministic expansion is possible. |
| Native cost | Attribute copies/allocations to call sites, implement a justified ownership/lifetime change, and pass matched latency/CPU/RSS/size/build-cost controls. | Local Linux profiling is possible. The accepted opt-in local-arena improvement above does not yet satisfy the complete cost gate. |
| AI accuracy and total cost | Fresh independent edit/task study using corrected guides, complete requests/replies/repairs and the specified model controls. Payload token counts do not satisfy it. | No approved free model-execution route for this study is available here. Paid API calls remain prohibited. |
| Real platforms | Complete the OS/toolchain and editor-host matrix, plus relevant physical GPU/hardware validation. Preserve each skipped, blocked and emulated row. | Standard public GitHub runners now provide bounded macOS and Windows qualification without paid CI. The native bootstrap, corpus and application results are recorded in [the cloud qualification report](../results/cloud-platform-qualification-20261102.json). This does not establish physical-device or full release qualification. |
| Protection assurance | External crypto/security review, remaining host and distributed-artifact adapters, reconstruction studies, cost budgets and unresolved lock/ownership cases. | Local regression work is possible. External assurance and unavailable hardware cannot be claimed from this review. |
| Public cutover | Switch parser, formatter, guides, CLI/MCP/LSP/editor defaults together only after acceptance, retaining labelled legacy import and rollback. | Public defaults remain unchanged; the gates above and explicit release approval are still required. Non-release progress publication does not activate the cutover. |

RISC-V RV64, ARM32 and AVR now also have bounded simulator corpus and strict-reference qualification
on standard Linux runners. The [emulator report](../results/cloud-emulated-qualification-20261102.json)
records exact inputs, separate oracles, excluded I/O, the failed setup attempt and corrected run.
This does not qualify physical devices, editor hosts or every backend feature.

The [hosted Metal regression report](../results/metal-loop-qualification-20261102.json)
records a corrected scalar-loop failure on the hosted Intel runtime and passing
focused, behavior and independent corpus checks on both hosted Mac architectures.
Both runners report a paravirtual Metal device; physical GPU and performance
qualification remain outstanding. Its separate Linux ARM64 result predates this
fix and is not evidence for the newer tree.

The [decimal-distance study](../results/decimal-distance-20261102.json) records a
bounded optimization of native integer formatting, with exact output checks and
separate runtime, compile-cost, size and memory measurements. This workload is
separate from the native frontend acceptance budget; the Intel timeout remains
unqualified until the unchanged oracle passes on that platform.

The current local review is scoped source review plus adversarial tests. It is not a hosted
Codex Security scan, independent cryptographic certification or production-security approval.
