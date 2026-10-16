# Native formatter/revision fixtures

The driver transports raw source and explicit component requests. A0 parses source, loads complete retained grammar, performs ordered verification for checked requests, prints canonical bytes/events and computes revisions. TypeScript constructors are independent test oracles, not compiler/runtime fallbacks.

`probe.a0` links the formatter/revision module with ordered verification. The test selects a fixed implementation closure including all direct APIs, parser/grammar helpers and continuations; no roots depend on input programs. A fresh current verified seed compiles every implementation chunk. Both O0/O2 executables use UBSan/Werror, file-backed `spawnWithInput`, and invocation-local runtime storage. Windows stdin/stdout use binary mode.

`driver.c` is byte-identical to the passed isolated native proof's driver. It includes `arena_runtime.c` so the test can snapshot every preexisting allocation, including unused capacity. Compile that translation unit once; do not also link the runtime C separately. Before each component request it snapshots M/PS and all old capacities, and afterward checks unchanged contents, exact IO identity/content, source, drained replies, FINISH and released storage. Failed formatter output and event views must be empty.

For checked requests the driver runs `arena_verify_begin` and resumes until terminal phase11 or a nonzero failure, then uses `arena_verify_status`. It never treats the M96 checked marker alone as completion. Parser-only formatting/content cases remain unchecked: examples include syntactically valid but semantically mismatched literals and large parameter decimals, including canonical `pInfinity` spelling.

The verification-round watchdog is a test process abort via `die`, not a compiler status, language limit or fallback. Its failure makes the test transport fail. The request fault values explicitly inject invalid schemas/handles/ranges/table entries and runtime replies; they are test controls only. The separate A0 source mutations recorded in the result artifact were development bootstrap controls and were not rebuilt as native compiler variants.

The module requires original valid-UTF8 schema1 M/PS. Raw malformed-byte/unpaired-surrogate decoding, optimized A0BO views, direct DenseOrigin3 composition, public routing and performance equivalence remain outside this package. See `docs/design/arena-format.md` and `results/arena-format-provenance.json`.

The packaged oracle constructors preserve every frozen source, seven-word runtime request and expected byte/hash value. Additional assertion-only event-spelling metadata checks actual schema1 subject IDs on the existing small example. This metadata is not sent to the driver and is excluded explicitly from the static packet-equivalence check. It needs the normal post-integration native test run, rather than being claimed as a new execution of the frozen proof.
