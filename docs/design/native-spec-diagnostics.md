# Optional native spec diagnostics

The optional diagnostic companion has a second private entry,
`arena_verified_diagnostic_options(io,V,M,PS,B,E,IR,options)`. It receives the retained verifier,
parser, spec grammar, spec binder, evaluator and evaluator IR pages. Each page has 128 words.
The frontend ABI remains 3 and the M/PS schema remains 1. The existing
`arena_diagnostic_options(io,M,options)` export remains available with its previous coverage.
Neither entry is a public frontend selection or a syntax mode.

The host copies these pages and invokes the compiled A0 component. It does not interpret a
spec, classify a language error, evaluate an example or construct diagnostic JSON. The C-derived
frontend exposes the copy only when diagnostic ports were explicitly enabled. Direct Wasm and
generated JavaScript use the same generic compiled-source marshaller and allocate the copy
lazily after a failed check. Success still does not load the companion.

The companion verifies the persisted PS directory before reading spec facts. A source-unit
grammar failure leaves the returned PS page empty; the A0 component reads its authoritative PS
from that persisted native directory. A nonempty supplied page must match the directory exactly.
Semantic spec failures always require the supplied page as well. Ordinary faults
use the existing renderer. Spec faults reuse its message preparation, JSON field envelope,
UTF8/UTF16 conversion, quoting and detached location collector. Contract checker faults construct
a read-only synthetic function context from the binder's actual node, operand, type and callee
facts before calling the same checker-message renderer. No checker is run again for rendering.
The producer now records the actual invalid parameter before wrapping A0105, including its
operand index and source span. For source-less structured IR, the existing synthetic zero-line
sentinel and operand cache select the same cached-number renderer already used for short
parameters. This does not require source text, a host classification flag or a second message
implementation.

Runtime values are formatted through the existing A0 literal formatter. The expected literal's
checked shape identifies array versus record; a new literal tree combines that shape with the
actual evaluator values. Shared/repeated literal IDs must not be overwritten: actual children
can differ even when expected children share a literal ID. Trap text uses retained evaluator
frames and evaluator IR, including synthetic pre/post functions. Each spec phase retains the
verifier's existing fresh evaluation budget and error priority.

The common JSON layout preserves absent fields versus null fields. A0714 grammar faults carry
a public line; semantic A0714 faults do not. Generic semantic faults carry `spec.function` and
`spec.ex:null`, while literal-shape and non-bool-result faults retain their existing absence of
that public property. Execution faults retain the verifier's reported line kind and input
presence, including input omission for pre/post A0719 failures. Unsupported options or incomplete
facts return a renderer refusal without partial JSON. Transport failures retain their original
status.

The native spec scanner now records repetition subreasons before returning A0714, keeps a
separator failure from being cleared by a subsequent unchecked append, and scans decimal
repeat counts and lowercase literal words using the same prefix boundary as the reference
scanner, and retains post-repeat closing-delimiter priority. These changes affect rejected
spellings and diagnostic facts; they do not introduce a new accepted syntax.

The public linker's spec ownership correction is a separate change: `spec of f:` must refer to
f even when an unrelated function is named `spec`. Semantic A0714 graph messages point at the
owning function header; example and contract execution faults point at the selected spec line.
The native companion follows that location policy. The complete retained binder/evaluator pages
remain available separately from the selected public diagnostic location.

This private compatibility work does not close existing native grammar acceptance differences.
For example, the native spec reader still accepts some legacy aggregate separators and some
adjacent elements that the current public compact aggregate reader rejects. An unfinished spec
aggregate can still terminate with a native transport/incomplete status instead of A0714. Those
are parser compatibility work, not conditions for a host-side diagnostic fallback. There is no
public cutover or performance claim in this change.
