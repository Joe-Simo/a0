# Canonical POSIX linked verifier v1

This experimental A0 composition chooses OS filesystem requests, parses each complete source before visiting its uses, preserves dependency/profile/duplicate policy and exact stripping, parses the combined source, then checks and verifies specs in function order. The host provides only OS calls and generic arena storage. It neither accepts deferred specs nor chooses a source graph. No CLI route or fallback is changed.

## Public API

Call `fs_hello(io)` once on a fresh optional FS v1 session, then upload entry/root path bytes as ordinary generic arena storage.

```
arena_link_verify_begin(io, entryH, entryBytes, rootH, rootBytes,
                        explicitRoot, profileOverride, dense, graphWork)
    -> R
arena_link_verify_resume(R, schedulingQuantumU32) -> R
arena_link_verify_done(service128) -> bool
arena_link_verify_status(service128) -> u32

R = (service128, Q, linkState128)
Q = (V128, checkedM128, grammarP128, binderB128, aeMachine128, aeIR128, io)
```

Arguments retain the frozen linker convention: profileOverride0 means absent,1 means canonical,2 means strict. File declarations must agree before an override is applied. `dense` and malformed UTF8 remain explicit terminal7. graphWork is an explicit continuation/work budget of the existing graph component; it is not a hidden source/table acceptance ceiling.

The service owns all stage decisions. Resume while `done` is false; zero quantum preserves a pending continuation. `status` reports7 while pending and returns the retained failure/status0 after completion. Terminal unsupported7 is distinguished by `done==true` and never resumed as unfinished verification. A nonzero link result constructs terminal Q directly; it must not call `arena_verify_begin` on a prior file's complete-spec parser7 snapshot. Success requires service0==0,service1==1,service18==1 and completed verifier V1==11. Only then pass Q1 and the retained successful L to `arena_backend_context_linked`.

## Complete grammar and LS2

`lv_parse_ready(io,M)` returns `(status,complete,io)`. Ordinary parser0 passes without additional IO. Parser7 is accepted as completed grammar only if its persisted128-word grammar directory is present, parser schema93==1, grammar92==1 and grammar0==0. The actual parser M0 remains7 until the ordered verifier takes it. Generic directory access failures remain1..5; incomplete grammar remains7. This is the same complete-grammar predicate as the existing ordered verifier, implemented in A0 rather than a host acceptance override.

Only `lk_parsefile` and `lc_reparse` change in the existing loader/composition. The first treats completed per-file grammar as successful parsing, so source syntax/spec grammar still precedes following uses. The second applies profile selection and origin collection to completed combined grammar as well. Dependency traversal still finishes before file-profile agreement, cross-file duplicate selection, combined source bound and combined parsing. Type checking/example execution runs only after that complete parse. Valid examples are never evaluated during DFS. All raw spec bytes and grammar sidecars remain intact.

Parser/checker schema1 and every existing LS2 directory retain their layout. Two reserved LS2 words become additive facts:121=combined grammar completed,122=combined parse deferred spec verification (M0==7). Existing120 remains combined parse invoked. A successful link/parse now permits M0==7 only with those complete-grammar facts; link status0 alone is not spec completion. The separate verifier completion marker is authoritative. Source parser function `sourceIndex` stays unchanged; actual files/origins come from LS2.

## Service128

All IDs, counts and byte spans are full u32. UINT_MAX means absent where stated. All V headers are `(handle,lengthWords,capacityWords)`.

| Words | Meaning |
| --- | --- |
|0|Final selected status,0 before a pending failure; query status helper for pending7|
|1|Terminal1, pending0|
|2,3|A0LV magic0x41304c56,version1|
|4|Selected diagnostic stage1link,2ordinary body check,3spec binding/type,4spec execution;0none/resource without a language diagnostic|
|5|Selected numeric diagnostic ID;0none|
|6|Original function index,MAX absent|
|7|Original checker global node index,MAX absent; checker return pseudo-index is preserved|
|8|Original checker argument index,MAX absent|
|9|Original combined parser line-table index,MAX absent|
|10,11|Selected byte start/length; combined coordinates for mode2, original per-file coordinates for mode1|
|12,13|Legacy source-directory file ID and local line;MAX/no line when absent|
|14,15|First projected fragment's original file ID/start;MAX file when absent/synthetic|
|16|Selected diagnostic fragment count|
|17|Combined grammar-complete fact copied from L121|
|18|Successful ordered verification1, otherwise0|
|19|Location mode1direct original file/link facts,2combined projection,0none|
|20,21|Selected original path handle/byte length,0/0 absent|
|22,23|Selected original source handle/byte length,0/0 absent|
|24|Original link status|
|25|Original verifier public terminal status|
|26|Selected combined one-based source line, or per-file line in direct mode|
|27|Retained verifier phase|
|28|Metadata projection transport/resource failure;0none|
|29|Original selected terminal status before a metadata IO failure|
|32..34|Diagnostic projected-fragment V4|
|35,36|First fragment index and count for the selected span|
|37|Whether the selected span crosses multiple projected fragments|

A fragment is `[relativeToSelectedSpanStart,length,fileID,originalByteStart]`. Synthetic fileID MAX never triggers a source read. Original byte spans are projected by A0 against LS2 copied segments; the host does not rescan or choose source associations. All existing function/node/operand/raw-spec/line/use refs remain in LS2. The selected original path/source views are borrowed invocation-local handles and remain valid until FINISH.

For spec execution, selected source association uses retained verifier ex/pre/post line indexes, including A0719 fuel's required example line. For spec binding it uses binder source facts, falling back to the current function header only when no line exists. Ordinary checker facts retain its exact selected span. Direct per-file parse errors retain their original file and span before combined parsing. A metadata transport/resource failure replaces public status with that generic failure and retains the original selected status in29; it is not relabelled as a failed example.

The legacy file/local line columns use the existing combined source-line directory, which can differ from original byte-derived lines after exact regex stripping. They do not claim parity with every message-derived `src/link.ts` semantic-error heuristic. Accurate original spans and these legacy directory facts are kept separately. Complete public diagnostic text, fixes, edits, JSON and Node OS-exception formatting remain a renderer milestone. No dense, Windows or malformed UTF8 normalization support is claimed.
