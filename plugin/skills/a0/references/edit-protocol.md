# A0 edit protocol

Source of truth: DESIGN.md section 5, https://github.com/Joe-Simo/a0/blob/main/DESIGN.md

- A view comes with a handle (`e0` for a function, `g0` for the program). Reply with the handle line (optional when only one handle is open), then edit lines only. No code fence.
- Handles stay valid for the session: after a successful edit every open handle is rebound to the new revision.
- Edit lines under a function handle:
  - `id op args...` replaces node `id`, or inserts it before `ret` when `id` is new.
  - `id op args... @ other` inserts after node `other`.
  - `-id` deletes node `id`.
  - `ret x` or `ret OP ARGS` changes the result.
- Whole functions, under any handle: a `fn NAME T... -> T` block adds or replaces that function (`end` optional). `-fn name` removes one. `-fn f` together with a `fn f` block replaces `f` in place.
- Send only the lines you change. Unchanged nodes are not repeated.
- The compiler checks the complete result and commits atomically. Rejected: unknown handles, stale revisions, type errors, duplicate replacements, forward references and recursion. Nothing invalid lands.
- A diagnostic carries `code`, `expected`, `actual` and `fix`. Apply the fix and resend under the same handle.
