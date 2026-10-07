# Author brief for task set AA (given verbatim to the task author; the author sees nothing else about the project)

You write test tasks for a study of how well language models edit small programs. You never see the language the
programs are later shown in, nor any model's answer. Everything is written in a neutral JSON program model.

## The program model

A program is a list of functions. A function has a name, parameter types, a result type, a body of numbered
statements and a return operand. Types: `u32` (unsigned 32-bit), `bool`, fixed arrays `u32x4` (an array of 4 u32;
the digit is the length), records `(u32,bool)`, and `io` (see below). Parameters are named `p0`, `p1`, ... in order.

A statement is `{ "id": "a", "op": "add", "args": ["p0", 1] }`. An id is a lowercase word (letters, digits, `_`), unique
inside the function. An argument is an earlier id, a parameter `pN`, an unsigned number, `true` or `false`. A function
returns one operand: `"ret": "c"`. No recursion; a function may only call functions written earlier in the list.
Every operation is total and pure (nothing traps), except that `io` operations have the effects described below.

Operations (all u32 arithmetic wraps modulo 2^32):
- `add sub mul`: u32, u32 -> u32. `and or xor`: two u32 -> u32 (bitwise), or two bool -> bool (logical). `shl`, `shr`: shift
  by the low five bits of the distance; `shr` is logical.
- `div`, `rem`: unsigned; a zero divisor gives all ones (4294967295) for `div` and the dividend for `rem`.
- `eq ne`: two u32 or two bool -> bool. `lt le gt ge`: u32, u32 -> bool (unsigned compare).
- `select`: `["cond", x, y]` -> x when cond is true else y (x and y the same type; both are already computed).
- `mov`: identity.
- `get`: `[array, index]` -> element; the index is taken modulo the array length. `set`: `[array, index, value]` -> a copy with
  that element replaced (modulo length too). `arr`: `[v0, v1, ...]` builds an array. `rec`: builds a record; `at`: `[record, k]`
  reads field k (k a literal number); `put`: `[record, k, value]` -> a copy of the record with field k replaced.
  Arrays and records are values: changing a copy never changes the original.
- `call`: `["fname", arg, ...]` calls an earlier function. Written as `{ "op": "call", "args": ["fname", "p0", "a"] }`.
- `fold`: `["fname", count, init, extra...]` runs `state = fname(state, i, extra...)` for i = 0..count-1 and yields the final state;
  `fname` takes (state, the u32 step index, extras...) and returns the state's type; count is a literal.
- `loop`: `["pred", "step", count, init, extra...]` is a fold with early exit. For i = 0..count-1: first compute
  `pred(state, i, extra...)` (a function returning bool, written earlier); if it is false, stop and the result is the current state;
  otherwise `state = step(state, i, extra...)`. The result is the final state. `count` is a literal or an operand and caps the iterations.
  `pred` and `step` take the same parameters (state, step index, extras...); `step` returns the state's type.
- `text`: `{ "id": "a", "op": "text", "args": ["hello"] }` builds an array of the UTF-8 bytes of the string (ASCII only, 1 to 12
  characters; "hello" is the array [104, 101, 108, 108, 111] of type `u32x5`). Use `get` to read it.

### The `io` type

An `io` value is a token for input and output. It is used at most once: after it is passed to an operation or a call, the old name must not be
used again; the result of the operation is the new token. A function takes at most one `io` parameter. Arrays and records cannot hold a token,
and `select` cannot choose between tokens.
- `read`: `["t"]` -> a record `(u32, io)`: the next input word (0 once the input is exhausted) and the new token. Use `at` with 0 for the
  word and `at` with 1 for the new token.
- `write`: `["t", v]` -> the new token; appends the u32 `v` to the output.
- `puts`: `["t", arr]` -> the new token; appends the length of the array and then each element, in order, to the output.
- A function may take a token, call an earlier function with it (the callee takes it and returns the new token as its result of type `io`),
  and return it: the function's result type is `io`, and `"ret"` names the token.

How tests work for functions that take or return a token: an argument that is a token is written `{ "io": [3, 4] }` (the input words),
and an expected result of type `io` is written `{ "out": [7] }` (the output words written, in order). Other arguments and results are
as usual. Example: `{ "fn": "f", "args": [{ "io": [3, 4] }, 5], "expected": { "out": [8] } }`.

