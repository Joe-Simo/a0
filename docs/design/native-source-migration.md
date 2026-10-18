# Native historical project import

`migrateNativeSourceProject(entry, destination, frontend, root?, legacyDense?)` converts a
historical dependency closure into flat `.a0` files. The injected frontend must provide the
optional A0 formatter. Its parser and checker are the same A0 implementation used for ordinary
native source processing. The caller owns and closes the frontend.

Historical input uses the existing explicit import reader: `.a0d` identifies historical Dense,
and `legacyDense` selects Dense input stored with `.a0` names. The output uses flat `.a0` throughout.
The public CLI migration route still uses its historical target until the integrated cutover.

The converter reuses the guarded staging engine in `src/migrate.ts`. It snapshots the original
UTF8 files, confines imports to the physical source root, resolves symlink identities and rejects
destination collisions. It preserves each source unit and rebases imports to the converted paths.

Each rewritten unit is uploaded as structured IR through `activateProgramForFormat` and printed
by A0. This capability carries unchecked IR for formatting; it grants no typed program. The A0
unit parser then reads the output, and the staging engine compares its source metadata and checks
the A0 formatter fixed point. Imported bool and aggregate results retain the signatures already
resolved by the historical dependency reader.

After staging, `linkNativeSource` reads the complete converted dependency graph and checks it
through A0. The staging engine compares the resulting semantic program and revision with the
original. The ordinary ephemeral linker releases private unit retention; conversion needs no
persistent project session. Missing capabilities, unrepresentable metadata, parse failures and
native resource refusals abort publication.

Publication uses the existing destination reservation and directory rename. Original source
bytes are checked again before the manifest and staged directory are published. A concurrent
source edit aborts conversion. Existing output is preserved, and failures clean up owned staging
and an empty reservation. Process interruption and power-loss limits are those of the existing
staging engine.

`test/source-native-migrate.controls.ts` requires explicit current frontend and formatter
artifacts through `A0_MIGRATE_FRONTEND` and `A0_MIGRATE_FORMAT`. It covers historical spellings,
transitive inferred result types, every registered backend's emitted output, concurrent imports
sharing a frontend, metadata/fixed-point guards, UTF8/confinement, native allocation refusal and
concurrent source edits. These controls establish conversion behavior; compiler performance,
Windows directory publication and the public syntax cutover still require their applicable gates.

The [frozen migration record](../../results/native-source-migration.json) binds the passing
controls to their code, frontend and formatter artifacts. Eight real dependency closures also
converted with matching semantic revisions and byte-identical JavaScript, C and Wasm emission.
The archive retains their manifests, converted files, output hashes and reproduction script.
These are correctness checks; their busy-host durations provide no performance result.
