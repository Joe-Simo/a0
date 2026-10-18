# Spec diagnostic ownership

The linker resolves spec diagnostics from their structured function name. Public
`spec.function` supplies the owner when present. Contract result and literal shape
errors intentionally omit public `spec` fields; their internal `specOwner` metadata
supplies the same owner without changing diagnostic JSON. Error rewrites preserve
this metadata. Missing owners remain unowned, regardless of message wording.

This corrects a diagnostic prefix bug. Previously, a semantic error beginning
`spec of f:` was usually left without a file prefix. If an unrelated function named
`spec` existed, the same error could point at that function's file and header.
The error now points at `f`'s file and header. Execution errors that name an example
or contract continue to point at its spec line. Parser errors retain their physical
line priority, and ordinary checker errors retain their existing owner policy.

The change affects linked diagnostic prefixes only. It does not change source
acceptance, evaluation, fixes, or the presence of public spec fields. Native renderer
parity must use this corrected ownership policy explicitly; matching the previous
incorrect prefixes would not establish that behavior.
