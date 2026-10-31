# Candidate authoring reference for migration validation

This is the internal reference for the single candidate grammar. It is not a second recommended
public workflow or a claim that cutover is complete. Public CLI defaults and `a0 init` still use
the existing guide. Internally source-bound `init` now installs the candidate primer and a
project-local `node .a0/cli.mjs` launcher, with matching agent rules and hooks. The installed
primer is generated from `src/source-guide.ts`; its examples and starter are executable tests.
Examples below are supplementary and checked by `test/source-guide.test.ts`; fresh
independent AI accuracy and cost studies remain pending.

Use explicit bindings, one operation per line, followed by `ret` and `end`. Uppercase `A`, `B`,
and so on are positional parameters. `_` means an unsigned 32-bit word; `bool` is a Boolean.
A scalar function may infer its word parameters and result. Keep explicit signatures when an
unused parameter or a non-word type must be retained. Arithmetic on words wraps; `<<` and `>>`
are shifts. Calls use the callee name in operation position. Callees precede callers.

```a0
fn twice
n add A A
ret n
end
fn answer
ex 7 -> 14
n twice A
ret n
end
```

Arrays use brackets and records use parentheses. Index arrays with `get` and record fields with
`at`. Array lengths and record field order are part of their types. Do not substitute one for the
other. These examples keep a scalar result, so their signatures can be inferred.

```a0
fn first
ex 3 -> 3
v [A,7]
r get v 0
ret r
end
fn field
ex 9 -> 9
v (A,true)
r at v 0
ret r
end
```

The operation profile is separate from source syntax. `profile strict` requests strict trap
semantics; it does not select another grammar. Executable `ex`, `pre` and `post` contracts are
optional and must describe the same typed function. Comments begin with `#` outside strings.

```a0
profile strict
fn half
ex 8 -> 4
r div A 2
ret r
end
```

Imports use `use "relative/path.a0"`; every imported file uses this grammar and remains inside
the selected project root. During legacy import only, a `.a0d` extension or the import command's
`--dense` input selector identifies old source. Those are compatibility readers, not ordinary
candidate authoring modes. Migration stages a new tree, checks hashes and linked revisions, and
preserves originals.

In a bound editor session, open a function, retain its handle, and send replacement binding
lines through `apply`; save only after acceptance. The session fixes the grammar for views,
replies and output. A rejected edit is atomic. A sealed local session uses the same reader and
compiler with encrypted managed storage. Authorized views and artifacts are plaintext in memory;
errors must omit source excerpts. External AI disclosure remains separately owner-approved.

This reference does not establish native frontend performance, complete guide coverage,
independent model accuracy, secure erasure, application secrecy, or full-platform support.
