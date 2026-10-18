# Application maintenance controls

This packet contains four candidate maintenance tasks, not model results or a preregistration:

- Sentinel: select one nearest rectangle boundary at ties; honor the actual tapped control.
- Site generator: recognize escaped conditional delimiters; preserve protected commas while scoping CSS selectors.

The unchanged application and data files are copied from the commit recorded in
[source-manifest.json](source-manifest.json). That manifest also records the complete dependency
graphs, function counts, original file bytes and hashes. Production application files are not edited.
The byte-frozen `source/` snapshots are excluded from Biome formatting; the manifest validator
checks every member before a reader or application driver can use it.
The control declarations, literal fixtures and requests are bound by
[case-manifest.json](case-manifest.json). Reference and wrong replies are whole-function edits to
copies of these applications.

The historical reader imports only the approved source snapshots. Native migration formats each
module with the packaged formatter, checks its source metadata, reloads the complete module graph
with the packaged parser/checker, and checks program equivalence. Submitted native replies use the
existing native EditSession services without a historical reader fallback.

Every source arm uses the existing generated JavaScript backend for application execution. A bounded
Node child runs the complete program. Generator calls run in fixed batches of at most four, with
each call receiving fresh IO and the complete required input files. The site generator's output is then checked with the same
packaged native frontend for all arms, compiled with the same JavaScript backend, and run through its
public page session. The packet checks exact input consumption, output framing, semantic results and
preservation cases. Host transport failures cannot serve as the intended wrong-edit witness.

The Sentinel fixtures distinguish a deliberately positioned persisted state from an ordinary host
warmup/tap sequence. The positioned state keeps seven tentacles approaching a consistent existing
anchor while the selected free tentacle receives the tap. The independent edge oracle selects from
an ordered list of four boundary points. Full unchanged output/state comparisons use inputs where all relevant calls are unaffected;
the body and anchor logic also call the edge helper. Degenerate geometry rows are explicit robustness
fixtures, not geometry the normal browser registry produces.

CSS expected values start with authored selector arrays, not a second parser for the generated CSS.
Both CSS transports include a deterministic 995-byte leading line. The split transport uses two
separate functions and the ranges `[0,995)` and `[995,end)`, so it crosses an actual chunk boundary.
The original transport's final newline and the production page's one-word input consumption remain
part of the preservation checks. The production renderer closes its one remaining root at EOF;
focused fixtures require all elements to be explicitly closed. Focused generated sessions consume
five input words.

The optional packet argument reuses the existing `app-edit-bench.ts` prompt, edit, self-check, retry
and token accounting loops. Without it, the historical 14-task packet and default prompt bytes are
unchanged. This packet has A0 source arms only; it does not invent a TypeScript application baseline.

After building, the explicit control suite runs all three source arms without model calls:

```sh
A0_SOURCE_PACKAGE="$A0_STUDY_PACKAGE" \
A0_SOURCE_PACKAGE_SHA256="$A0_STUDY_PACKAGE_SHA256" \
A0_APPLICATION_CONTROL_REPORT=.a0-tmp/application-controls.json \
node --test dist/test/app-edit-application.controls.js
```

One arm can also be checked through the existing benchmark command:

```sh
A0_SOURCE_PACKAGE="$A0_STUDY_PACKAGE" \
A0_SOURCE_PACKAGE_SHA256="$A0_STUDY_PACKAGE_SHA256" \
bun tools/app-edit-bench.ts self-check .a0-tmp/application-canonical.json a0 \
  --surface=canonical --packet=applications-v1
```

Measurement commands require a clean committed source tree. The report records the package manifest,
service sources, exact prompts, derived reference/wrong replies, application input/output hashes and
fixed runtime limits. Recorded driver durations include process and protocol overhead; they are
correctness-control costs, not a compiler comparison. The packet must pass its complete reference,
starter, wrong-edit and preservation controls before any independent subjects are collected.
