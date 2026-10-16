# Experimental A0 compiler ports

These modules are compiler implementations in A0. They are being integrated and do not yet replace
the TypeScript compiler used by the CLI, MCP or editors. The completion requirements remain in
[Entire compiler in A0](compiler-selfhosting.md). TypeScript linking/chunk planning during bootstrap
and independent test oracles are explicit development dependencies.

| Modules | Current boundary and remaining work |
| --- | --- |
| `emit_js.a0`, `emit_java.a0` | Canonical source and checked-IR emission, including total checked operations. Source entrypoints reject strict input. Java retains JVM method/signature/name constraints. Strict metadata and production frontend/option routing remain. |
| `emit_x86_64.a0` | Canonical x86-64 assembly with aggregates, IO and System V/Darwin ABI support. Strict input and unimplemented options are refused. Permanent runtime tests execute Linux x86-64; Darwin execution remains separate. |
| `emit_riscv64.a0` | Canonical RV64IM/LP64 assembly, aggregates and IO. Strict/options refusals are explicit. Cross-linked bytes are checked by an independent instruction model; that evidence is distinct from hardware execution. |
| `emit_arm32.a0` | Canonical A32 integer/aggregate emission, software division and an optional hardware division table mode. IO and strict input are refused. Cross-assembly and independent instruction-model checks do not establish hardware execution. |
| `emit_sv.a0`, `sv_text.a0`, `sv_geometry.a0` | Arena-backed combinational and clocked SystemVerilog emission. Original/optimized contexts preserve original module interfaces. Checked operations, potentially trapping strict input, oversized vectors and clocked predicates with IO retain explicit target refusals. RTL simulation/synthesis require their own tools. |
| `executable_bytes.a0`, `elf.a0`, `pe.a0` | Arena byte vectors, ELF64 and PE32+ layout/import construction. These do not themselves compile source or assemble instructions. ELF execution is tested on Linux x86-64; PE byte/layout tests do not establish Windows execution. |

The paged source emitters use private source-packet protocol v1: byte length, that many u32 byte
words, then completion tag `2690135777`. Payload words must be bytes. The source frontend capacity is
`131072` bytes; overflow returns code4 and incomplete framing returns code2, with no published output.
`source_packet.a0` supplies the JavaScript/Java reader. Other ports retain equivalent A0 readers.
The transport never truncates a packet into an accepted program. This interface remains experimental;
it is separate from the arena frontend's full-word representation and language source limit.

Arena writers use invocation-local handles and vectors `(handle,length,capacity)`. A0 chooses every
layout field, byte, offset, import and overflow decision. The host provides storage and transport.
Public output is published only after successful entry/emission, FINISH and session completion;
errors discard buffered output. `pe_prepare` creates an immutable successful invocation-local plan,
`pe_find_iat` resolves an import address, and `pe_build` consumes that same plan. Plan contents are an
internal-stage precondition, not authentication of arbitrary foreign metadata. Raw name encoding and
platform execution need their own coverage.

The native source tests build the verified A0-generated seed and use it to compile the emitter
closure to C. The generated native compiler then consumes test source. JavaScript output is executed,
Java output is compiled/executed when a JDK is available, x86 assembly executes on a matching Linux
host, and RISC-V/ARM32 bytes run in independent instruction models. A test oracle never supplies
replacement output after an A0 failure. The generic helper is test/bootstrap tooling and is not a
shipped semantic dispatcher.
