# Candidate source frontend artifact

This import-free Wasm module is built from `compiler/source_frontend.a0` and the generic arena
transport. It is an integration fixture for the unfinished single-syntax refactor. The public
compiler still uses its existing frontend; this artifact is not a second source-language mode.

`build.json` records the source dependency closure, generated C, transport, compiler build inputs,
required Wasm features and binary hashes. Tests check freshness and execute the actual artifact,
including dependency composition and delayed type/specification checks. A stale artifact fails;
there is no TypeScript parser or checker fallback in this frontend.

Regenerate after changing its A0 closure, native transport or builder. Build in scratch, run the
source and graph audits, then copy only `frontend.wasm` and `build.json` here:

```sh
bun run build
node dist/tools/source-native-build.js --out=.a0-tmp/source-frontend-build \
  --sysroot=/path/to/wasi/usr --builtins=/path/to/libclang_rt.builtins-wasm32.a
cp .a0-tmp/source-frontend-build/frontend.wasm seed/source-frontend/
cp .a0-tmp/source-frontend-build/build.json seed/source-frontend/
node --test dist/test/source-native-graph.test.js dist/test/wasm-words.test.js
```

The default artifact omits linker debug sections and names. Build with `--symbols=keep` when
those are needed for debugging; exported entry points and executable sections are retained.

The artifact builder also accepts `--opt-level=O2|O3|Os|Oz` for controlled build experiments.
The default is `O3`; a smaller research build has not passed the frontend performance gate.

The build uses the public TypeScript C backend, Clang and WASI libc; this is not a claim of a fully
A0-bootstrapped frontend build. The independent C bootstrap in the parent directory is unchanged.
Performance, graph diagnostics and public tooling cutover remain separate acceptance gates.

The bundled third-party components are WASI libc and LLVM compiler builtins. Their notices are in
`notices/`; the Apache 2.0 license text referenced by those notices is in the repository `LICENSE`.
The recorded dependency archive hashes identify the exact linked inputs. If rebuilding with other
library releases, update their notices too. These notices do not change third-party licenses.
