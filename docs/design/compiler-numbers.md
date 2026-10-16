# A0 decimal number semantics

`compiler/number_integer.a0` converts a nonempty span of unsigned decimal byte words into binary64 bits and the shortest JavaScript-compatible decimal string. The sibling A0S file is its explicit authoring source. Leading zeroes are accepted by this numeric API; source-language callers enforce their own lexical rules. Signs, decimal points and exponent input syntax are outside the API.

`number_integer(io,sourceHandle,start,length)` returns `(status,(lowWord,highWord),byteVector3,io)`. Exact integer arithmetic implements nearest/ties-even binary64 rounding, asymmetric binade boundaries, shortest decimal selection, fixed notation below1e21 and scientific notation otherwise, including Infinity. Conversion scans all bytes after overflow so invalid late input remains an error. It preserves source storage and IO, and failures return zero bits and an empty vector. The internal128 base65536 limbs bound mathematical intermediates needed for binary64; they do not cap input length. Generic arena allocation and transport failures remain explicit.

Native regression tests use the verified A0 seed and Clang O0/O2 with UBSan/Werror. Independent oracles compare Number(original decimal bytes), binary64 bits and String(value), with binary/decimal boundaries, ties, randomized long integers, leading-zero inputs through2MiB, invalid cells/spans/handles and output allocation refusal. The caller owns session completion and publication.

`number_u56.a0` is the smaller diagnostic helper for products below2^56, with exact integer input supplied as two words. It is used only where the checker establishes that bound. The general converter is required for arbitrary decimal literals. These modules do not by themselves replace the CLI or all compiler diagnostics.
