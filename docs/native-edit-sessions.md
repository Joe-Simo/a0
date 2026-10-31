# Native edit sessions

`createNativeEditSession(program, frontend, options)` supplies the shared `EditSession`
transaction engine with native language services. The caller owns the frontend and closes it
only after its sessions, retained views and pending operations have finished. This optional
embedding API does not change the released defaults.

The A0 unit parser and whole-program checker determine acceptance. Native formatting and
revision services use the same retained state. Spec mutation, numbered mutation, node merge,
callee ordering, handles, rejection and repair continue through the shared transaction engine.
A missing native capability refuses the operation; it does not select another parser.

Physical reply rows retain their Unicode and CRLF coordinates through fence filtering, implied
handles, numbered views and signed specs. Declaration, node, example, contract and return
ownership comes from retained source tables. Generated instructions do not acquire invented
reply locations or executable source fixes.

`applyAndPublish`, `openAndPublish` and `openProgramAndPublish` include response formatting
and output-size checks before publishing session state. A publication failure restores the
program, handles, counters and repair context. Diagnostic probes restore the same state.
MCP operations are ordered within each source session, and filesystem saves retain the
managed plaintext-writer boundary.

Full declarations, formatting and source maps consume the existing source and allocation
budgets. These APIs do not establish equal editing capacity, lower latency or lower memory
use. The independent model study, performance and full-platform qualification remain open.

Executable controls are in `test/source-native-edit-session.controls.ts`,
`test/source-native-node-edit.controls.ts`, `test/source-native-mcp.controls.ts` and
`test/mcp-save-order.test.ts`.
