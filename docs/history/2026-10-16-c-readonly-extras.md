# Borrowing aggregate extras in C iteration callbacks

Compiler `a0c-0.1.58` passes aggregate extras to internal owned-state and predicate callbacks
through const pointers. Previously, an array or record within the public by-value size limit
was copied at each callback invocation, even when the body only read it. Public C functions
retain their existing size-dependent ABI. Scalar extras and ordinary calls retain their
existing calling conventions.

Borrowed parameters remain unowned. Updating one creates a local value before mutation;
projected fields keep the same restriction. Returning an extra into mutable iteration state
copies its value. Existing initializer checks still preserve an old state observed after the
loop or passed again as an extra. Repeated extras can share their read-only input, while the
mutable state gets its own snapshot when required. Parallel map workers forward the const
pointers captured in their context. I/O tokens inside records retain their existing ordered
effects, and parallel maps remain restricted to eligible pure bodies.

The quiet Linux comparison used compiler `.57` at main `1fa07bb` and the final integrated `.58`
sources. Clang 19.1.7 compiled with `-O2 -std=c11 -D_POSIX_C_SOURCE=199309L`. Each sample used
32,768 calls, with three warmup groups and nine rotating sample groups; every accumulated
checksum matched. Peak load at a runtime sample start was 1.00, and no builds or tests ran
concurrently. Raw samples, source and executable hashes, and the exact protocol are in
`results/c-readonly-extras-linux.json`.

| Kernel | Previous compiler, ns/call | Current compiler, ns/call | Handwritten C, ns/call | Previous/current |
|---|---:|---:|---:|---:|
| minmax1k | 39,540.5 | 637.7 | 667.0 | 62.01× |
| filter2 | 81,059.9 | 1,202.9 | 1,081.3 | 67.39× |
| bsearch1k | 210,263.0 | 20,593.2 | 19,934.6 | 10.21× |
| utf8dec4k | 54,762.9 | 20,611.3 | 7,819.9 | 2.66× |
| tok4k | 34,029.9 | 17,790.6 | 15,296.6 | 1.91× |
| heap256 | 27,137.7 | 23,129.5 | 7,476.9 | 1.17× |

The table is supported by `results/c-readonly-extras-linux.json`. Handwritten C is inline with
the standard xorshift/checksum driver; emitted A0 is compiled in a separate translation unit,
following the repository comparison protocol. Several current workloads still trail their
handwritten reference. Small differences near parity are observations, not universal wins.

All ten kernels whose normalized C modules changed were timed. Four pairs—hist256, mat4,
rle4k and stencil64—have identical executable `.text` hashes; their small timing differences
are retained in the report and cannot be attributed to changed executable instructions.
The minmax and filter entry disassemblies respectively contain two and four static memcpy
call sites in the baseline and none in the candidate. These are static call-site counts,
not a measurement of all dynamic copies or allocations. Evidence:
`results/c-readonly-extras-linux.json`.

A separate warm compilation study used the twenty-nine prepared programs under Bun 1.3.4,
including the optimizer and C emission, excluding parsing, process startup, FunctionCache and
Clang. Medians were 802.8 versus 791.1 microseconds per compile, about 1.46% lower, with
overlapping raw sample ranges. The combined emitted C grew by 159 bytes. Executable sizes
were unchanged except hist256, which grew eight bytes. Peak load at a compilation sample
start was 1.32. These measurements do not establish a general compilation-speed improvement.
Evidence: `results/c-readonly-extras-linux.json`.

Before timing, the baseline and candidate passed 7,424 native comparisons against handwritten
C across all twenty-nine kernels, sixty-four inputs, and both optimization modes, under
undefined-behavior sanitization. The permanent suite adds seventeen tests covering 288 native
calls, thirty exact trap cases and a typed callback ABI compilation check. Boundary and larger
arrays, nested local updates, direct/moved/selected/projected borrowed returns, identical
state/extra snapshots, repeated extras, zero trips, foreign public C calls and I/O prefix
effects are covered. The parallel case uses a 128-element map and checks completed worker
dispatch with four requested threads. Coverage and fault controls:
`results/c-readonly-extras-linux.json`.

Removing the initializer/extra alias guard produces 594 instead of the correct 131 in both
optimization modes. Restoring the old parallel caller fails C compilation against the new
callback ABI, and the old by-value callback fails the typed ABI cost guard. These controls
demonstrate that the regressions detect the intended failures. Evidence:
`results/c-readonly-extras-linux.json`.

To compare current output with standard references, run
`bun run exec-bench -- --langs= --kernels=minmax1k,filter2,bsearch1k,utf8dec4k,tok4k,heap256 --samples=9 --scale=16`
on a quiet host. For revision comparisons, preserve both emissions, rotate subjects with the
recorded driver, verify checksums and keep the raw timings and hashes. Startup, energy,
end-user applications and billing cost were not measured in this iteration.
