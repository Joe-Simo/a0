# Recovered native authoring integration

The optional native frontend retains authoring metadata with checked ownership and exposes
formatting, revision and diagnostic services. A source-bound package loader validates its
component inventory and identities before use, then supports independent engine lifetimes.
These APIs do not activate a new CLI default or establish release qualification.

Native edit sessions, graph loading, MCP and LSP services, migration and protected-storage
adapters share the existing transaction and confinement boundaries. Existing host-syntax
bindings remain supported through the same edit transaction engine. Missing native
capabilities refuse the operation; they do not silently choose a different parser.
Protected writes retain the managed-writer leases, source-revision checks, scoped disclosure
rules and migration coordination. Managed session errors disclose codes rather than source
text or host paths.

The existing A0S formatter and revision input paths are retained as exact passthroughs of
their A0 source, so their compatibility generation commands remain valid without deleting
previously available files. A0 source remains the implementation used for these components.

The optional Wasm/bootstrap and site-build ports consume the same checked native graph.
Their presence does not enable them as the released default. The historical native-cost,
independent AI-study, platform and protection-assurance gates remain open.

The focused controls live in `test/source-native-*.controls.ts`,
`test/source-graph-native.controls.ts`, `test/bootstrap-source.controls.ts` and
`test/native-wasm-bootstrap.controls.ts`. They require explicitly built and source-bound
artifacts. Host compatibility and protection regressions remain in the ordinary test suite.
Research packets, private grading material and rejected optimization experiments are not
part of this integration.
