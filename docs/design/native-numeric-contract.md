# Structured numeric IR and the source contract

The source language has unsigned 32-bit integer literals. The TypeScript `Operand` and `Lit`
interfaces use `number` to store them; that host type also permits values outside the language's
range. The existing validator does not consistently reject those handbuilt values. This inventory
records that behavior without changing it. It does not propose floating-point source types or a
second source syntax.

[Reference results](../../results/native-numeric-contract.json) contain complete diagnostic JSON,
raw IEEE-754 words and source probes. Reproduce from a built checkout with:

```sh
bun run build
node experiments/unification/numeric-contract/probe.mjs
```

An optional second argument after the report path supplies an existing native artifact:

```sh
node experiments/unification/numeric-contract/probe.mjs results/native-numeric-contract.json path/to/frontend.wasm
```

The probe imports the existing reference implementation. It is an experiment, never a compiler
dependency or a fallback. Its source hashes and executing commit are recorded in the report.

## Reachability

`src/core.ts` describes `u32` as an unsigned 32-bit integer. Its `parseOperand` accepts decimal
digits and rejects a value above `4294967295` with A0004. Fractional, negative and non-finite
spellings cannot become numeric operands through that parser. Candidate flat operands delegate to
it in `src/source.ts`; historical Surface atoms do so in `tools/surface-v2-frontend.ts`.
`src/spec.ts` bounds example literals while parsing their decimal spelling.

Dense's ordinary decimal, hexadecimal and binary readers also bound their values. Its experimental
compact negative spelling converts `-N` to the valid unsigned integer `2^32-N`; it does not introduce
a negative IR literal. Compact dot-field access can construct an oversized index, but the resulting
program fails A0308 and is not accepted source. These branches, together with the recorded probes,
establish the distinction between accepted programs and errors encountered while reading text.
The probes are not an exhaustive enumeration of source strings.

MCP `a0_apply` accepts an edit string, whose source/operand parsers enforce these rules. It accepts
no JSON `Program` or `Operand` object. `a0_run` receives JSON runtime arguments and checks them with
`checkArgument`; an oversized argument cannot become a stored IR literal. Exported TypeScript
`validate`, `validateFunction`, `replaceNodes` and `applyPatch` can receive manually constructed
objects, so their diagnostic behavior still needs a separate compatibility inventory. No documented
promise to accept arbitrary JavaScript numbers as `u32` values was found in the inspected definitions.

## Existing handbuilt-IR behavior

The table describes the recorded negative, fractional, non-finite and oversized payloads. `-0`
passes the numeric range test, as do the ordinary unsigned boundary values.

| Context | Existing reference behavior |
| --- | --- |
| Instruction argument | A0308 after all argument references/types resolve |
| Literal returned directly | Accepted; the interpreter returns the original host number |
| Example argument | A0715 wraps the runtime A0704 argument rejection |
| Direct return matching an example's expected literal | Accepted for the recorded non-NaN values; NaN fails equality with A0715 |
| `pre` argument | A0714 wraps the synthetic function's A0308 |
| `post` argument | A0714 wraps the synthetic function's A0308 |

A0308's JSON message is only `FUNCTION.NODE: literal out of u32 range`. It does **not** display
the invalid number. Its expected, actual, fix and applicability fields are null, and edits are
empty. A0714 and A0715 have different messages and spec facts; returning A0308 for those contexts
would not preserve the existing JSON.

`validateFunction` checks node names, duplicate definitions, callee/predicate presence and arity
before resolving every argument. It then scans numeric argument values, checks linearity, and
checks the operation's types. Thus a later unknown node or missing parameter beats an earlier
bad literal in the same instruction; a numeric error beats an operation-type mismatch. A bad
literal in an earlier body instruction also beats an invalid direct return literal. Contract
binding checks precede synthetic contract typing. Example type checking precedes example execution.
These priorities are recorded independently of the proposed native representation.

The direct-return and expected-literal cases are existing validator quirks outside the defined
source/value contract. This refactor must not silently clamp them, reject them globally, or change
the old validator to simplify a comparison. Public structured-IR cutover must explicitly state its
documented input contract and remaining compatibility scope before retiring the old entry points.

## Small native A0308 follow-up, not implemented

The recorded native boundary probes use the existing C-derived frontend identified by its exact
byte count and SHA-256 in the report. A valid body succeeds with status0; a representable missing
parameter returns status8/ID105. A non-word payload throws `Error` with the message
`unrepresentable native program IR: expected a u32 word`; it does not return a native status or
diagnostic JSON. The renderer was deliberately unconfigured for these boundary probes. The
native encoder rejects a non-word numeric payload before invoking A0 and consequently
cannot reproduce instruction A0308 or its priority for handbuilt malformed IR. The following is a
bounded design for closing that diagnostic gap; it is outside the current CI repair candidate.

1. Keep all existing word-representable operand rows and the source parser unchanged. Add a private,
   explicitly supported raw-number operand representation carrying both IEEE-754 words, rather than
   a host-supplied `invalid` bit. A possible same-width row is a new internal kind with low/high words
   and zero location fields. Negotiate support or verify the exact native artifact before emitting
   that representation; the public frontend ABI stays 3 and ordinary schema1 rows stay identical.
2. Resolve a raw-number operand's type as `u32` during the existing argument-type pass. Preserve all
   reference diagnostics before making a numeric range decision. Insert one A0 numeric scan between
   `ac_node`'s `ac_operands` and `ac_linear` passes in `compiler/check_arena_shared.a0`.
3. Implement the range decision once in A0 using the words' sign, exponent and fraction. Both signed
   zero bit patterns pass. A nonzero value must have sign zero, an unbiased exponent from 0 through
   31, and all fraction bits below that integer position zero. This rejects fractions, subnormals,
   negative numbers, infinities, NaNs and values at least `2^32` without floating-point instructions.
   Avoid a shift-by-32 mask; A0 shifts use only the low five distance bits.
4. Extend the existing A0 diagnostic renderer's known-ID, class and message selection for 308.
   Reuse its function/node identity path. No decimal renderer or numeric display payload is needed.
   Raw numeric words must never be interpreted as byte spans, symbol IDs or relocation offsets.

This bounded change does **not** authorize applying A0308 to return literals or examples. Those
contexts retain the inventory above as separate compatibility work. Preserving arbitrary invalid
return values through native spec execution could require extending the one native evaluator and
its value representation; adding a host evaluator fallback or a second checker is not acceptable.
The source/MCP input contract does not justify building a general IEEE-754 language merely to
preserve malformed handbuilt objects. Until scope is resolved, any private unsupported cases must
remain explicit, and a body-diagnostic fix must not be described as complete public API parity.

Before integration, native controls should compare complete diagnostic JSON against the recorded
reference across C-derived Wasm, direct Wasm and generated JavaScript. Include both reference-error
orders, name/arity/type/linearity priority, valid boundaries and signed zero, several NaN payloads,
tampered raw words, lossless decode, immutable snapshots, resource failures and unchanged valid
source artifacts. Required seed and repository gates still apply. No implementation or performance
claim is made by this design.
