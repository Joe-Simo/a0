# Native source project ownership

`linkNativeSource(entry, read, frontend, options)` returns the existing linked program/text/source data plus a `.native` project session. Dependency ordering, path confinement and symlink policy, injected reading, source limits, profile agreement/override and duplicate-function diagnostics still run through `linkProject`. Source grammar, type checking and specs run through the supplied A0 frontend. No host source parser, printer or validator is a fallback.

The session retains the authentic parsed units privately. Its `files` list contains immutable, project-owned identities with the resolved file paths. These identities expose no Program, parser state or checked-acceptance flag. Copying an identity or taking one from another project cannot select a file, even when both projects use the same frontend and path. Public linked data and optional migration units are host snapshots; changing them cannot alter the retained native inputs.

- `project.graph` is the authentic initial successful graph result. It can be passed to the existing frontend's `format` and `revision` methods while it is current.
- `project.activateFileForFormat(file, budget?)` explicitly restores that authentic source unit through the existing activation API. It returns an opaque formatting input, never a checked graph or typed acceptance. Use the same frontend's `format(active.input)` or content/function revision methods. Original imports, profile declarations, comments and parsed spec ownership remain local to the file; the existing formatter determines canonical spelling and whitespace. A graph profile override does not rewrite the file's declaration.
- `project.checkGraph(budget?)` checks all the retained units again in dependency order with the captured coherent graph profile. It neither reads files nor parses source again. Success returns a new authentic checked result for whole-graph formatting, revisions and compilation. Failure retains the existing `NativeSourceError` facts and owning-file origin mapping; it publishes no partial project or typed success.
- `project.close()` releases the retained parsed units and their handle authority. It is idempotent. The injected frontend remains caller-owned, so another project can continue to use it. An already returned current frontend input remains valid until that frontend resets or closes; detached bytes, mappings and host data remain caller-owned.

Activation and graph rechecking reset the shared frontend. Earlier graph/activation formatting inputs become stale, including inputs from another project sharing that frontend. Missing formatting capability returns the existing explicit refusal. Foreign/copy file handles and invalid budgets fail before reset. A real resource failure can reset the live arena; a later successful check or activation recovers from the retained inputs. Closing the frontend makes every project's subsequent native operation fail. The project session performs no implicit activation, background read or retry.

```ts
const linked = await linkNativeSource(entry, read, frontend, options);
const project = linked.native;
const file = project.files.find((file) => file.path === selectedPath);
if (file) {
  const active = project.activateFileForFormat(file);
  if (active.ok) frontend.format(active.input, { mapping: true });
}
const checked = project.checkGraph();
frontend.format(checked);
frontend.revision(checked, { kind: 'program' });
project.close();
frontend.close();
```

This is a private candidate API for the later CLI/LSP cutover. Public source readers and command modes have not changed. Keeping a project alive intentionally retains its parsed-unit snapshots and original source text; no compilation, memory or latency improvement is claimed. The explicit C frontend controls in `test/source-native-project.controls.ts` compare file/graph output and revisions with the independent reference, include the compiler's real module graph, and exercise profile, import, mutation, budget and lifetime boundaries.
