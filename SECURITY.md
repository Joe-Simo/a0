# Security

## What to report

A0 is a compiler and its tools. Please report anything that lets a program or an input escape what it should be limited to, for example:

- the MCP server (`a0 mcp <dir>`) or the language server reading or writing outside the folder it was given (paths, symlinks), or leaking host paths;
- a compiler or backend bug that makes the generated code differ from the specified A0 semantics in a way that could be exploited (for example an out-of-bounds
  access that the specification says cannot happen);
- the install scripts, release assets or checksums not matching what the project publishes;
- a secret, key or personal path committed to the repository.

## How to report

Use GitHub's private vulnerability reporting for this repository (the **Security** tab, "Report a vulnerability"), if it is available. If it is not,
open an issue that says only that you have a security report and how to reach you, and **do not put exploit details in a public issue**.

Please include the version (`a0 --version`), the platform, and a minimal program or input that shows the problem.

## What to expect

This is a small project maintained by volunteers. We will acknowledge a report as soon as we can, tell you whether we consider it in scope, and credit you
in the fix if you wish. Supported versions are the latest release and `main`.

## What is not a vulnerability

A0 programs run as the user who runs them; running an untrusted program is not sandboxed by the compiler beyond the language's own limits (no heap,
no recursion, bounded loops, a fuel limit in the reference interpreter). The MCP server and the language server make no network requests.
