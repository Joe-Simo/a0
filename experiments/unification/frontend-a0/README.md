# A0 frontend research snapshot

This experiment preserves the integrated candidate parser, type checker and resumable
specification verifier written in A0. It is **not the production frontend**. The
production compiler does not import this directory. Recorded timing and memory
regressions block the official syntax cutover; see
[`results/unification-portable-frontend.json`](../../../results/unification-portable-frontend.json).

`frontend.ir-v1.txt` is a frozen, explicitly versioned bootstrap IR text snapshot of
the integrated A0 implementation. The build reads that snapshot with the existing
bootstrap reader; it never detects a user source dialect. The resulting Wasm
artifact reads the candidate syntax. `reference/` is a separate frozen research
control used to test conversion and reconstruct the measurements, with no production
imports. It is not another supported source mode.

The driver only supplies generic arena storage and word-stream I/O. A0 implements
source parsing, typing and specification execution. The host decoder reconstructs
ordinary typed IR, specification objects, comments and compilation facts without
parsing source or validating it again. The Wasm artifact has no imports. The host
module takes a compiled `WebAssembly.Module` and uses standard JavaScript APIs;
the build and verification scripts use Node.

## Rebuild and verify

Install repository dependencies and run `bun run build`. Use Clang and wasm-ld
with matching versions, a wasm32-wasi libc sysroot and the corresponding compiler
builtins archive. The recorded build used Debian LLVM 19.1.7 and signed Debian
WASI packages; their versions and checksums are in the result record. The build
never downloads dependencies or changes the system toolchain.

```sh
node experiments/unification/frontend-a0/build.mjs \
  --out=.a0-tmp/frontend-proof \
  --sysroot=/path/to/wasi/usr \
  --builtins=/path/to/libclang_rt.builtins-wasm32.a
node experiments/unification/frontend-a0/proof.mjs --artifact=.a0-tmp/frontend-proof
node experiments/unification/frontend-a0/spec-proof.mjs --artifact=.a0-tmp/frontend-proof
node experiments/unification/frontend-a0/bench.mjs \
  --artifact=.a0-tmp/frontend-proof --out=.a0-tmp/frontend-bench
```

Use `--clang=PATH` and `--wasm-ld=PATH` when the tools are outside PATH. A private
backend experiment is reproducible with `--aggregate-bytes=256`; the normal build
uses the production 4096-byte aggregate threshold. This changes C calling/storage
conventions, never source grammar. That experimental threshold is not promoted.
Generated artifacts and reports belong outside this frozen directory.

The benchmark validates deterministic conversion to Dense before timing. It uses
frozen flattened application/compiler inputs, rotating fresh processes, a warmup,
measured medians, load recording and identical C output hashes. All arms equally
preload the research modules and compiled Wasm. It excludes graph I/O, the formatter,
model inference, shipping CLI startup and native C compilation. The returned IR and
Wasm instance remain live through C emission. Existing results retain every loss.
Historical seed-built and intermediary callback-build measurements have their own
artifact/source hashes; this script rebuilds the final direct-host transport.

## Remaining integration work

The prototype still needs the authoritative formatter, graph loader, full diagnostic
mapping, editor/MCP integration and complete resource/stack/lifetime audits. Its
stack reservation and default arena budget are experimental implementation settings,
not established production limits. Host type decoding still uses recursive traversal.
The candidate reference is only a test control, including its unfinished aggregate
error mapping and expansion budgeting. The current public reader remains authoritative
until migration, compatibility and performance gates pass.

WASI libc and compiler builtins are external build dependencies with their own
licenses. They are not bundled here. A distribution of the resulting artifact must
carry the applicable third-party notices. First-party source remains Apache-2.0.
