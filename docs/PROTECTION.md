# Optional protection in the standard A0 toolchain

Experimental implementation; independent security review is required before production
confidentiality claims. This feature changes storage and release packaging, never A0 syntax,
tokens, semantics, or the compiler's authoritative parser. A0 remains open source under
Apache-2.0. Protection is not a language dialect.

## Independent controls

`a0 seal on|off|status [project]` controls stored source. `a0 protect on|off|status [project]`
controls future releases. Both default OFF. Changing build policy cannot change a previously
shipped application. Locking an unlocked session discards its access capability; it does not
turn storage encryption off. An unlocked view and copied source are plaintext.

The implementation ships with the standard compiler, including pinned `jose` and the runtime's
WebCrypto implementation. The standalone toolchain embeds its runtime. Core use requires no
Git, IDE, AI provider, plugin, account, subscription, mount, filesystem driver, daemon, cloud,
network connection, or special hardware. Initial installation/build dependency acquisition is
distinct from offline operation. Optional OS key stores and external tools are enhancements,
not prerequisites. The portable store and key interfaces permit non-filesystem integrations.

Development hosts are distinct from output targets. A Linux compiler host can emit browser or
native code without installing protection software on the output device. Sealed Source adds
no decryption, keys, model calls, or protection runtime to the compiled application.

## Threat model and boundaries

Sealed Source addresses offline theft of an encrypted project/export and accidental plaintext
retention in A0-managed storage. An attacker may know the complete compiler, formats and crypto
implementation and may modify ciphertext. Authentication/integrity failures stop the operation;
corrupt encrypted caches never become an unprotected cache miss. All authorized collaborators
can read and edit source. Only the project's owner can authorize recipients or rotate its keys.

It does not defend a compromised unlocked host, an authorized malicious collaborator, a debugger
or administrator reading process memory, screen/clipboard capture, or an unmanaged tool that was
given plaintext. JavaScript strings, CryptoKey objects, JIT copies and OS memory cannot be
reliably erased; byte buffers receive best-effort clearing. Swap, hibernation, core dumps,
filesystem snapshots, backups, VCS history, previous build outputs, third-party indexes and logs
may retain copies. Unlinking is not secure erasure, especially on flash or copy-on-write media.

Public storage reveals random project/object identifiers, phase, ciphertext
sizes, counts, timing and access patterns. Paths, source, content digests, recipient lists,
private debug data and the migration journal are inside authenticated encrypted metadata.
An external filesystem may still reveal old directory names or historic file activity.

Owner signatures prevent public recipient keys from being used to forge an authenticated
project. A recipient must obtain and explicitly trust the project fingerprint through an
owner-approved channel. Owners recognize their own signing authority by default; use
`--trust-project=FINGERPRINT` to bind an open to a specific project. An explicit mismatching
fingerprint always fails, including for an owner. Local key holders are not sandboxed by the source API. The consumer
declaration is a trusted host integration contract, not a way to detect an arbitrary process's
intent. Whole-version rollback/forks cannot be excluded without a separately trusted current
checkpoint. Old authorized versions and exports cannot be recalled. A revoked collaborator
can retain and replay an old authorized version; fresh-key rotation protects future versions,
not old copies. Availability against deleting files is outside the guarantee.

Protected Builds address casual recovery of unnecessary embedded debug/source artifacts.
The initial Wasm adapter is **artifact hygiene only**. It is not measured algorithm protection
and makes no confidentiality, unextractability, unclonability or superiority claim. A determined
attacker can analyze instructions, data, APIs and behavior. Signing and OS hardening establish
different properties and do not make application code confidential. Project keys and server
secrets must never be part of an application. This feature cannot discover every application
secret automatically.

## Cryptographic formats and keys

The adapter uses reviewed JOSE protocols, not a custom cipher: RFC 7515 JWS, RFC 7516 JWE,
RFC 7518 algorithms and RFC 7638 public-key thumbprints. `jose` is pinned in the lockfile.
The implementation is an application protocol that still needs independent security review.

* Objects: JWE `A256KW` / `A256GCM`; each object gets a fresh random content-encryption key
  and IV from the library. Project key-encryption keys and object names are random. Encryption
  is never deterministic, including for reproducible builds.
* Recipient grants: JWE `ECDH-ES+A256KW` / `A256GCM` using P-256 and fresh ephemeral keys.
* Authorization and manifests: ES256 JWS with separate signing and encryption key pairs;
  authorization, signatures and recipient lists are inside the encrypted manifest. Signatures
  bind the public head and private manifest. Encryption key material alone cannot manufacture
  an owner authorization.
* Recovery identity: JWE `PBES2-HS512+A256KW` / `A256GCM`, 600,000 PBKDF iterations and a random
  salt generated by the library. The iteration bound is also checked during recovery. Use a
  high-entropy passphrase; the minimum byte length is not an entropy guarantee.

