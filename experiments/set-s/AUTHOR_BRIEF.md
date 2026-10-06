# Author brief for task set S (given verbatim to the task author; the author sees nothing else about the project)

You write test tasks for a study of how well language models edit small programs. You never see the language the
programs are later shown in, nor any model's answer. Everything is written in a neutral JSON program model.

## The program model

A program is a list of functions. A function has a name, parameter types, a result type, a body of numbered
statements and a return operand. Types: `u32` (unsigned 32-bit), `bool`, fixed arrays `u32x4` (an array of 4 u32;
the digit is the length), and records `(u32,bool)`. Parameters are named `p0`, `p1`, ... in order.

A statement is `{ "id": "a", "op": "add", "args": ["p0", 1] }`. An id is a lowercase word (letters, digits, `_`), unique
inside the function. An argument is an earlier id, a parameter `pN`, an unsigned number, `true` or `false`. A function
returns one operand: `"ret": "c"`. No recursion; a function may only call functions written earlier in the list.
Every operation is total and pure (nothing traps).

Operations (all u32 arithmetic wraps modulo 2^32):
- `add sub mul`: u32, u32 -> u32. `and or xor`: two u32 -> u32 (bitwise), or two bool -> bool (logical). `shl`, `shr`: shift
  by the low five bits of the distance; `shr` is logical.
- `div`, `rem`: unsigned; a zero divisor gives all ones (4294967295) for `div` and the dividend for `rem`.
- `eq ne lt le gt ge`: u32, u32 -> bool (unsigned compare).
- `select`: `["cond", x, y]` -> x when cond is true else y (x and y the same type).
- `mov`: identity.
- `get`: `[array, index]` -> element; the index is taken modulo the array length. `set`: `[array, index, value]` -> a copy with
  that element replaced (modulo length too). `arr`: `[v0, v1, ...]` builds an array. `rec`: builds a record; `at`: `[record, k]`
  reads field k (k a literal number).
- `call`: `["fname", arg, ...]` calls an earlier function. Written as `{ "op": "call", "args": ["fname", "p0", "a"] }`.
- `fold`: `["fname", count, init, extra...]` runs `state = fname(state, i, extra...)` for i = 0..count-1 and yields the final state;
  `fname` takes (state, the u32 step index, extras...) and returns the state's type; count is a literal.

Check your own programs by hand: they are executed by a reference interpreter later and any mistake drops the task.

## What to write: 16 tasks

Each task is one object:
`id` (`s-<short-name>`), `kind` (`targeted-edit` for 8 of them, `multi-node-edit` for 4, `comprehension-edit` for 4),
`wrongEditKind` (what a plausible wrong fix would get wrong, e.g. `off-by-one`, `comparison`, `swapped-argument`,
`wrapping`, `fold-bound`), `target` (the function to edit), `instruction` (one or two plain sentences telling a
programmer what the function should do or what to change; do not name statement ids), `start` (the program with the bug or missing
feature; 1 to 3 functions of 2 to 12 statements), `reference` (the same program correctly edited), `wrongEdits` (one or two
plausible but wrong edited programs), `tests` (at least 8 inputs with expected results for the target function, covering the
boundaries; the start must fail at least one, the reference must pass all, each wrong edit must fail at least one), `note`.
Spread the tasks over: boundary comparisons, bit manipulation, arrays (index, update, scan with fold), bool results,
helper-function calls, and changed constants. Use different shapes of program from each other; do not reuse one pattern.

## Output

One JSON file `{ "tasks": [ ... ] }`, shaped exactly like:

```json
{ "id": "s-example", "kind": "targeted-edit", "wrongEditKind": "comparison", "target": "f", "instruction": "...",
  "start":     { "functions": [ { "name": "f", "params": ["u32","u32"], "result": "bool",
                  "body": [ { "id": "a", "op": "lt", "args": ["p0","p1"] } ], "ret": "a" } ] },
  "reference": { "functions": [ ... ] },
  "wrongEdits": [ { "functions": [ ... ] } ],
  "tests": [ { "fn": "f", "args": [1, 2], "expected": true } ], "note": "..." }
```

Boolean test results are JSON `true`/`false`; an array argument or result is a JSON array of numbers.

## Additional requirement for this set

At least 5 targets must have a non-u32 result, at least 4 must use comparisons chained with select, at least 3 must take a record parameter or return a record, and at least 3 must call a helper. Do not reuse these ideas: clamp, abs-diff, in-range, is-even, saturating add, array minimum, swap-ends, sum of squares, count-above, bit test, power of two, parity, rotate, gray code, midpoint, round-up, weighted sum, contains, raise-element, carry detection, divide-with-remainder, leap year, popcount, last index, all-nonzero, first-above, range-sum, digit-sum, strictly-ascending, fee tier, nibble swap, ring advance, scale flag, cycle state, aligned large, change count, checksum, sort pair, median, saturating subtract cap, grade bands, histogram, bit length, adjacent equal, borrow subtract, lowest bit, time-to-live, free shipping, permission check, weekday wrap, exactly-one-true, run length, remaining and exhausted, discount before tax, forward shift. Invent different ones.
