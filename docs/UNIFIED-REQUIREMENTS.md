# One A0 language and independent optional protection

This is the current implementation contract and gap list for the owner's unified-language and protection requirements. It supersedes recommendations to ship another optional authoring dialect. It does not declare the unfinished candidate production-ready or erase historical measurements.

## Language contract

A0 is to have one universal public source grammar, one specification, one default formatter and one authoring/editing protocol across CLI, AI integrations, editors and target backends. Canonical versus strict are execution-semantic profiles; both must remain expressible in that one grammar. Historical source forms remain import/migration compatibility, not competing recommended workflows. Lossless byte transports, compiled IR and bootstrap snapshots may have explicitly versioned internal encodings; they must not require users or agents to learn another language.

Current implementation does not meet this contract. `src/link.ts` routes `.a0` to the original parser and `.a0d` or a flag to `parseDense`. `src/cli-main.ts` offers both conversion directions and a migration command whose output is Dense. `src/mcp.ts` defaults to Dense views but permits canonical replies. `src/lsp.ts` formats according to the old file form. Dense omits bindings/returns and permits nested prefix expressions; it is a second public syntax, not merely compression of the same bytes.

The candidate `src/source.ts` has flat explicit bindings with compact parameters/types/literals. `src/source-link.ts` and `migrateSourceProject` already preserve parsed IR through linking and stage a new destination without rewriting originals. They are candidate infrastructure, not the public parser. The internal candidate-bound CLI now routes legacy project imports through that shared engine; the shipped CLI default remains unchanged. See `results/cli-source-migration.json` for fresh six-project hash and output checks. `compiler/*.a0s` generator inputs and versioned research IR snapshots are internal build formats, not a proposed new public mode.

Current component completion and exact remaining gates are reconciled in [UNIFIED-STATUS.md](UNIFIED-STATUS.md). Historical result files keep their original scope.

### Cutover acceptance

- Publish one authoritative grammar and capability table: types, all operations, imports, comments, executable specifications, semantic profiles, resource limits and diagnostic locations. No silent loss of capability or profile meaning.
- Parse, validate, print and reparse every accepted repository source and dependency graph. Preserve semantic revisions, executable contracts, comments and import identity; test rejected and malformed inputs and first-failure locations. Compare independent interpreter, generated outputs and target execution.
- Migrate into a new directory with collision checks, hashes, a manifest, stale-input detection and rollback/recovery. Preserve original source and history. Compatibility readers are explicitly labelled migration-only after cutover.
- Move CLI, native frontend, formatter, MCP views/replies, LSP, guides, examples, source inventory, protected-source sessions and cache identity together. No hidden format flag is needed for ordinary authoring. Do not add another opt-in public dialect as the end state.
- Measure unchanged workloads on the same host: tokenized source, complete requests/replies and repairs; accepted-edit accuracy; cold/warm check/build, memory, generated size and execution. Preserve losses and uncertainty. Source token count alone is not total cost.
- Repeat independent AI accuracy/cost studies using corrected guides. Historical matched results are bounded evidence, not universal proof. New model calls remain unavailable under the current no-paid-API constraints; mark that gate pending.
- Complete the native frontend and available aggregate checks before promotion. Full-platform release checks remain mandatory. Existing native candidate compilation-time and memory losses in `results/unification-portable-frontend.json` must be addressed, not relabelled.

## Protection contract

Source storage and distributed-application protection are separate, optional per-project controls, independent of Git, IDE, terminal or AI provider. A0 stays open source. Existing authorized plaintext access is necessary to edit, compile or use an AI service; ciphertext cannot be usefully processed without keys and a plaintext boundary somewhere. No universal recovery key or promise of unbreakable reverse-engineering resistance is permitted.

The existing experimental source store uses pinned JOSE/WebCrypto, authenticated encryption, owner signatures, recipient grants and encrypted recovery identities. It includes offline sessions, sharing, rotation, import/export and staged on/off migration. This is implemented code, not a proposed cipher. The portable crypto/store interfaces do not prove every host adapter works: filesystem durability on Windows, browser/mobile hosts and other platforms remain outstanding.

Current distributed protection is direct-Wasm debug/source-section hygiene only. Other target adapters fail closed when protection is requested. That is not application encryption or demonstrated algorithm secrecy. Review and implement target-appropriate packaging independently; do not ship project keys or decryptable secrets inside applications.

### Threat model and security acceptance

Use `docs/PROTECTION.md` as the detailed current threat model. Assets include source, metadata, caches, logs, keys, recovery material and private build/debug data. Boundaries are encrypted storage versus an unlocked process, owner versus recipient authority, local consumers versus external AI disclosure, and build host versus distributed artifact. Attackers may copy, alter, delete or replay storage and know all source code. Authorized malicious collaborators and a compromised unlocked host remain outside storage confidentiality guarantees.

- Authentication, wrong-key, tampering, corrupt-cache and unauthorized-disclosure failures must fail closed. Exact trusted-project identity is required for recipients. Test rotation, revocation, recovery, old-copy limitations and concurrent edits.
- Coordinate sealing with every managed writer and custom cache destination across processes. A check made before an asynchronous operation is not a lock. `results/protection-transition-race.json` records a confirmed late-plaintext-cache failure; this remains a production blocker until reproduced and closed.
- Account for plaintext in memory, temporary files, crash recovery, backups and external tools. No secure-erasure or transparent-application claims beyond demonstrated scope.
- Owner identity replacement and trusted anti-rollback state require explicit designs and tests. Key loss without a recovery identity remains unrecoverable. Never generate or configure real user keys as part of this audit.
- Test OFF, source-only, build-only and combined modes on identical workloads, including sealing/unlocking/rotation separately. Existing `results/protection-benchmark-checkpoint.json` misses initial overhead budgets; those are targets, not achieved guarantees. Keep source and AI-visible token identity separate from provider billing/cache claims.
- Require independent crypto/security review and measured reconstruction studies before confidentiality/resistance promotion. Actual platforms and weak-device costs remain pending; simulation, emitted text and a mode flag do not satisfy them.

## Ordered implementation work

1. Preserve current validated compiler checkpoints and finish their active tests.
2. Reproduce and close the managed-writer transition race with deterministic interleavings, including external cache locations. Extend the same coordination to editor/source/artifact writers and crash recovery; do not claim complete closure from a cache-only guard.
3. Finish the one-grammar compatibility/migration and frontend cost work, then converge public entry points together. Existing passing migration tests are a starting point, not permission for a destructive cutover.
4. Add remaining protection host/release adapters and run the accepted cost/security/platform matrix. No paid services, publication, real-key creation or denied retries are authorized by this plan.

Source sealing, application protection and language unification each have independent acceptance gates. Progress in one does not waive another.
