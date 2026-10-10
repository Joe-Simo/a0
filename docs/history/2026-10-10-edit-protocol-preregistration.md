# Pre-registration: the combined A0 edit protocol against the shipped dense control, TypeScript and Rust

Date: 2026-10-10. Committed before any subject is run. Nothing in this file is a result; it fixes the arms, the sets, the
method, the metric and the decision rule, and the decision is read from the summary and not changed after it is read.

## Question

Does one A0 edit protocol that combines four changes (callee bodies in the view, the one-worked-example dense primer,
a typed target header with a de-duplicated program listing, and a three-tool MCP surface whose schema is paid for) keep
acceptance and cost fewer tokens per accepted edit than the dense protocol as shipped, and how does it stand against
TypeScript and Rust when every arm pays for its tools?

## Arms (harness `tools/ai-edit-experiment.ts`, structured protocol, `A0_EXPERIMENT_PRIMER=rules-merged`, one repair)

Every new switch is off by default; with the defaults the harness, the MCP server and the views behave as before
(`bun run test` green on the commit of this file).

1. **A0 combined**: `A0_EXPERIMENT_DENSE=1 A0_EXPERIMENT_DENSE_VIEW=bodies A0_EXPERIMENT_TYPED_HEADER=1
   A0_EXPERIMENT_TOOL_SCHEMAS=1 A0_EXPERIMENT_GUIDE=experiments/primers/ablation/dense.DR2.txt`.
   - (a) bodies view: the lean dense view with the direct callees shown as dense text (the `a0-dense-bodies` subject of
     `results/ai-edit-b48-dense.json`, reused unchanged).
   - (b) primer DR2: the D0-to-DR2 rewrite of the primer ablation with one worked example
     (`docs/history/2026-10-02-primer-ablation.md`), used as the whole system text (rules-merged).
   - (c) typed header: the target's header always carries its full typed signature (`fn fits u32 u32 -> bool ...`
     where the plain view prints `fn fits -> bool ...`), and the view is followed by the signature lines of the
     target's program neighbourhood (callees at any depth and direct callers) that it does not already show as a
     function (`typedTargetView`, `src/edit.ts`). On these single-program sets the listing is usually empty.
   - (d) tool surface: `createServer(launch, { surface: 'compact' })` (`src/mcp.ts`; `A0_MCP_SURFACE=compact` for
     `a0 mcp`): `a0_open`, `a0_apply`, `a0_save`, one-line descriptions. Its schema is counted as the o200k tokens of
     the JSON tool list a client receives (`{name, description, inputSchema}` per tool), charged once per model call.
2. **A0 dense control as shipped**: `A0_EXPERIMENT_DENSE=1 A0_EXPERIMENT_DENSE_VIEW=lean A0_EXPERIMENT_TOOL_SCHEMAS=1
   A0_EXPERIMENT_TOOL_SURFACE=full A0_EXPERIMENT_GUIDE=MODEL_GUIDE.dense.txt`: the lean view, the shipped dense primer,
   and the shipped seven-tool MCP surface counted the same way.
3. **TypeScript** and 4. **Rust**: the numbered line-edit protocol (`PROTOCOL_LINE_EDIT`), whole numbered file,
   `A0_EXPERIMENT_TOOL_SCHEMAS=1`: each pays one edit tool (`TS_EDIT_TOOL`, `edit_file {path, edits}`), counted the same
   way. Neither arm is charged a read tool; this favours them.

The tool schemas are counted, not sent: subjects reply in the text protocol of their system text in every arm. The
local counts at the commit of this file are 251 o200k tokens (A0 compact), 1138 (A0 full) and 59 (`edit_file`); the
summary takes them from each report's `toolSchemaTokensLocal`, not from this paragraph.

## Models and sets

Haiku and Sonnet, fresh subagents, **one subagent per prompt** (no group files), one shot, then one repair by a fresh
subagent of the same model given the system text, the request, its first reply and the harness's exact rejection.
No author-written replies. Sets: **b** (12 tasks), **e** (11) and **f** (13), each checked before any subject runs:
`tools/ai-edit-tasks-e.sha256` and `tools/ai-edit-tasks-f.sha256` match the files (checked 2026-10-10), and the
harness's `taskSetSha256` reproduces the recorded runs (b `21de5a34...`, e `7b387c6f...`, f `2c02b500...`). No task is
altered. 36 tasks x 4 arms x 2 models = 288 first-shot subjects.

Each subject gets its own directory holding only `prompt.txt` (the system text, then the request) and writes `reply.txt`
there; its prompt names that directory and forbids reading anything outside it.

## Metric

Tokens per accepted edit (o200k, local counts): the sum over a cell's trials of the system text (primer, protocol
paragraph and tool schema, charged per model call), the request (task text and view), repair messages and replies,
divided by the accepted edits, at three horizons. **Cache rule**: the system text is priced at the cached weights of
a horizon (cold 1.25 first call / 0.05 later calls; 10-task 0.17 / 0.05; unbounded 0.05 / 0.05, as in
`tools/cost-anatomy.ts`) only when its per-call size reaches the provider's minimum cacheable prefix for the model
(512 tokens for Haiku 5.5 and Sonnet 5.5, the provider's prompt-caching table; `CACHE_MINIMUM` in
`tools/edit-protocol-summary.ts`). A shorter prefix is never cached, so every call bills it at weight 1. The local
count stands in for the vendor tokenizer in that comparison. `tools/edit-protocol-summary.ts` computes the verdict.

## Decision rule (per model, the combined arm against each comparator)

- after-repair acceptance no lower than the comparator's;
- one-shot acceptance not a loss under Wilson 95% (a loss: the combined arm's upper bound is below the comparator's
  lower bound);
- tokens per accepted edit lower than the comparator's by more than 1% at the cold, 10-task and unbounded horizons.

The combined protocol may replace the shipped default only if it passes against the control for both models. Against
TypeScript and Rust the same three tests are reported as wins or losses. Every failed test is recorded as a loss
(`bun run loss-ledger -- --update --reason ...`, STATUS and this file), whatever the other tests say.
