# Native application edit research arm

`tools/app-edit-bench.ts --surface=native` is a benchmark arm. It does not add a compiler
language mode or change the default benchmark, CLI, or MCP language services. The original
Canonical and Dense arms remain historical controls. The sealed task file, starter hashes,
instructions, hidden tests, and reference/wrong edits are unchanged.

The native arm loads `A0_SOURCE_PACKAGE` with the independently supplied
`A0_SOURCE_PACKAGE_SHA256`. The package loader verifies the manifest and all component bytes.
The manifest retains the frontend, formatter, and diagnostic source/build digests. This proves
package identity; it does not claim the package was built from the benchmark checkout. A frozen
package can be used for runtime controls. A final measurement cohort must use the package and
host services fixed by its own preregistration.

The historical reader imports the sealed Canonical starter once. The authoritative A0 formatter
migrates that IR to source, and the native parser/checker accepts the result. Native content
revisions must agree across migration, including declared signatures, specs and profile. A
separate authoring snapshot preserves comments and text metadata. The migrated starter is saved
beside native command output as `OUT.starter.a0` and its hash is recorded.

Only control preparation applies the sealed reference/wrong replies through the historical edit
engine. Their changed functions are rendered by the native formatter with complete signatures.
Submitted replies never use this conversion. They enter `createNativeEditSession` as raw text,
including fences, Unicode and line endings; native parsing, whole-program checking, formatting,
diagnostics and revisions serve the existing shared editing kernels. The application interpreter
then executes the unchanged hidden tests against the accepted typed IR. There is no historical
parser/checker retry on native refusal.

The existing prompt, judge, self-check and scoring loops serve every arm. Before native prompt
export or scoring, the sealed controls must prove that each reference passes, each starter fails,
and each wrong reply applies but fails the hidden tests. Each scored attempt creates a fresh
session from the original view, preserving the existing rollback/one-repair protocol.

Commands execute Bun source from a clean commit. Prompt manifests bind the clean commit/tree,
task seal, original and migrated starters, native package, complete host source inventory, guide,
each system/user message, and prompt map. The checkout identity is checked again before output.
The native guide is `experiments/primers/MODEL_GUIDE.native.txt`; it is separate from historical
primers. The grammar control exercises its header, flat operands, aggregate, shift, fold, loop and
explicit-call spellings through the actual package.

`--guide=PATH` explicitly selects a study guide for any arm. The exact selected guide path/hash
is recorded by self-check, dump and scoring; default historical primers and prompt bytes are
unchanged. A study must freeze its guide before subjects see prompts.

```
A0_SOURCE_PACKAGE=PATH A0_SOURCE_PACKAGE_SHA256=SHA \
  bun tools/app-edit-bench.ts self-check .a0-tmp/native-check.json a0 --surface=native
A0_SOURCE_PACKAGE=PATH A0_SOURCE_PACKAGE_SHA256=SHA \
  bun tools/app-edit-bench.ts dump .a0-tmp/native-prompts.json a0 --surface=native
```

Both `o200k_base` and `cl100k_base` count the visible contents of every message on every call.
A repair call includes the original system/request/view, the failed assistant reply and the
rejection. Output includes failed and accepted replies. `conversationTokensLocal` is the full
visible conversation cost; the older segment buckets remain for report readers. Provider framing,
input/output/cache/reasoning usage are unknown (`providerUsage: null`), never assumed free or
equal to local tokenizer counts. These are tokenizer estimates, not provider billing records.

The adapter inherits native arena/source/output capacities and the session's per-payload parser
activation costs. It establishes no latency, RSS, compilation, execution, binary-size or AI-success
improvement. No model subjects are launched by the harness or its controls. Independent subject
trials, new independent tasks, an exact artifact cohort and their preregistration remain separate
work before any adoption decision.

The [runtime control report](../../results/native-app-edit-arm.json) retains the regenerated prompt
manifest, migrated starter, exact default-prompt comparison, raw reply boundary controls and the
native singleton type/value probe. Its package is a pinned runtime control artifact, not a fresh
combined study build. The record makes no AI success or performance claim.
