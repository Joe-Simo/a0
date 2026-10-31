# A0 editor integration

There is one `a0` language ID. Highlighting accepts the candidate grammar and retained legacy
source spellings; the selected compiler remains the authority for syntax and semantics.
The default server command is unchanged: `a0 lsp`.

For an initialized candidate project, open that project as one local workspace folder.
Candidate `init` writes these settings while preserving unrelated owner settings:

```json
{
  "a0.server.path": "node",
  "a0.server.args": [".a0/cli.mjs"]
}
```

The extension passes arguments as an array and sets the process working directory to that
folder. It does not invoke a shell or automatically discover/execute a workspace script.
Configured arguments require one local folder; ambiguous multi-root and non-file workspaces
are refused. Project code starts only in a trusted workspace. Generated settings do not grant
trust, and initialization refuses conflicting custom server settings rather than replacing them.

Candidate completions and hover use the bound frontend. Shift and aggregate completions use
`<<`, `>>`, `[0]` and `(0,)`; clients advertising snippet support receive editable placeholders.
There is no separate static snippet catalog or second language ID. Legacy server completions
remain unchanged. Moving a project keeps relative settings valid; moving the compiler requires
regenerating its launcher using the documented candidate initialization command.

Local validation covers TextMate tokenization, Tree-sitter parsing, real LSP exchanges,
extension launch/trust contracts, TypeScript checking and bundling. A GUI/editor-host session and
other platforms remain separate validation requirements; no extension is published by these tests.
