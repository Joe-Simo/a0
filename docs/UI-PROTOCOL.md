# The A0 UI protocol

An A0 program that draws a page (`site/page.a0`, `site/docs.a0`, `site/bench.a0`, or any other `io` program) writes a stream of 32-bit words. A small generic host runtime turns the stream into DOM: `site/app.ts` in the browser, `tools/site-render.ts` at build time (the prerendered HTML for readers and crawlers without JavaScript). Neither knows anything about the page. `site/ui.a0` holds the program-side helpers and `site/wire.ts` the pure decoding both hosts share. The generator's template language (`site/gen/sitegen.a0`) is the usual way to write the stream.

A host call is `a0_session(io)`: the input words are `event x y ntext text[ntext] nstate state[nstate]`, the output words are the commands below, read until the stream ends. A length-prefixed byte string is `n byte byte ...` (the length is clamped to the words that remain).

| Word | Command | Meaning |
|---|---|---|
| 1 | `OPEN tag` | open an element; tag numbers are in `site/gen/tags.tpl` |
| 2 | `TEXT n bytes` | a text node in the open element |
| 3 | `CLOSE` | close the open element |
| 4 | `ATTR key n bytes` | an attribute of the open element (keys in `tags.tpl`; `href` is restricted by `safeHref`) |
| 5 | `ONCLICK event` | clicking the open element re-runs the program with that event |
| 6 | `STATE n words` | the state the next event carries back |
| 8 | `ONSUBMIT event` | Enter in an input, Ctrl/Cmd+Enter in a textarea |
| 9 | `STYLE n bytes` | stylesheet text |
| 10 | `GRID event rows row...` | a bitmap drawn on a canvas, cell clicks send `event x y` |
| 11 | `TIMER ms event` | re-run after `ms` |
| 12 | `SIZE prop percent` | width, height, left or bottom of the open element as a percentage |
| 13 | `SHADER n bytes` | a GLSL ES 3.0 fragment shader drawn on a canvas in the open element |
| 14 | `COPY n bytes` | the open element copies these bytes to the clipboard when activated |

## COPY (14)

`COPY n bytes` applies to the open element, like `ONCLICK`, and the payload is the text to copy. Any program can use it for any element, for example a "copy this command" button next to a code sample. It is a UI-only command: nothing is sent to the program when it fires, so there is no event and no re-render.

Browser runtime (`site/app.ts`, `copyFor`):

- The click handler calls `navigator.clipboard.writeText(text)` first, in the user's gesture. A real `<button>` is activated by Enter and Space as well as by the pointer, so the keyboard needs no extra code.
- Only if the Clipboard API is missing or rejects, it copies through a temporary read-only `textarea` and `document.execCommand('copy')`. If that fails too, it selects the text of the element's previous sibling (else the next) so the user can press Ctrl+C.
- It sets `data-copied="1"` on the element for 1500 ms (`fail` when nothing could copy) and puts "Copied" (or the failure hint) into one visually hidden `role="status"` / `aria-live="polite"` element appended to `<body>`, outside the page root so a re-render keeps it. The label is never changed by the runtime: the stylesheet draws the state (`.copy[data-copied]` in `site/gen/style.css`: an accent outline and a check glyph, a copy glyph otherwise, 44 px hit area, motion only under `prefers-reduced-motion: no-preference`).
- It also sets `data-copy="<text>"` on the element, so the text is visible in the DOM and to tests.
- Script and style policy are unchanged: no inline script, no eval, no HTML parsing (Trusted Types stay enforced), no request.

Prerender (`tools/site-render.ts`): the element gets `data-copy="<text>"` and `hidden`. A copy button does nothing without JavaScript, so the static page hides it rather than showing a dead control (`aria-disabled` would still put an unusable button in the reading order); the command text next to it stays visible and selectable, and the label of the hidden button is left out of the page's plain text. The runtime's first render replaces the prerendered tree with the visible button, so no script has to "unhide" anything. The stylesheet has `.copy[hidden]{display:none}` because the author rule `display:inline-flex` would otherwise override the attribute.

Writing it from the generator: the template line `^TEXT` writes `COPY` with the expansion of TEXT (variables `$var$` and the usual escapes work) for the open element:

```
<button
+type button
+class copy
+aria-label Copy the install command
^curl -fsSL https://a0lang.com/install.sh | sh
"Copy
>
```

Only `$`, `{` and `\` are special in TEXT. Programs written by hand use the same two commands the generator emits: `write io 14`, then a `text` literal and `puts` of it, as for `TEXT` (word 2).

Tests: `test/copy.test.ts` generates a fixture template, checks the stream through the interpreter and a compiled wasm module (the module `site/app.ts` runs) and the prerender, and checks the handler's shape; the click is also verified in headless Chrome (clipboard permission granted, click, `navigator.clipboard.readText()` equals the text, `data-copied` set then cleared, no CSP violation).
