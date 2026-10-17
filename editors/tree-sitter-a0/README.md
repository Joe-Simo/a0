# A0 Tree-sitter grammar

The grammar accepts canonical A0 modules, including empty and import-only
modules, spec lines, and the optional `profile strict` directive. The directive
may appear once as the first non-comment declaration, before any `use` or `fn`.
It can also stand alone. An absent directive selects the canonical profile;
`profile canonical` is not source syntax. Declarations require line separators.
`profile` and `strict` remain ordinary identifiers in function bodies and names.
The highlight query treats only the directive tokens as keywords.

The compiler remains the authority for semantic checking. Editor grammar tests
compare directive placement against `parseAndValidate`, exercise malformed,
repeated and misplaced directives, and parse every valid repository A0 file.
No fixture is excluded to accommodate the directive.

From this directory, using the repository's installed Tree-sitter CLI:

```
../../node_modules/.bin/tree-sitter generate
../../node_modules/.bin/tree-sitter test
```

Commit generated `src/parser.c`, `src/grammar.json` and `src/node-types.json`
with grammar changes. Keep the licenses and notices in `src/tree_sitter` and
`THIRD_PARTY_NOTICES` when regenerating. The complete editor integration test
runs from the repository root with `node --test dist/test/editors.test.js` after
`bun run build`.
