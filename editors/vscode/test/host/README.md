# Restricted-workspace host check

This runs inside the real VS Code extension host. It checks A0 language registration
and verifies that opening an A0 file in Restricted Mode does not start the configured
server after deliberate development-extension activation. VS Code exempts
development extensions from ordinary enablement filtering, so this exercises A0's
own execution guard. It does not qualify installed-extension disablement or
trusted-workspace LSP behavior.

Build the existing extension with its locked dependencies, then run from the repository:

```sh
node tools/qualify-editor-host.mjs /path/to/approved/cloud/VSCode/code
```

A Linux runner needs an available display, such as an existing Xvfb test display.
The helper creates and removes its own temporary workspace, profile and extension
directory. It does not use a user installation's profile, download an editor, or
grant workspace trust. A trusted fixture is a test failure, not permission to disable
the trust check. Keep the editor sandbox enabled.

Real-host execution passed on a standard public macOS ARM64 runner with the
official pinned VS Code 1.141.2 archive; see
[`results/editor-host-qualification-20261103.json`](../../../../results/editor-host-qualification-20261103.json).
The original cloud executor returned HTTP 403 from the official update endpoint.
Its editor, display and user-data directory are isolated to the temporary runner.
No workspace trust is granted, and the editor sandbox remains enabled. This passing test qualifies only development-host Restricted Mode registration and
server refusal, not installed-extension enablement or the trusted-workspace
language-server path.

The first hosted Linux attempt stopped before the extension test because the
archive's SUID sandbox helper was not root-owned with mode 4755. No privileges were
changed and sandboxing was not disabled. That attempt does not qualify Linux.

The same corrected host-test tree also passed on standard Windows x64 and macOS
ARM64 runners. Windows verifies the official archive executable signature and
checks its version through the vendor CLI, without assuming an unpacked package
layout. Fixture path comparison follows the host platform, including Windows
drive-letter casing. See the follow-up rows in the qualification report for exact
commits, runs, archive hashes, earlier failures and remaining scope limits.
