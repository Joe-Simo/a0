# A0 Tree-sitter grammar

One editor grammar accepts the candidate source forms plus retained legacy spellings. It accepts
inferred and explicit signatures, `_` types, `A`–`Z` parameters and `pN` compatibility parameters,
`<<`/`>>`, aggregate expressions, repeated arrays, compact text and zero-argument calls. Legacy
explicit signatures, types and operations remain accepted. This additive editor support does not
change the public compiler default or make the grammar a semantic validator.

Empty/import-only modules, spec lines and the optional first `profile strict` directive remain
supported. `profile canonical` is not source syntax. A node called `ex`, `pre`, `post`, `profile`
or `strict` remains a node where permitted. Return operands take precedence over zero-argument
calls; `p0k` and similar identifiers must not split into a parameter and a suffix.

The compiler remains authoritative for arity, types, effects and source limits. Tests parse the
legacy repository corpus, executable candidate guide, all six migrated project closures and
focused ambiguity cases, and check highlights separately.

From this directory, using the repository's installed CLI:

```
../../node_modules/.bin/tree-sitter generate
../../node_modules/.bin/tree-sitter test
```

Commit `src/parser.c`, `src/grammar.json` and `src/node-types.json` with grammar changes. Preserve
licenses and notices under `src/tree_sitter` and `THIRD_PARTY_NOTICES`. The root editor tests run
with `node --test dist/test/editors.test.js` after `bun run build`.
