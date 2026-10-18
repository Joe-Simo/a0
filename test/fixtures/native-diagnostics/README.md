# Retained native diagnostic packets

`packets.json` contains complete output packets from the existing
`test/arena-diagnostics.test.ts` native driver, built from the source commit recorded
in `provenance`. Its verified A0 seed emitted the renderer's C; Clang built O0 and O2
executables with undefined-behavior sanitization. Both executables produced identical
entire packets for every retained input. Executable SHA256 values identify those
captured drivers; no executable is committed.

The native driver receives `SOURCE OUTPUT BUDGET OPTIONS`. Its output consists of
little-endian u32 words: renderer status, 128 facts, JSON byte count, then one JSON
byte per u32 word. The fixture preserves the original JSON text without rewriting
it. Tests reconstruct that transport and verify its complete packet hash, JSON
hash and source hash. This is an immutable protocol fixture; future rendering
changes require a new proven native capture rather than editing expected wording.

The fixture includes complete parse/name/type errors, suggestions and exact repairs,
as well as resource and valid/spec-pending refusal packets. Refused packets contain
no JSON. Spec-pending refusal is not evidence of spec diagnostic rendering.
