# Staged native edit sessions

`createNativeEditSession(program, frontend, options)` returns the existing `EditSession` with a complete internal language dependency. The caller owns the borrowed frontend and closes it after all sessions, project views, and pending operations are finished. The factory does not change CLI/MCP defaults or select another source dialect.

Source acceptance belongs to the A0 unit parser and whole-program checker. Native function/signature/program formatting and revisions use the existing A0 companion. The spec mutation, numbered mutation, node merge, callee ordering, session handle, rejection, and repair loops remain shared with the existing session. Native failures never invoke the host parser or checker.

Physical reply rows retain their original Unicode/CRLF coordinates through Markdown fence filtering, implied handles, section slicing, copied view numbers, signed specs, and contextual source generation. Parsed-node, example, contract, return, and declaration ownership comes from authentic retained unit tables. Untouched numbered rows restore their authoring metadata and original declarations; generated source has no invented reply location.

The shared synchronous `applyAndPublish`, `openAndPublish`, and `openProgramAndPublish` boundaries include fallible response formatting and output-size checks before publishing session state. Language rejection preserves the normal rejected reply for `fix all`. Publication rejection restores the prior program, handles, counters, and repair context. Diagnostic probes restore that same session state.

This remains a staging seam. Contextual node and spec decoding adds native invocations per payload. Full signatures, return context, formatter output, and mappings consume the existing source and allocation capacities; this does not establish editing capacity equal to the raw source-byte limit or any latency/RSS improvement. The generated-JS backend remains a correctness control, with no default adoption or performance claim.

Executable parse fixes are retained only when every target belongs to a real contiguous reply substring. A multiline replacement under a numbered or signed prefix currently loses exact applicability because replay requires new protocol rows. Native final-check operand-renaming provenance is still being investigated. These limitations must be closed or explicitly reviewed before a public session cutover; the internal factory is not evidence that all authoring routes are migrated.
