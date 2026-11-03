# Counted-source conformance

`results/source-token-conformance.json` checks the exact four-language sources in
`results/source-tokens.json`. It does not change their token counts or choose a
shorter A0 program solely for the token comparison.

The fixed corpus contains 29 programs. For each arity, the check retains the four
existing offset boundary inputs, adds uniform boundary inputs and eight xorshift
inputs from seed `0x60b3aa51`, and removes duplicate vectors. The recorded run has
456 inputs. Every result is compared individually with the A0 interpreter and
JavaScript, not only through an aggregate checksum.

C runs at O0 and O2 with undefined-behavior sanitization. Rust runs at optimization
levels 0 and 2 with overflow checks enabled. Missing compilers, failed compilation,
runtime diagnostics, malformed output or a mismatch fail the command; they are
not converted to successful or timed rows.

After building, reproduce with installed Clang (including its UBSan runtime) and
Rust compilers:

```sh
node dist/tools/source-token-conformance.js --clang=clang --rustc=rustc --out=results/source-token-conformance.json
```

The report records tool versions, exact inputs and outputs, source/driver/binary
hashes and the token-report hash. A regression test checks those bindings and the
current JavaScript outputs. Changing a counted source or the input protocol
requires fresh executable evidence.

This is bounded correctness evidence, not a universal equivalence proof, a test of
every compiler flag, a native A0 execution result, a performance comparison, or an
AI accuracy/cost study. Historical execution measurements and unfavorable token
counts remain unchanged.