Check your own programs by hand: they are executed by a reference interpreter later and any mistake drops the task.

## What to write: 30 tasks

Each task is one object:
`id` (`aa-<short-name>`), `kind` (`targeted-edit`, `multi-node-edit` for at least 8 of them, `comprehension-edit` for at least 4),
`wrongEditKind` (what a plausible wrong fix would get wrong, e.g. `off-by-one`, `comparison`, `swapped-argument`,
`wrapping`, `fold-bound`, `stop-condition`, `token-order`), `target` (the function to edit), `instruction` (one or two plain sentences telling a
programmer what the function should do or what to change; do not name statement ids), `start` (the program with the bug or missing
feature; 1 to 4 functions of 2 to 12 statements), `reference` (the same program correctly edited), `wrongEdits` (one or two
plausible but wrong edited programs), `tests` (at least 8 inputs with expected results for the target function, covering the
boundaries; the start must fail at least one, the reference must pass all, each wrong edit must fail at least one), `note`.
Use different shapes of program from each other; do not reuse one pattern.

## Required mix (each task counts once, in its main category)

- 7 tasks whose target or helper uses `loop` (a search or scan that stops early, a countdown, a state machine with a stop condition).
  The fix changes the stop predicate, the step, the count or the start state.
- 6 tasks whose program contains a `text` constant (a lookup table of bytes, a message, a checksum over a string, an index into a string).
  The fix changes the text, the index arithmetic or what is computed from it.
- 7 tasks whose target takes or returns an `io` token (echo a transformed input, sum the next k inputs and write the sum, write an array
  with `puts`, pass the token through a helper that is written earlier, read two words and write them in the other order). The fix changes
  what is written, how many words are read or the order of operations on the token. At least 3 must use `read`, at least 3 `write`
  and at least 2 `puts`; at least 2 must call an earlier helper with the token.
- 6 tasks where the instruction asks for a new helper function: the edit adds a function, written before the function that calls it, and
  the target changes to call it. The start has no such helper; the reference has it earlier in the list.
- 4 plain tasks with no `loop`, `text`, `io`, `fold` or helper change: arithmetic, comparison, `select`, or `get`/`set`/`arr` on a fixed array,
  one function (or two) edited in place.

Across all 30: at least 4 tasks must compare two bool values with `eq` or `ne`, and at least 3 must read or replace a record field with
`at` or `put`. Do not copy the ideas of an ordinary textbook example in the same way twice; vary the domain (games, billing, signals,
inventory, text processing, scheduling).
Avoid these ideas, which earlier sets used: clamp, abs-diff, in-range, saturating add, array minimum, sum of squares, popcount, power
of two, parity, leap year, checksum of an array by weighted sum, tiered fee, night tariff, loan quarter, lift load, stair energy, and the ideas of these earlier tasks (including those of the sets before this one: ammo volley, indent width, light wait, heater on, octal peel, job warmup, bracket rounds, digit prefix, dozenal digit, cup size, header sum, shift back, keypad letter, operator char, tax total, meter usage, score puts, status first, tagged pair, feet inches, door agree, restock puts, box cost, lucky roll, clock end, shortfall total, member coupon, rising edge, tile right, same side, rotate left, shelf move): first bin at least a threshold, fuel burns, signal run, months
affordable, board jumps, free slot, echo decay, last slot, vowel pick, weekday initial, tag score, banner letter, ticket tail, battery
glyph, reading tenths, swap pair, sum of three reads, score card, tagged reply, relay scaled, larger reading, newest-first log, late fee,
weighted smoothing, overtime pay, reorder available, sensor maintenance, round to nickel.

## Output

One JSON file `{ "tasks": [ ... ] }`, shaped exactly like:

```json
{ "id": "aa-example", "kind": "targeted-edit", "wrongEditKind": "comparison", "target": "f", "instruction": "...",
  "start":     { "functions": [ { "name": "f", "params": ["u32","u32"], "result": "bool",
                  "body": [ { "id": "a", "op": "lt", "args": ["p0","p1"] } ], "ret": "a" } ] },
  "reference": { "functions": [ ... ] },
  "wrongEdits": [ { "functions": [ ... ] } ],
  "tests": [ { "fn": "f", "args": [1, 2], "expected": true } ], "note": "..." }
```

Boolean test results are JSON `true`/`false`; an array argument or result is a JSON array of numbers.
