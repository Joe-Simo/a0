# Restricted-workspace host check

This runs inside the real VS Code extension host. It checks A0 language registration
and verifies that opening an A0 file in Restricted Mode does not start the configured
server. It does not qualify trusted-workspace LSP behavior.

Build the existing extension with its locked dependencies, then run from the repository:

```sh
node tools/qualify-editor-host.mjs /path/to/approved/cloud/VSCode/code
```

A Linux runner needs an available display, such as an existing Xvfb test display.
The helper creates and removes its own temporary workspace, profile and extension
directory. It does not use a user installation's profile, download an editor, or
grant workspace trust. A trusted fixture is a test failure, not permission to disable
the trust check. Keep the editor sandbox enabled.

The test source is prepared but real-host execution remains pending. The official
update metadata endpoint returned HTTP 403 in the current cloud executor; no editor
binary was downloaded or run. A permitted editor executable is the remaining input.
