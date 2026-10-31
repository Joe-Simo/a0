# Unified source cutover: evidence and remaining gates

The candidate has one bound reader across project initialization, CLI, MCP, LSP, editor
operations, diagnostic examples and sealed sessions. This is an internal integration milestone,
not activation of the public default. Historical Canonical/Dense measurements remain historical.

| Gate | Current evidence | Remaining work and where it can run |
| --- | --- | --- |
| Semantic/tooling consistency | Six retained projects preserve source hashes, revisions and C/JS output; candidate guide, hooks, edits and diagnostic examples are executable tests. | Keep equivalence controls for future changes. Additive editor grammar, candidate completion and trusted-project binding are recorded by the later editor milestone; real editor-host/platform validation remains separate. |
| Diagnostic examples | All 90 runnable examples use the candidate parser/editor and retain their expected failure codes; 60 catalog rows explicitly require other APIs/protocols. Public-default explanation bytes are unchanged. | Preserve explicit non-runnable reasons; do not count them as executed examples. |
| Relocation | Isolated project move and compiler move retain outputs/revisions after explicit regeneration; a failed regeneration restores the previous launcher. | Packaged executables and other platforms still need their own execution checks. No change to a user installation was used as a test. |
| Native frontend cost | The last paired six-input report records frontend ratios 3.76–6.54 against its frozen historical reader control. This milestone does not rerun or improve those timings. | A general cost improvement with fresh paired CPU/RSS/latency/size controls is still required. Available Linux tooling can do this work. |
| AI accuracy and total cost | Local tokenizer counts and deterministic examples are available; they do not measure model success, retries, context overhead or total cost. | A fresh, independently controlled task study needs a permitted model execution route. No paid API was used or authorized here. |
| Full-platform correctness | The available Linux aggregate is a subset; skipped/unavailable targets are explicit. | Mandatory actual Mac/Windows/other platform checks remain. No simulation or Linux result substitutes for them; Mac access and paid CI remain prohibited. |
| Protection readiness | Synthetic tests cover sealed sessions, managed writer fences and rollback. | Independent security review, stale/interrupted lock procedures and external-writer limits remain. No universal application secrecy or secure memory-erasure claim. |
| Publication | Public defaults, repository publication and website remain unchanged. | Owner/publication authorization is separate from technical validation and does not waive missing gates. |

## Supported next native frontend investigation

The strongest available profiling lead is **repeated arena transport and fixed-size state
copying across parsing/checking**, not another formatter or instruction-level tweak.
The preserved A0-owned frontend Wasm profile has 2,583 sampling ticks (27 unaccounted): its
printed symbol rows include `a0_runtime_write` 179, `memcpy` 119, `a0_arena_reply` 56,
`a0_ap_scanword` 47 and `a0_arena_reply_header` 34. The baseline artifact SHA matches the
current checked-in frontend. These are historical sampled rows, not a new benchmark, an
inclusive call-tree accounting or a native-CPU executable profile.

Code inspection explains the lead: parser/checker state uses 128-word values; a successful
requirement still performs a checked line-table arena read, and read/reply operations carry
fixed-size payloads. Previous recording-only, scalar-read and conditional-fold experiments
preserved correctness but did not clear their uncertainty bands; some increased output size.
That evidence rules out presenting those micro-changes as progress.

The next algorithmic experiment should first measure current per-phase arena request counts,
payload words and copies on the unchanged six inputs, then assess batching related checked
reads/updates within a phase. It must retain handle/span validation, first-error ordering,
allocation-failure behavior, linear IO and invalidation at every write. Do not cache unchecked
views or remove successful-path validation. Retain a change only after matched end-to-end
CPU/RSS/latency and module-size controls improve beyond their uncertainty bands. This is a
prioritized hypothesis, not a retained optimization or a claim that it alone closes the gap.

Evidence: [explain/relocation controls](../../results/source-explain-relocation.json),
[paired frontend costs](../../results/lsp-source-compat.json), and the preserved profile and
rejected experiments in the local recovery archive. No global benchmark superiority is claimed.


## Editor integration and current profile follow-up

The later editor milestone extends the existing Tree-sitter/TextMate grammar, without a second
language ID or changed compiler default. Candidate project settings bind the existing VS Code
client to the local launcher only in a trusted, single local-folder workspace. Real LSP tests
validate completion snippets; the extension is typechecked and bundled. No actual VS Code GUI
session or cross-platform result is inferred from those checks.

A fresh warm in-process profile on the unchanged six inputs records 4,373 samples, including
1,452 in `memcpy`, 653 in `a0_runtime_write`, and 379 in `a0_arena_reply`. The symbolized artifact's
executable sections equal the checked-in seed. This reinforces the arena-copying investigation;
it is not a comparison with the historical cold timings, a speedup claim, or a native-CPU profile.
See [editor evidence](../../results/source-editor-grammar.json) for raw-input and method details.


## Ownership boundary after bulk-output experiments

The reply loop already uses an owned C state pointer: `arena_reply_word` updates its page
in place. Remaining page copies cross immutable aggregate call/results and the protocol's
owned response buffer. A LOAD reply is a snapshot; lending its backing storage would require
an explicit lifetime ending before any write, reset or allocation and a corresponding
validation contract on every host adapter. A direct pointer into storage is not equivalent
under mutation.

Vector growth separately allocates a new handle and copies pages through LOAD/STORE.
Old metadata and handles may still be observable, and the generic protocol has no ownership
transfer or resize operation. Reclaiming or reusing them without an alias proof would change
semantics. The current profile does not distinguish enough of these copies to justify a
bounded ABI rewrite. The rejected bulk-output experiments preserve this boundary and show
that fewer scalar writes alone are insufficient; no native-cost acceptance gain is retained.

A next copy-elimination proposal must identify a specific ownership proof and count the
copies/allocations it removes before timing it. Borrowed views require cross-adapter lifetime
validation; vector resizing requires explicit handle ownership. Neither is a threshold tweak
or grounds to remove validation. Stale managed-writer recovery is an independent protection
correctness task and does not advance the native frontend cost gate.


The next ownership design and required instrumentation are specified in
[native frontend ownership](native-frontend-ownership.md). This is an architectural proposal,
not an implementation or measured native-cost improvement. Recovery-mutex interlocking and
external-cache destination fencing are independent protection changes.
