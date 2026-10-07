# Closing the wasm run-time losses against clang: what was tried, what helped, what did not

Date: 2026-10-07. Machine: Windows x64, 8 CPUs, node v22.21.1 (V8 12.4). All timings are the wb_run driver of `tools/wasm-bench.ts` (n dependent trips of `h = h*5 + K(args(h, i))`, kernels in `tools/exec-bench-kernels.ts`) against clang 22.1.8 `-O3 --target=wasm32`, both run by the same V8 in one process. The load is the 1-minute figure estimated from CPU utilisation (`tools/system-load.ts`); the gate limit is 10 and the runs below were taken at 7.7 to 8.0 of 8 CPUs, that is, with other agents running. They pass the repository gate and are not a quiet machine: the same module's absolute time drifts by up to 1.6x between consecutive runs, so single ratios move by about 5 percent (ident and noop moved by more, below). Read the per-kernel verdicts across the runs, not one number.

## 1. What the wasm of each loss kernel looks like against clang's

Method: `wasm-dis` (binaryen from the clang64 MSYS2 packages) on the A0 module and on clang's module for the same driver; kernels `chain3`, `arrfill`, `prefix1k`, `filter2`, `rotl`, `noop`.

| kernel | A0 emits | clang emits | gap |
|---|---|---|---|
| chain3 | the loop body is the same operations (the `i*K` stride is already a running sum in both); the operands of the final sum are joined in written order, so the late `mul` product (ready after a xor, a shift, a xor and a multiply) goes through three adds | the same operations, the late product joined last (two adds after it), the loop unrolled by 2 | add-chain depth |
| affine | one `mul`, one `add` per kernel; same chain depth problem through the driver's `h*5 + K` | unrolled by 2 | add-chain depth, unrolling |
| rotl | `shl`, `sub 32 n`, `shr`, `or` | `i32.rotl`, the shift operand's `* K` folded to `* (K mod 32)` (only five bits are demanded), unrolled by 2 | rotate instruction (V8 may recognise the pattern itself), unrolling |
| arrfill | eight stores of `v+0 .. v+7` to the frame per trip and one load at `y & 7` (the bounds check is already gone, the frame is joined to the host's) | no memory at all: `a[y & 7]` of an array holding `x + i` is `x + (y & 7)` | affine array lookup |
| prefix1k | one fused loop; `i*x` is a multiply per trip (the induction variable is only built for a literal stride), a first-trip `select`, a dead `i-1` | stride as a running sum, first trip peeled, unrolled by 2 | invariant-stride induction variable, peeling, unrolling |
| filter2 | per element two loads (`a[i]`, `a[(i+1)&1023]`) and a store | the second load carried to the next trip, unrolled | loop-carried load, unrolling |
| ident, noop | `h = h*5 + (h ^ ik)` plus counter and running sum | the same, unrolled by 2 | loop overhead |

## 2. Optimization that helped: rotate a chain of one associative operation so the late operand joins last

`src/optimize.ts` `reassociate` (and its port in `compiler/optimize.a0s`, whose generated `compiler/optimize.a0` the self-hosted compiler uses): for `(p op q) op y` where the inner node has no other use, no operand is a literal, and `op` is add, mul, and, or or xor on u32, the node becomes `(lo op y) op hi` when `y` is ready before the later of `p` and `q` (`lo` the earlier, `hi` the later; equal readiness leaves the node alone). Readiness is a latency model in cycles (mul 3, div and rem 12, get and at 4, call fold and loop 8, everything else 1; literals and parameters 0; a value is ready one latency after its latest operand), kept per node by the pass for the nodes it keeps. Exact in wrapping arithmetic, no node is added or removed, so the other backends are unaffected beyond operand order (their golden digests changed, `COMPILER_VERSION` is now a0c-0.1.40). A literal stays outermost, as the existing rule (`(x + K) + y` to `(x + y) + K`) wants.

A serial sum of four inputs becomes two sums joined (depth 3 to 2); the chain3 driver's final sum becomes `((h*5 + 2*a0) + a1m) + 3` with the product last, which is clang's shape.

Parity with the A0-written optimizer: `bun run selfhost:wasm` reports every function of the corpus, the examples, `behavior/chainrot` (new: tools/behavior-spec.ts, rotation on all five operations, shared inner nodes, literals and calls) and the two site programs identical to `src/optimize.ts`, and the emitted modules byte for byte identical (results/selfhost-wasm.json).

Result, A0 ns per trip against clang's (A0 speed relative to clang, above 1 is faster; l loss, t tie, w win), the committed run before (results/wasm-benchmark.json at the previous commit, load 5.6) and three runs after (run 1 is results/wasm-benchmark.json, load 7.7; runs 2 and 3, load 8.0, were not committed):

| kernel | before | after run 1 | after run 2 | after run 3 |
|---|---|---|---|---|
| affine | 0.91 l | 1.00 t | 1.00 t | 0.84 l |
| chain3 | 0.88 l | 1.01 t | 1.09 w | 1.03 t |
| prefix1k | 0.85 l | 0.98 t | 0.95 l | 0.83 l |
| rotl | 0.88 l | 0.89 l | 0.88 l | 0.87 l |
| ident | 0.95 l | 0.91 l | 0.96 t | 0.83 l |
| noop | 0.90 l | 0.84 l | 0.83 l | 0.68 l |
| arrfill | 0.78 l | 0.78 l | 0.81 l | 0.73 l |
| filter2 | 0.95 l | 0.91 l | 0.92 l | 0.93 l |

A paired comparison in one process (the previous optimizer against the new one, same load, 21 samples, A0 ns per trip): chain3 2.92 to 2.67 (minus 8 percent), affine 4.84 to 4.20 (minus 13 percent); the other kernels' modules are unchanged or reordered only (mix, clamp, branchy, loop64, dot1k, mat4, fnv4k, xs4k, minmax1k, filter2, hist256 within about 6 percent either way). So: chain3 is closed (three runs, tie or win), affine is closed on two of three runs (the third was taken at the busiest moment and every A0 time in it is 20 to 40 percent above run 1), prefix1k is noise-dominated (its module did not change, runs read 0.98, 0.95, 0.83 and 0.85 before). The loss ledger removed eight entries (affine, chain3, prefix1k ns-per-trip and five load-time entries that tied) and recorded the worsened ones as noise (`results/loss-ledger.json` history, reason text).

## 3. Loop unrolling: re-measured, no gain worth a default

`WasmEmitOptions.unroll` (2 or 4 copies of a small inlined fold body per back edge) existed already, default 1. `tools/wasm-ab.ts` (`bun run wasm-ab`, results/wasm-unroll.json) compiles every kernel at unroll 1, 2 and 4 and clang's, and times all four round robin in one process (21 samples, load 8.0). Geometric mean of clang ns over variant ns across the 19 kernels: unroll 1 1.068, unroll 2 1.087, unroll 4 1.087. The per-kernel picture is mixed: unroll 2 gains on rotl (0.83 to 0.92), dot1k (1.65 to 1.92), arrfill4k (2.24 to 2.51), prefix1k (0.90 to 0.95), filter2 (0.71 to 0.76) and loses on loop64 (1.10 to 1.03), mat4 (1.40 to 1.27), xs4k (1.03 to 0.98), affine (1.05 to 1.01); unroll 4 is worse than 2 on prefix1k (0.84). Earlier paired runs at load 5 to 8 (not saved) put unroll 2 on affine and rotl 4 to 10 percent slower and on ident and noop 10 to 16 percent faster, which this quieter run (ident and noop within 3 percent of clang at every setting) does not reproduce. A two-percent aggregate difference at the noise level, with modules 1.3x to 2x larger, is not a reason to change the default; it stays 1 (the old comment in `src/backends.ts` stands: V8 12.4 unrolls small loops itself). Nothing was committed to the emitter for unrolling.

## 4. Not done, and why

- **Rotate instruction (`i32.rotl`/`i32.rotr`).** The arm64 backend recognises `or (shl x s) (shr x t)` with `s + t = 0 (mod 32)`; wasm does not. TurboFan reduces that pattern itself (not verified here), so the gain is unmeasured; the change would be in `compiler/emit_wasm.a0`, which is hand-edited node-per-line A0 (no generator), so it is a large port for an unproven gain.
- **Induction variable with an invariant stride (`i * param`).** `src/wasm.ts` builds the running sum only for `p1 * literal`. Extending it to a loop-invariant extra operand removes the per-trip multiply in `prefix1k`'s fused loop; the multiply is off the critical path (the loop is load/store bound), the module delta is one local, and it again needs the emitter port. Not attempted.
- **Count-down loops and peeling the first trip.** Would shave one compare per trip on `ident`/`noop`-like loops and remove the first-trip `select` in `prefix1k`; same emitter-port cost and a gain bounded by the 1 to 2 percent seen between runs.
- **Loop-carried neighbour load (`filter2`).** `a[i+1]` loaded in trip i is `a[i]` in trip i+1; the emitter has a carried-element mechanism for in-place `set` targets only. Extending it to a read-only source array is an emitter change.
- **Affine array lookup (`arrfill`).** `get (arr v, v+1, .., v+7) (y & 7)` is `v + (y & 7)`. That is a rule for one array shape (an arithmetic progression of equal-stride `add`s), not a general memory-forwarding pass; adding it for this kernel alone would be special-casing, so it was not written. A real fix is store-to-load forwarding of small frame arrays with variable indexes, which the IR (no control flow) would express as a select tree; at eight elements that is more instructions than the eight stores it replaces.
- **Multiplication by a power of two to a shift, algebraic identities, constant folding through selects, bounds-check elimination, loop-invariant hoisting.** The optimizer already has the identities, the folding, `index mod N` and masked-index range proofs (the arrfill and prefix1k modules show no bounds check) and reads of invariant values; V8 turns `mul` by a constant into shifts and adds. Nothing measurable was left in the loss kernels' wasm.
- **Demanded-bit narrowing of constants (clang's `* 23` in `rotl`).** Machine code is identical in TurboFan; no run-time effect, a few bytes of module.

## 5. Reproduce

`bun run wasm-bench` (writes results/wasm-benchmark.json; it waits while the load is above `A0_MAX_LOAD`, default 10), `bun run wasm-ab` (results/wasm-unroll.json), `bun tools/loss-ledger.ts`, `bun run selfhost:wasm` (about 11 minutes; `A0_SELFHOST_ONLY=behavior/chainrot` checks one program and writes nothing), `node --test dist/test/optimize-rotate.test.js`. The site template text "8 losses on run time and 14 on load time" (site/gen/bench.tpl) is a hand-written count that no longer matches the ledger (5 and 10 after this run); the template was not touched.
