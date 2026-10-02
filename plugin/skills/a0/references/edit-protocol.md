# A0 edit protocol

Source of truth: DESIGN.md section 5, https://github.com/Joe-Simo/a0/blob/main/DESIGN.md

- A view comes with a handle (`e0` for a function, `g0` for the program). Reply with the handle line (optional when only one handle is open), then edit lines only. No code fence.
- Handles stay valid for the session: after a successful edit every open handle is rebound to the new revision.
- Edit lines under a function handle:
  - `id op args...` replaces node `id`, or inserts it before `ret` when `id` is new.
  - `id op args... @ other` inserts after node `other`.
  - `-id` deletes node `id`.
  - `ret x` or `ret OP ARGS` changes the result.
- Spec lines are optional and sit between the header and the first node: `ex ARGS -> RESULT` (an example, at most three), `pre OP ARGS`, `post OP ARGS` (one bool operation over `p0..`; `r` is the result in `post`). Edit them with `+ex ARGS -> RESULT`, `+pre OP ARGS`, `+post OP ARGS`, and `-ex ARGS -> RESULT`, `-pre`, `-post` to remove (under a program handle: `f:+ex ...`). Change an expected value by `-ex` of the old line and `+ex` of the new one.
- Whole functions, under any handle: a `fn NAME T... -> T` block adds or replaces that function (`end` optional). `-fn name` removes one. `-fn f` together with a `fn f` block replaces `f` in place.
- Send only the lines you change. Unchanged nodes are not repeated.
- The compiler checks the complete result and commits atomically. Rejected: unknown handles, stale revisions, type errors, duplicate replacements, forward references and recursion. Nothing invalid lands.
- A diagnostic carries `code`, `expected`, `actual` and `fix`. Apply the fix and resend under the same handle.
- Every `ex` runs when the program is checked: an edit that makes one fail is rejected whole (A0715, with `spec`: function, ex, input, expected, actual). Fix the function if the example is right; change or remove the example if the new behavior is intended. A view can omit spec lines (`specs: hide`); a whole-function reply keeps the ones it omits.
