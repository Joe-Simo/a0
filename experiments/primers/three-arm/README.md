# Draft guides for the next three-arm edit study

These guides are research inputs. They do not change the language defaults or the historical two-arm pilot. The next protocol and prompt hashes must be registered before collecting subjects.

Each guide describes its actual parser and the shared edit protocol. The Dense guide corrects the earlier guide's blanket omission of all-u32 signatures: an unused trailing parameter still needs an explicit header. It also describes implicit node IDs, escaped IDs, the loop predicate/body order, and the distinction between a one-field record type and value. The Canonical guide adds the corresponding loop, IO type, record and handle information. The native guide is copied unchanged from its executable control record.

`check-guides.mjs` executes independently authored, equivalent programs through all three readers and checks the same aggregate result, predicate-limited loop, unused parameter and handled edit. It separately checks a Dense keyword used as an escaped ID. Set `A0_SOURCE_PACKAGE` and `A0_SOURCE_PACKAGE_SHA256` to a verified runtime package before running it with Bun. These checks are language controls, not AI success trials or a complete grammar specification.

The previous default guides and the sealed 14-task application corpus remain unchanged. Additional application controls and a frozen protocol are still required before the next study starts.
