# Native graph loading integration

`SourceGraphLoader` is the shared storage-independent dependency used by the CLI loading helper
and sealed compilation. `nativeSourceGraphLoader(frontend)` delegates directly to
`linkNativeSource`; it does not create a parser, acquire a frontend or close the caller's frontend.
Native entries and dependencies require `.a0`. Graph traversal, confinement, profile agreement,
duplicate detection and composition remain in the existing shared linker.

The public CLI and sealed toolchain still select their existing readers by default. The standalone
native-fast route, `check --fix`, public editing routes and MCP sessions have not switched. Adoption
still requires compatibility, performance, package and applicable full verification gates. There is
no additional source-mode flag.

An embedding host can borrow a prepared frontend explicitly:

```ts
const load = nativeSourceGraphLoader(frontend);
const dependencies = nativeSourceDependencies(frontend);
const program = await loadCliProgram(entry, load, { root, profile: 'strict' });
const linked = await linkSealed(project, 'main.a0', 'strict', load);
const artifact = await compileSealed(project, 'main.a0', 'wasm', { graphLoader: load });
const plan = await inventory(root, [], dependencies);
```

`loadCliProgram` guards every storage read with the existing filesystem protection policy. Its
default byte adapter decodes UTF-8 fatally and clears the read buffer. The public historical CLI
supplies its existing text adapter explicitly. Virtual and encrypted storage retain their existing
adapters; sealed loading still obtains authenticated compiler source access, uses its fatal decoder,
and clears decrypted buffers. Injecting a frontend does not grant key, disclosure or storage access.

Inventory calls the dependency reader's parse-only operation. It preserves source bytes and hashes;
it does not accept a graph. Native syntax failures are reported as incomplete graphs. Invalid UTF-8,
resource refusals and transport failures abort instead of becoming incomplete-source entries.
Inventory and both sealing re-inventory passes use the same injected reader. The optional
`protectionCli` service argument forwards both ports through planning, migration and the unlocked
session; it is a trusted embedding dependency, not a protocol field.

Frontend operations are serial. Loading and inventory parse units on the borrowed frontend and
invalidate earlier live graph/format inputs. Returned linked programs are detached; retained project
formatting remains the responsibility of `openNativeSourceProject`. Callers must not share one
frontend between concurrent operations.

The error adapter consumes only an existing native renderer result. It never reads source or asks a
TypeScript reader/checker to reconsider acceptance. The CLI JSON diagnostic uses the renderer's
physical local source line, including when the renderer's path-qualified diagnostic deliberately has
a nullable public `line`; all other diagnostic JSON fields are preserved. That native branch never
reloads the file or invokes the historical line locator. Unsupported native rendering remains an
explicit failure. Unlocked-session failures remain code-only, and external AI graph operations remain
blocked before the loader runs.

Future MCP integration must check and compile the edited in-memory program. Reopening its disk entry
through this graph loader would discard edits and is not an acceptable session implementation.

Controls and current verification limits are recorded in
`results/native-source-graph-loading.json`.
