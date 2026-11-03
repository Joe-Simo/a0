# Candidate language coverage

Run `node dist/tools/source-coverage.js` after `bun run build`. The report is written
through the normal result scrubber to `results/source-language-coverage.json`.
The same audit is a regression test; mismatched parsing, metadata, checked IR,
revision, diagnostic ID or C/JavaScript output fails the run.

The audit does not add a grammar, switch a default, translate failures through a
fallback, or alter the compiler. Legacy inputs are converted with the candidate
formatter; already-candidate inputs are read as written. Both use the same native
candidate frontend. Source encryption and recovery behavior is unchanged.

## What is checked

| Inputs | Checks |
| --- | --- |
| Every accepted source/dependency graph listed by the repository corpus tool | Imports, comments, complete checked IR and C/JavaScript output equal the reference |
| Accepted static program literals in test files, including nested fixtures | Original metadata, checked IR, per-function revisions and C/JavaScript output equal the reference |
| Named existing pure fixture generators | Complete assembled programs preserve checked IR, revisions and C/JavaScript output |
| Parseable repository reject cases converted to candidate spelling | Rejection and first diagnostic ID equal the reference |
| Raw repository syntax rejects | Host and native candidate readers reject with matching first diagnostic IDs; cases are listed individually |
| Observed capability inventory | All current operations; scalar `u32`, `bool`, `io`, arrays and records; imports, text, both profiles, examples, preconditions and postconditions |

The ordinary source corpus alone omits checked operations, strict-profile units
and executable specifications. The additional real test programs close those
specific coverage holes. The report separates source graphs, legacy literals and
raw candidate literals; overlapping programs are not a unique-program total.
Feature counters count observations, including repeated dependency occurrences.
The recursive static scan includes 138 accepted legacy-spelling observations and
142 accepted candidate-spelling observations owned by nested files. Identical literal
text is deduplicated across files, and a program accepted by both readers contributes
to both columns; these counts are not a unique-program total.

The recorded run covers 185 dependency graphs, 639 legacy test literals converted
to candidate spelling and 774 raw candidate literals, with zero mismatches. All
36 operations and the five type forms occur. The 19 parseable repository rejects
retain their diagnostic IDs. Another 19 syntax rejects are checked as raw candidate
inputs against the host candidate reader, with matching first diagnostic IDs. See [the exact inventory](../results/source-language-coverage.json).

The named generated set adds 17 assembled programs: six record-ownership variants,
four returned-extra variants, the shared checked-operation and native-port programs,
a snapshot case, repeated aliases, and three parallel trip-count forms. These are
separate observations and can overlap static programs; they are not added to a
unique-program total. The exact names are recorded in `generatedPrograms` in the report.

No unsupported language construct or semantic mismatch was confirmed in this
audited set. That is a bounded result, not proof that every possible program works.

## Remaining acceptance work

- Arbitrary dynamically generated/interpolated test programs are not extracted.
  Only the named pure generators above run explicitly; further generators need
  independent reference checks rather than treating this set as exhaustive.
- Raw syntax-reject IDs are covered. Complete diagnostic locations, suggestions,
  fixes and executable repairs still need dedicated negative fixtures beyond the
  diagnostic tests already present.
- External projects, all capacity boundaries and their combinations remain outside
  this corpus. Existing resource-limit tests are separate evidence.
- C/JavaScript output identity does not replace real target execution. Required
  platform checks, native frontend cost and independent AI accuracy/cost acceptance
  remain outstanding. Public defaults must not change on the strength of this audit.

The historical native frontend cost ratios and rejected optimization experiments
remain as recorded in [UNIFIED-STATUS.md](UNIFIED-STATUS.md). This work makes no new
runtime, compilation-speed, memory or universal-superiority claim.

## Bounded generated diagnostic audit

