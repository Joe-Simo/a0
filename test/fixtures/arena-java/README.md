# Native arena Java regression fixtures

`probe.a0` links the original-source, direct checked-context and ordered-linked
Java services. All parsing, checking, spec verification, naming, Java ABI and
emission decisions execute in A0. The TypeScript harness only links the compiler
for its explicit bootstrap, transports opaque words and runs independent target
oracles. It builds the current verified seed in its own temporary directory;
it never uses a checked-in host compiler as the target implementation.

`plan.json` and `driver.c` are byte-identical to the inputs of the frozen native
proof recorded in `results/arena-java-provenance.json`. The plan has 50 unit rows;
10 target drivers run at both source and direct-context boundaries, giving 60
requests. Its 35 linked graphs run at quanta 1 and 7, giving 70 requests. Both
O0 and O2 builds therefore execute 130 requests and compare complete packet
reply hashes. The permanent builds use UBSan and Werror; the recorded isolated
proof additionally used ASan. Native protocol and emission assertions run even
when JDK 16+ is unavailable; the target-execution groups report an explicit skip.
Windows skips this POSIX ordered-link transport composition.

The native C driver includes the actual arena and filesystem runtimes once.
It retains uploaded source/path allocations, compares all allocation capacities
existing at the retained emission seams, checks original ctx/D and IO identity,
and requires zero public output on refusal plus drained FINISH/completion.
This is not an additional proof of full-linker file-buffer immutability. EMIT
is atomic for an individual request; publication across several requests does
not promise rollback after an earlier EMIT succeeded.

`linked-oracle.json` retains independent linker status/diagnostic/stage answers.
The Java drivers embedded in the plan retain independent modular-arithmetic,
checked truth-table and fixed ABI/alias/IO/trap assertions. Expected target
SHA256 values are a separate development-bootstrap byte differential. They do
not replace the independent value oracles. Selected linked modules execute on
the JVM; the other successful linked cases check metadata and emission only.
There are 22 executed target modules per native build, 44 in total.

Two generated-Java controls remove array cloning or force the checked-add flag.
Each must compile, run and fail with `AssertionError`. They are target-output
mutations, not mutants of the A0 implementation. Native proof source and harness
were frozen and passed without a corrective rebuild; the historical proof did
not retain dedicated mutant stdout/stderr files separately.

To run after integration and seed regeneration:

```
bun run build
node --test dist/test/arena-java.test.js
```

The service is experimental and has no public CLI route or optimizer fallback.
JVM method-code, constant-pool/member counts, generated record members and
filesystem class-name artifact limits still need a complete planner. Large
structural-tree emission fixtures do not claim javac/JVM success. A0BO,
DenseOrigin3, malformed raw UTF8, Windows linked paths and runtime performance
are separate milestones.
