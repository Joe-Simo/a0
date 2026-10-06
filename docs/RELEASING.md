# Releasing

> This file is for the project maintainers: cutting a release needs write access to the repository (tags, the release workflow, the Homebrew formula). Contributors do not need it.

A release is a tag. Pushing `vX.Y.Z` runs `.github/workflows/release.yml`, which builds, publishes and updates `main`.
Nothing else is done by hand.

## Cut a release

1. On a branch from `main`, set the version everywhere:
   ```bash
   bun tools/set-version.ts X.Y.Z    # package.json, plugin and extension manifests, mcpb manifest, server.json, src/version.ts
   ```
   Replace `RELEASE_NOTES.md` with the notes for `vX.Y.Z`. Its first line must be `# A0 vX.Y.Z`; every number in it comes from
   a `results/*.json` file named beside it (run `bun tools/dev/claim-check.ts --files=RELEASE_NOTES.md`).
2. Run the gate: `bun run lint && bun run typecheck && bun run test`. Optionally try the whole pipeline on this machine:
   `bun run release X.Y.Z` (see Verify locally).
3. Merge to `main`, then tag that commit and push the tag:
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

`Formula/a0.rb` is not edited in step 1: the workflow sets the version in its four URLs (there is no `version` line: brew audit rejects it as redundant) and the four `sha256` values after the binaries exist.

## What the workflow does

Runs on `macos-15` (so the macOS binaries can be ad-hoc signed), with `contents: write` as its only permission and the
job's own `GITHUB_TOKEN` as its only credential. Actions are pinned to commit SHAs. It runs for tags only, so the commit it
pushes to `main` starts no further release.

1. Fails unless every version file equals the tag, the tagged commit is on `main`, and `RELEASE_NOTES.md` has the heading.
2. `bun run lint` and `bun run typecheck`.
3. `tools/release.sh X.Y.Z` builds, into a clean `release/`:
   - `a0-darwin-arm64`, `a0-darwin-x64`, `a0-linux-arm64`, `a0-linux-x64`, `a0-windows-x64.exe` (`bun build --compile`);
   - `a0-mcp-<os>-<arch>.mcpb`, one MCP Bundle per binary (`tools/mcpb.ts`);
   - `server.json`: the repository template with the version and each bundle's release URL and `fileSha256`;
   - `checksums.txt`: SHA-256 of the five binaries and five bundles, sorted by name.
   It fails on a missing or empty artifact, and when the binary for the build machine does not report `a0 X.Y.Z`.
4. Creates the GitHub release with `RELEASE_NOTES.md` as its body (or updates the notes if the release exists), uploads the
   twelve assets with `--clobber`, then fails unless the release lists exactly those twelve. Re-running a failed tag is safe.
5. Checks out `main` and commits `Formula/a0.rb` (new version and checksums) and `server.json` (version and bundles).
   If `main` has branch protection, allow GitHub Actions to push to it. The formula's `test do` block asserts
   `a0 --version`; the script adds that line (valid from 0.8.16) when it first updates the formula.
6. The `smoke` job then runs on macOS arm64 (`macos-14`) and x64 (`macos-15-intel`), Linux arm64 and x64, and Windows. Each
   installs the released binary through the real script (`install.sh`, or `install.ps1` on Windows; both verify SHA-256
   against `checksums.txt`) and runs `tools/smoke.ts`: `a0 --version`, `check`, `run`, and an MCP `initialize` plus
   `tools/list` handshake. A failure fails the workflow, after the release is already published.

`ci.yml` also has a `formula` job (macOS) that taps this repository and runs `brew style` and `brew audit --strict --new` on
`Formula/a0.rb`. Workflows pin every action to a commit SHA and request `contents: read` unless they must write.

## Verify

After the run:

```bash
gh release view vX.Y.Z --json assets --jq '.assets[].name'     # 12 assets
curl -fsSL https://github.com/Joe-Simo/a0/releases/download/vX.Y.Z/checksums.txt
brew tap Joe-Simo/a0 https://github.com/Joe-Simo/a0 && brew install a0 && a0 --version && brew test a0
curl -fsSL https://raw.githubusercontent.com/Joe-Simo/a0/main/install.sh | A0_VERSION=vX.Y.Z sh
```

`npx skills add Joe-Simo/a0 --list` should list the `a0` skill (skills.sh discovers `skills/a0/`, the source of truth;
`plugin/skills/a0/` is a copy kept identical by `bun tools/sync-skill.ts`, checked in lint). skills.sh ranks by install telemetry; there is no
submission step.

The MCP registry entry is published from the release's `server.json`.

## Verify locally

`bun run release X.Y.Z` runs step 3 on your machine (it downloads the Bun runtimes for the other targets). Then
`release/a0-<os>-<arch> --version`, `check`, `run` and `mcp` against a small program, and `A0_RELEASE_URL=http://localhost:PORT sh install.sh`
against a directory served from `release/` test the install scripts without GitHub. `release/` is not tracked.
Check the formula's style with `brew style a0` after `brew tap Joe-Simo/a0 <path to a clone>`.

## Signing

The binaries are not signed with paid certificates. macOS binaries are ad-hoc signed (`codesign -s -`), which Apple silicon
requires to run at all, but they are not Developer ID signed or notarized. The Windows binary is unsigned. Installing with
`install.sh`, `install.ps1` or Homebrew downloads outside a browser and normally shows no warning. A binary downloaded by hand in
a browser can show one:

- macOS Gatekeeper ("cannot be opened because Apple cannot check it"): `xattr -d com.apple.quarantine ./a0-darwin-arm64`, or
  open it once with right-click, Open.
- Windows SmartScreen ("Windows protected your PC"): choose More info, Run anyway, or run `Unblock-File .\a0-windows-x64.exe`.

Developer ID and Authenticode certificates would remove these prompts; adding them needs a paid account and is not done.