The follow-up audit uses a recorded xorshift seed and 584 bounded cases combining
generated scalar programs with parameter/node limits, identifier lengths, aggregate
widths, trip counts, source-byte limits and specification counts. Its raw generator,
cases and minimized failures are preserved with the local validation archive.

It reproduced an A0001 diagnostic defect: rejection was correct, but oversized pure
boolean arrays reported the u32 limit instead of their dimension-specific limit.
The parser now retains the computed limit only on that failure path; the renderer
uses it without reparsing. Regressions cover scalar, nested-array, record-width and
I/O cases, including exact JSON and source locations. See
[the results](../results/source-generated-diagnostics.json).

The corrected audit has 580 exact matches and four explicit existing renderer
refusals for specification diagnostics A0714/A0715. Those refusals remain a concrete
gap, not passes. This finite audit does not establish universal language coverage or
remove the native-cost, independent AI or full-platform acceptance gates.

## Specification diagnostic follow-up

The follow-up to the generated audit resolves its four A0714/A0715 renderer
refusals: the maximum example count and completed primitive example-result
mismatches. All 584 bounded cases now match the reference diagnostic JSON.
The verifier retains failure context; the native renderer uses original example
spans and declared types, including dependency locations and Unicode prefixes.
It does not call the reference parser as a fallback.

The completed A0715 aggregate-mismatch follow-up adds arrays, records, nested values,
single-field records and page-boundary values, using retained native evaluator data.
Malformed kinds, booleans, shapes, handles and field ranges fail closed; the iterative
walk has a fixed work bound. Runtime traps and other specification failures remain
explicit unsupported cases. The focused controls check these refusals and detached
failure snapshots. See `results/source-spec-aggregate-diagnostics.json`. See [the scoped evidence](../results/source-spec-diagnostics.json).
The warm parse-unit timing guard is mixed and does not establish a speedup or
satisfy the full native frontend cost gate. Public defaults remain unchanged.

## Current compiled diagnostic qualification

The fresh compiled-frontend qualification checks 66 source cases on each of the
C-derived, direct-Wasm and JavaScript paths. Its 15 test groups passed without skips,
including runtime traps, complete JSON, dependency ownership, source-less IR,
provenance refusals and executable repairs. Handwritten source fixtures remain
independent expectations; the harness now compares them with the current public
source-diagnostic adapter instead of requiring an obsolete spelling difference.
See [the exact results and artifact hashes](../results/source-compiled-diagnostics-20261102.json).

This supersedes the older runtime-trap refusal limitation above for these tested
compiled artifacts. It does not establish exhaustive language coverage, native-cost
acceptance, independent AI accuracy, physical-platform qualification or a public
default cutover. The earlier failed harness result is retained in the report.

## Lossless source transport

The host source reader now shares the native reader's refusal of unpaired UTF-16
surrogates. Previously a host-accepted comment or text literal could change during
UTF-8 encoding. The same check now protects standalone text construction, candidate
source formatting and raw patch/session replies. A rejected reply preserves its
revision and open handles, so the next valid reply can still succeed.

Valid Unicode scalars, including astral pairs, BOMs and the replacement character,
remain accepted with identical text bytes and IR in the focused controls. The
baseline failures, corrected tests and bounded host parse/format cost samples are
recorded in [`results/source-unicode-guard.json`](../results/source-unicode-guard.json).
The cost samples use standalone units without following imports; they do not clear
the native frontend cost, full-platform, AI or public cutover gates.

Initialization now decodes existing source, instructions, settings and manifests
without replacing malformed UTF-8. Invalid input leaves original file bytes intact
and produces no generated project files. Conflict and rollback checks compare exact
bytes, so an intervening malformed-byte edit is preserved instead of mistaken for
an unchanged replacement character. Synthetic regression and write-failure evidence
is recorded in [`results/source-init-utf8.json`](../results/source-init-utf8.json).
This does not eliminate arbitrary external writes between a check and a write, or
replace the existing lock and protection requirements.
