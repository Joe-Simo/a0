# Strict C verification without private runtime storage

The C verification driver assumed that every strict module declared `a0_trapbuf`. A strict module with no trapping operation correctly omits that private runtime, so the driver could not compile valid programs. The same failure occurred when a supplied module used a different private buffer name. Both Clang C and Clang C++ reproduced the trap-free failure on the preceding checkpoint.

The driver now captures the message passed through the documented `A0_TRAP_EMIT` hook and uses its own static pointer after `longjmp`. It does not require a runtime buffer symbol. The pointer starts at an empty string so trap-free modules also compile under GCC's warnings-as-errors configuration. The initial null-pointer attempt failed that GCC check and remains in the local recovery evidence. No compiler backend or public ABI changes.

The [evidence report](../../results/strict-c-driver.json) records the focused checks, both optimization modes and all three installed C/C++ toolchains. Regressions execute trap-free strict modules, exact bounds and division traps, and successful calls between repeated failures. Renaming the module's private buffer verifies that the driver depends on the hook contract.

All 116 stock module/target output comparisons remain byte-identical across C, JavaScript, direct Wasm and native assembly. The cumulative 29-module totals remain 29789 native executable-section bytes, 170837 JavaScript bytes and 23502 direct-Wasm bytes. These sums include repeated helpers and do not describe one application. The [earlier native report](../../results/native-pressure-size.json) records the native section accounting; the new evidence adds Wasm and exact output controls.

The representative strict-division verification object grows from 5304 to 5624 bytes, with executable sections from 998 to 1030 bytes. This is harness overhead, not product code growth. No new runtime or compilation-speed improvement is claimed. Earlier mixed compilation-cost evidence remains in [the native cost report](../../results/native-pressure-cost.json), and the historical loss ledger is unchanged.

The available aggregate gate is required before this checkpoint is called validated. Full-platform release validation remains outstanding. Publication and private-upload approvals remain pending; neither operation was retried.
