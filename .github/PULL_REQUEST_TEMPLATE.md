## What this changes

<!-- One or two sentences: what changes and why. Link the issue if there is one. -->

## How you checked it

<!-- Tick what you ran, and say what you could not run (a missing toolchain is fine; say which). -->

- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] A test for the new behavior (or why none applies)

## Measurements and claims

<!-- Every number or comparison in docs, STATUS.md or a site template needs a results/*.json reference. List it here, or write "none". -->

## Checklist

- [ ] No local paths, usernames, keys, `.env` files or editor settings are committed
- [ ] `results/*.json` were produced by their tools, not edited by hand
- [ ] A change to `compiler/*.a0` is accompanied by `bun run seed`
- [ ] A change to emission or semantics bumps `COMPILER_VERSION` (`src/backends.ts`) and regenerates the golden file
- [ ] The change does not alter a sealed task set (`tools/ai-edit-tasks-*.sha256`)