Owners keep the encrypted identity/recovery file and its passphrase separately from the project.
There is no embedded universal key, escrow or vendor recovery. Losing the project keys and all
recoverable owner/recipient identities loses the data. A recovery file is an encrypted backup of
the identity, not a plain project-key export. Recipient sharing is an owner action. Revocation
re-encrypts every active object under a fresh project key and publishes fresh grants for retained
recipients. Merely deleting a grant is rejected by manifest authentication. Rotation is a
separate, potentially expensive operation; old encrypted objects/exports remain readable by old
keys. Owner identity replacement and a trusted anti-rollback checkpoint store are pending.

## Offline CLI and editing

Create a separate identity with `a0 seal keygen --key=OWNER_FILE`. A0 reads a passphrase with
terminal echo disabled. Automation can supply a private inherited descriptor with
`--password-fd=3` (or higher); do not put passphrases in arguments, environment variables,
shell history or logs. The identity file is created exclusively with private permissions.
Its encrypted contents are portable; OS key stores are optional future adapters.

Before migration, run `a0 seal on PROJECT --plan`. Review the inventory digest and unmanaged
exposure report. Enable using the same inventory with `--key=OWNER_FILE --approve=DIGEST
--confirm-exposure`. A changed inventory fails authorization. The implementation inventories A0
source, its declared `use` dependencies, and `.a0-cache`, `.a0-index`, `.a0-history`, `.a0-logs`, `.a0-tmp` managed storage;
it never assumes that `.git`, build output, backups or third-party caches have been cleaned.
Repeat `--include=RELATIVE_FILE` on the plan and enable commands for sensitive project
metadata or additional source. Selected metadata is encrypted and restored with source. Keep
the recovery identity outside the managed inventory. Invalid source is preserved as bytes;
its undiscovered dependency graph is reported for later repair. Stop unmanaged editors and writers while migrating. Symlinks and multiply linked source files
are rejected. The filesystem adapter assumes a trusted host, not an adversary racing path
resolution syscalls with the same user's privileges.

`a0 seal unlock PROJECT --key=OWNER_FILE --consumer=local-editor` starts an in-process NDJSON
editing session. `local-terminal` uses the same protocol. The terminal/editor/agent adapter
needs no mounted plaintext tree and exits locked on EOF. Supported messages:

```json
{"op":"paths"}
{"op":"read","path":"main.a0"}
{"op":"write","path":"main.a0","source":"normal A0 source"}
{"op":"check","path":"main.a0"}
{"op":"run","path":"main.a0","function":"main","args":[7]}
{"op":"build","path":"main.a0","target":"wasm"}
{"op":"export"}
{"op":"status"}
{"op":"lock"}
```

Local consumers can use `read-metadata` / `write-metadata` for selected UTF-8 metadata;
binary metadata uses the byte API. Check/build/run accept the existing execution-profile override.
Build replies contain base64 release artifacts; export replies contain sealed ciphertext.
Generated textual artifacts require `allowPlaintextArtifact:true`. Existing files remain
encrypted while editing. No plaintext source, compiler cache, history, log or temporary file
is materialized by this session. New caches are encrypted through the existing compiler's
per-function cache interface. Changed files are encrypted individually; changed cache objects
are committed as one batch. The manifest is currently rewritten per transaction, so metadata
cost grows with the project. Orphan/old ciphertext accumulates; authenticated garbage collection
and paged metadata are pending. These limitations must be included in storage/latency budgets.

External AI use additionally requires `--consumer=external-ai --recipient=NAME --paths=...`.
The initial invocation returns a disclosure challenge; the owner must explicitly approve it
using `--approve-disclosure=CHALLENGE`. A grant is bound to the project, launch revision,
recipient, exact paths and session, expires, and is invalidated by locking. Source API callers
must supply an owner approval callback. The protocol has no tool for an agent to grant itself
disclosure. External-AI sessions support scoped reads/writes only; check/build/export and
dependency-wide disclosure remain blocked until a complete integration is reviewed. A host
must not mislabel an AI connection as a local editor. No external model is called by A0.

Arbitrary third-party editors, terminals, LSP clients or agents do not understand ciphertext.
Existing filesystem MCP/LSP/native paths fail closed on sealed or transitioning projects;
the explicit session/API is the secure integration. Transparent VS Code/LSP virtual document
providers are pending. A0 cannot stop a caller from copying an unlocked view to an unmanaged
tool. That copy is plaintext disclosure and needs an informed owner decision.

`seal share --recipient-key=RECIPIENT_FILE`, `seal rotate`, and `seal revoke --recipient=ID`
use the owner identity. Rotation/revocation require `--acknowledge-old-copies`. Recipients use
`--trust-project=FINGERPRINT`. `seal export --out=FILE` writes only a sealed export;
`seal import --input=FILE` authenticates every active object before installing its head.

