# Arena raw UTF8 decoder, U8D1

This experimental component provides A0-owned raw UTF8 normalization. It is
separate from public source/filesystem routing. The frozen native proof passed
645 requests in each of two ASan+UBSan/Werror builds; see
[the proof record](arena-utf8-proof.json). No arbitrary interior UTF16 mapping
is provided.

`utf8_unit(bytes:u32x4,available:u32)` returns
`(status,consumed,outputBytes:u32x4,outLength,UTF16units,kind)`.
It examines one candidate unit with at most4 bytes of Unicode lookahead.
Invalid examined u32 cells (>255) return6 and empty unit output. Unexamined
lookahead is left for a later unit: `[65,256,0,0]` with available2 returns `A`;
the full stream rejects the256 when it becomes part of the next candidate.
Available>4 returns6; available0 succeeds empty and examines no cells.
Kind0 copies a valid encoding; kind1 emits U+FFFD for one malformed maximal
subpart. Valid four-byte scalars contribute2 UTF16 units; other units contribute1.

`arena_utf8_decode(io,sourceHandle,logicalLength)` returns
`(status,decodedV3,D128,io)`. The source allocation contains full u32 words;
the decoder itself rejects nonbyte cells within the requested logical span.
Words beyond that span are unexamined. Length0 performs no LOAD and does not
validate the handle. Whole requested-span decoding preserves BOM and matches
Node Buffer UTF8 maximal-subpart replacement. The source/sentinel/IO are
immutable, and all output/relations allocate separately. Caller owns FINISH
and session lifetime. Input must not be concurrently mutated while a pending
valid run is scanned and later copied.

Statuses1..5 preserve generic arena transport/handle/range/resource/finished
errors;6 means an examined nonbyte cell or invalid unit request;7 means an
internal progress/completion invariant failed. Vector growth overflow is3.
Failure returns decodedV3 `(0,0,0)`, zero D2/D3, zero D32..37, and D95=0;
scratch/progress fields may remain and are not a successful provenance view.
Success has status0, D93=0x55384431 (U8D1), D94=1 and D95=1.

Relevant descriptor fields are:

| Field | Meaning |
| --- | --- |
| D2 | decoded UTF8 byte count |
| D3 | total decoded UTF16 code units |
| D6 / D7 | supplied source handle / logical raw length |
| D32..34 | decoded byte vector `(handle,length,capacity)` |
| D35..37 | seven-word relation vector `(handle,lengthWords,capacityWords)` |
| D93 / D94 / D95 | U8D1 magic / schema1 / completed success |

Relation rows are `[decodedStart,decodedLength,rawStart,rawLength,UTF16start,
UTF16length,kind]`. Rows cover the whole requested span contiguously. Kind0
has byte-identical raw/decoded spans and an exact byte-displacement relation.
Kind1 relates an entire malformed raw subpart to the three UTF8 bytes of
U+FFFD, with UTF16length1. Kind1 interiors require a range/bias policy; equal
byte lengths do not imply an exact origin correspondence.

UTF16 columns provide whole-row endpoint totals. A valid run may mix ASCII,
BMP and astral scalars, so these totals do not define arbitrary interior UTF16
queries or interpolation. Such queries require a separate A0-owned scalar
scan/checkpoint helper and explicit policies for interior UTF8 bytes and
surrogate-pair midpoints. Unpaired host UTF16 surrogates/raw argv handling is a
separate boundary.

The decoder has no source-size policy cap. Its4-byte lookahead is a Unicode
invariant and128-word pages are the generic arena ABI. The32M-word budget used
by large development/native fixtures is a test-host resource budget. Caller
source-size diagnostics belong after decoding, since replacements can expand
the byte count. Resource exhaustion is explicit, and retained scratch is freed
by FINISH. A real sticky protocol error instead requires host session destroy;
requests after a real FINISH return5 and cannot reuse freed source handles.


The implementation lives in `compiler/utf8_unit_arena.a0` and
`compiler/utf8_decode_arena.a0`; their `.a0s` companions generate the canonical
A0 sources. The stream imports the existing generic arena vector module.
No host decoder or TypeScript semantic fallback is part of this API.

`test/arena-utf8.test.ts` builds the current verified seed freshly in its own
scratch directory, then uses that executable to compile a fixed three-root
closure (`arena_utf8_decode`, `arena_hello`, `arena_finish`). The fixed frozen
proof closure had 40 functions. O0/O2 builds run the exact 645-case source plan
with file-backed full-u32 packets. The driver includes the generic arena runtime
once so it can snapshot all original allocation capacities and inspect cleanup;
it implements transport/fault injection only. Node Buffer is an independent
expected-output oracle in the test host. No private binary or emitted C is used
as a fallback. Clang absence is an explicit local skip.

The permanent plan comprises 629 public stream requests, four forged internal
append-overflow controls and 12 pure-unit controls. It includes all Unicode
scalars concatenated, every two-byte input separated by ASCII, 2 MiB + 1 ASCII,
70,017 invalid bytes, 131,073 actual relation rows, handle 65,537, page crossings,
nonbyte cells, ignored tails, empty handle semantics, synthetic runtime errors,
malformed frames and real resource/sticky/finished lifecycle controls. The
internal overflow controls establish arithmetic guards, not physical allocation
of the entire u32 address space. External per-process test timeouts abort the
harness; they never become decoder statuses. The native proof's O0/O2 packets
were byte-identical on all requests; permanent tests require the same.

On an ordinary usable runtime, the caller sends FINISH even after a synthetic
error reply and requires a drained, allocation-free session. A real sticky
protocol error instead requires host destroy; no successful FINISH is claimed.
After a real FINISH, old source handles have been freed: the test checks their
immutability before FINISH, then requires status5 and zero retained allocations,
without making a post-free comparison. Synthetic status1/5 replies do not imply
those real lifecycle transitions.
