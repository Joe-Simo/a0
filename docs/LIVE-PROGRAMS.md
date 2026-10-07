# Live programs: investigation and design (phase 1)

This note records what A0 and the a0lang.com host runtime provided before the live-program
capabilities, what was missing for an interactive, frame-driven, page-aware A0 program (the
"A0 Sentinel"), and the design chosen. It is a design record, not a benchmark: it contains no
performance claim. Measurements of the finished feature are in `results/sentinel-frame-cost.json`.

## What exists today

### The language

- Types are `u32`, `bool`, `io`, fixed arrays (`u32x4`, `u32x8x8`, up to 65536 elements per
  dimension) and records. There is no float, no signed integer, no 64-bit integer, no heap,
  no recursion and no mutation: an aggregate is a value and `set` returns a copy (the wasm
  emitter updates an unshared owned array in place, see `src/wasm.ts`).
- Control flow is `select` (both arms computed) plus `fold` and `loop`, whose body is a named
  function. Literals are decimal u32 only; a negative number is written as its two's complement.
- `use "file.a0"` links another file into one namespace (site programs share `site/ui.a0`).
- Signed and fractional numbers: none in the language. The site generator keeps its own integer
  conventions (Q20 logarithm tables, ties to even; `site/gen/sgvars.a0`), private to that tool.
  There was no reusable signed/fixed-point library, no trigonometry, no square root, no
  pseudo-random generator.

### The page runtime (`site/app.ts`, `site/wire.ts`)

- One A0 io program per page (`site/page.a0`, `site/docs.a0`), exported as `a0_session`. The
  host feeds `event x y text state` words in and interprets a word stream out (OPEN/TEXT/CLOSE/
  ATTR/ONCLICK/STATE/ONSUBMIT/STYLE/GRID/TIMER/SIZE/SHADER). Every event re-renders the DOM.
- Pointer and touch input: not available to A0. `ONCLICK` sends an event number, `GRID` sends
  a cell. A shader scene listens to `pointermove` itself, in `app.ts`, for its `u_mouse`.
  Touch is not distinguished from mouse; pen likewise. No down/up/move stream, no scroll.
- Frame loop: A0 has no `requestAnimationFrame`. It has `TIMER ms event` (a `setTimeout` that
  re-runs the whole session and re-renders the DOM), which is unsuitable for 60 FPS.
  `app.ts` uses `requestAnimationFrame` itself for the shader scene and the count-up numbers.
- Drawing: `SHADER` (a GLSL ES 3.0 fragment shader, text in the stream, full-element quad,
  `u_res`/`u_time`/`u_mouse`/`u_font`) and `GRID` (a 32-column bitmap on a 2D canvas). Neither
  is a general drawing surface: no lines, circles, gradients, no per-frame draw list.
- Geometry: no element geometry is visible to A0. `app.ts` reads rectangles for the scroll-spy
  only (inside the host, with `IntersectionObserver` plus `getBoundingClientRect`).
- Resize / visibility / reduced motion: handled inside `app.ts` for the shader scene only
  (`IntersectionObserver`, `document.hidden`, `matchMedia('(prefers-reduced-motion: reduce)')`,
  a ResizeObserver). A0 programs cannot observe any of them.
- Typed buffers: the host copies word arrays in and out of wasm memory (`runSession`); the
  capacities are fixed per build (`ioInputCapacity`, `ioOutputCapacity`, 1024 and 131072 words
  for the page programs).
- Content security: `script-src 'self' 'wasm-unsafe-eval'`, no inline script, `style-src`
  allows inline style. Everything must be a same-origin module or the wasm file.

### The site

- Home page: a fixed matrix-rain shader canvas (`.stage`, `z-index:-1`), a header (`.top`,
  `z-index:20`), a hero with the "live" edit demo (`#live`, lines `.ln`), then cards (`.card`,
  `.tcard`, `.tile`), charts built from rows (`.lrow`, `.track`, `.fill`), tables (`.tblwrap`),
  code blocks (`pre.code`), and a left rail (`.rail`).
- There is no live compiler demo and no IR or dataflow visualization. The closest real
  structures are the hero edit demo (`#live .ln`), code blocks, the benchmark charts and the
  cards. The sentinel treats those as its "A0 content" and does not invent others.

## What was missing

1. A frame loop an A0 program can own (one `requestAnimationFrame` loop, `dt`, visibility
   pause, hidden-tab resume without a time jump).
2. Unified pointer input (mouse, pen, touch) delivered as data: position, pointer type, down,
   tap, leave, plus scroll offsets, with `passive` listeners.
3. A general drawing surface driven by a draw list (lines with width and color, discs with
   gradients, glows, paths), with a device-pixel-ratio cap and an adaptive render scale.
4. Cached element geometry: a registry of elements chosen by selector, measured on load,
   resize, mutation and observer callbacks, never every frame, with page-relative rectangles.
5. Environment signals as input: viewport size, device pixel ratio, reduced motion, coarse
   pointer, visibility, measured frame cost.
6. Signed fixed-point math, integer square root, sine/cosine and arctangent tables, a
   deterministic pseudo-random generator, with tests against an exact oracle.
7. A way to give a live program larger io buffers than the page programs have.

## Design

A *live program* is an ordinary A0 io program with one exported function, `frame`
(`a0_frame` in the wasm). The generic host module `site/live.ts` (with `site/live/*.ts`)
mounts it on request (`data-live="<wasm url>"` on the page root, plus the buffer sizes) and runs
the loop. Nothing in the host names any particular program.

Per frame the host writes one word block: a header (time step, flags, viewport, scroll,
pointer, tap, frame cost, quality hints), the cached geometry table, and the program's own
state words (the program returns its state as a `STATE` command, so A0 keeps state without
memory). The program answers with a word stream: `STATE`, `WATCH` (register a selector and a
kind for the geometry registry), `QUALITY` (render scale request), and a draw list for a 2D
canvas (`CLEAR`, `LINE`, `DISC`, `RING`, `GLOW`, `SPHERE`, `PATH`). Coordinates are Q16.16
signed fixed point in CSS pixels.

Why canvas 2D: the sentinel is thin lines, small shaded discs and soft glows; 2D canvas is
GPU-accelerated in current browsers, needs no hand-written shader (the one GLSL file the site
has is the matrix rain), has exact line-width control, and keeps the host protocol small and
general. A WebGL path would add a shader the program cannot author in A0. The canvas is
`position:fixed`, `pointer-events:none`, `aria-hidden`, below the header, with the clear
restricted to the previous frame's drawn bounds.

Geometry is separated from physics: the registry observes elements with
`IntersectionObserver` (near the viewport), `ResizeObserver` (each near element and the page
body) and a throttled `MutationObserver`; it stores page-relative integer rectangles and only
rebuilds the table the program sees when something changed or scrolling stopped. Scroll updates
two numbers (`scrollX`, `scrollY`). Anchors in the program name an element id and an offset in
that element, so they follow layout shifts and scrolling.