To disable storage encryption, `seal off --plan --key=OWNER_FILE` reports a new digest.
`--approve=DIGEST --confirm-exposure` explicitly authorizes plaintext restoration. Files are
restored atomically in their destination directories; only then is OFF committed and the encrypted store atomically moved into `.a0-seal-archive`. The mere presence of an active store blocks ordinary source access, even if its unauthenticated phase was tampered with. Crash
recovery is `seal resume --key=OWNER_FILE`. A stale commit lock requires owner authentication,
the lock-file digest via `--approve-lock`, and proof that its recorded process is no longer
alive. Ambiguous locks fail closed. Old encrypted backups are not deleted by disabling sealing.

## Release adapters and universal scope

`protect on` stores an explicit future-build policy. CLI/MCP emit paths consult it. An unsupported
adapter is an error, never an unprotected fallback. Library callers use the explicit protected
artifact API; this is not enforcement against arbitrary applications directly invoking a backend.
Existing optimized compilation is shared, without an extra frontend or model inference.

| Capability | Implemented | Tested here | Pending |
|---|---|---|---|
| Portable crypto/store/key/session interfaces | JWE/JWS, memory adapter | Node Linux | Actual browser/mobile/native host conformance |
| Offline standard CLI | Node/Bun, bundled dependencies | Linux tests | Other host OS and distribution verification |
| Filesystem encryption/migration | Ciphertext objects, atomic CAS/journal | Linux round trip and SIGKILL checkpoints | macOS, power-loss and filesystem durability campaigns; Windows writes fail closed until directory durability is implemented |
| Source-only compilation | Existing target emitters via one linker | Fixture parity | Real devices and full target behavior matrix |
| Browser/server Wasm release | Direct Wasm artifact hygiene | APIs, custom licenses/reflection, behavior | Measured reconstruction resistance |
| Native/managed/mobile releases | Interfaces and fail-closed capability checks | Requested unsupported target rejected | ELF/Mach-O/PE, JVM/.NET/mobile packaging and ABI review |
| Embedded/bare-metal | Same source and target interfaces | Protection unsupported explicitly | Native protection adapters, board tests |
| GPU | Shared compiler architecture remains applicable | No protection test | Shader/driver/platform adapters and device tests |
| FPGA/ASIC | Hardware source target remains in scope | Protection unsupported explicitly | HDL/netlist/bitstream adapters, board/silicon tests |
| OS secure storage, trusted servers/hardware | Optional interface scope | None | Explicit opt-in, threat and cost analysis |

The Wasm adapter removes known debug/name/source-map sections, returns private debug sections
separately, and preserves all unknown custom sections, exports, reflection/serialization data,
licenses, accessibility-relevant application data, strict diagnostics and execution semantics.
Sealed builds keep private sections in encrypted storage. Existing optimized Wasm often has
no removable sections: do not infer resistance from a mode flag or renamed symbols. Site/native/MCP-bundle packagers without a reviewed protection adapter stop when protection
is requested. C-derived external-toolchain Wasm protection is blocked; use `emit wasm` for the current direct adapter.
There are no default packers, new interpreters, repeated runtime decryption or intrusive
anti-debugging. Private debug data must not be shipped as part of the application.

## Measurement and review gates

Initial targets, not measured claims: at most 2% runtime/startup/p95 overhead, 5% memory,
artifact size and warm edit/build latency, and 10% clean-build overhead. OFF must have no
measurable overhead. Measure four configurations against identical optimized baselines:
OFF, source-only, build-only and combined. Keep source tokens unchanged; report AI-visible
source/token/cache identity separately from provider billing or hidden model computation.
Record sealing, unlocking, export and rotation separately. Flag budget failures and outliers;
never weaken encryption or silently skip a requested protection to pass a benchmark.

The required evidence includes real small/large applications and weak devices, backend and
cross-tool conformance, leaks, mode round trips, authorization, tampering, recovery, rotation,
crashes and reproducible compiled bytes with randomized encrypted storage. REA and independent
static/dynamic tools operate on owned fixtures. A valid resistance study gives an attacker the
compiler and uses hidden behavior/correctness tests with fixed time/token budgets. Names removed,
tool crashes and a failed analysis setup are not successes. Independent security review and an
independent reconstruction study remain release gates for confidentiality/resistance claims.

The filesystem adapter currently restores file bytes into private files/directories. Original
OS ACLs, ownership, timestamps and permissions are not a transparent filesystem round trip.
Symlink, hard-link, Windows directory durability, trusted checkpoint and owner-identity
replacement adapters remain pending. These limits do not change A0 program semantics.
