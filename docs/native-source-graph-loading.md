# Native graph loading

`SourceGraphLoader` is the storage-independent dependency used by CLI loading helpers and
sealed compilation. `nativeSourceGraphLoader(frontend)` delegates to `linkNativeSource`;
it does not create or close the caller's frontend. Native entries and dependencies require
migrated `.a0` source. The shared linker retains confinement, profile agreement, duplicate
checks and graph composition.

An embedding host can supply the services explicitly:

```ts
const load = nativeSourceGraphLoader(frontend);
const dependencies = nativeSourceDependencies(frontend);
const program = await loadCliProgram(entry, load, { root, profile: 'strict' });
const linked = await linkSealed(project, 'main.a0', 'strict', load);
const artifact = await compileSealed(project, 'main.a0', 'wasm', { graphLoader: load });
const plan = await inventory(root, [], dependencies);
```

CLI reads retain the filesystem protection policy. The byte adapter decodes UTF-8 fatally
and clears its read buffer. Sealed loading retains authenticated source access, session and
source-revision checks. Supplying a frontend grants no key, disclosure or storage authority.

Inventory uses the dependency reader's parse-only operation. Syntax errors are recorded as
incomplete graphs; invalid UTF-8, resource refusals and transport failures abort the operation.
The same reader is used for sealing re-inventory. The protected CLI's optional service argument
is a trusted embedding dependency, not a protocol field. Existing managed-writer and migration
coordination remain required.

Serialize operations on a borrowed frontend. Unit parsing can invalidate live graph or format
inputs. Returned programs are detached; retained project formatting uses
`openNativeSourceProject`. MCP sessions check their edited in-memory program rather than
reopening disk source and losing edits.

The diagnostic adapter consumes an existing renderer result without reparsing source.
Unlocked-session failures disclose codes only. External AI graph operations remain blocked
before loading. Defaults and release qualification are unchanged.

Controls are in `test/source-graph-native.controls.ts`,
`test/source-native-project.controls.ts` and `test/source-native-migrate.controls.ts`.
