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
  ATTR/ONCLICK/STATE/ONSUBMIT/STYLE/GRID/TIMER/SIZE/SHADER/COPY; the reference is
  `docs/UI-PROTOCOL.md`). Every event re-renders the DOM, except COPY, which only writes the
  clipboard and sends no event.
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

## Reference (phase 2)

Generic parts, none of which names the sentinel:

- `site/lib/fx.a0`: signed Q16.16 math (`fx_mul`, `fx_div`, `fx_sqrt`, `fx_hyp`, `fx_unit`,
  `fx_sin/cos/atan2` in turns, `fx_rng`, `fx_hash`, signed compare, arithmetic shift).
  Tested against a BigInt oracle on the interpreter and wasm (`test/fx.test.ts`).
- `site/lib/frame.a0`: the protocol constants, `fr_rdhdr`, and the command writers.
- `site/live.ts` (mount, loop, visibility, reduced motion, adaptive render scale, `window.a0Live.stats()`),
  `site/live/words.ts` (protocol), `canvas.ts` (overlay and draw-list executor, dirty-rect clear, dpr cap),
  `pointer.ts` (unified, passive pointer input and taps), `geometry.ts` (observer-driven geometry
  cache), `program.ts` (wasm exchange). Tests: `test/live.test.ts`.
- `tools/live-programs.ts` lists live programs and their buffer sizes; `tools/site-build.ts`
  compiles them with the A0 emitter and checks the bytes against `src/wasm.ts`.

A page mounts a program with `data-live`, `data-live-in`, `data-live-out`, `data-live-rows` on the
root element. After the geometry table (`rows` x 7 words) the input holds the state count and the
state; the program returns its state with the `STATE` command, so A0 keeps state without memory.

## The A0 Sentinel (phase 3)

`site/sentinel/*.a0`: layout, env (geometry table access), body (pursuit spring, patrol, heading),
tentacle (position-based chains), anchor (candidate scoring), locomotion (tentacle states, taps),
life (core activity, graph links, quality), render (draw list), main (`frame`). Eight chains of
6-9 joints with their own length, stiffness, damping, drift frequency, reach and preferred element
kind. Body: spring-damper toward a point kept 60-120 px from the pointer; anchored chains pull and
brake it through a share of the root correction. Tentacles search the cached geometry for corners and
boundary points of real elements, approach through the solver, are pinned to an element id plus offset
while attached (so scrolling and layout changes carry the anchor), and release on hold time, tension,
distance or a missing element. Touch: finger as a temporary target; a scroll gesture (scroll delta or
`pointercancel`) suspends chase; taps on controls make one to three free tentacles reach for them.
Reduced motion: the pose is settled once off-screen of time and never moves again.

Measured host cost per frame is in `results/sentinel-frame-cost.json`.

Known gaps: no WebGL path (canvas 2D by design); the page has no compiler demo or IR view, so the
"near a live compiler" behaviour is only the hero edit demo (`#live .ln`, treated as code: longer
holds, a brighter core) and the code blocks; the hero matrix rain is unchanged (a lower opacity
would help the sentinel read as a distinct object). Frame cost was measured in headless Chrome with
software rendering, not on a physical GPU or a slow phone, and the adaptive-quality steps never
triggered there.

## Look and landings (second pass)

The draw list gained one general primitive, QUAD (op 18, a filled four-point polygon; repeat a point for a triangle). The sentinel draws every limb segment as a tapered quad with alternating gunmetal shades, an accent ring at each joint, a highlight along the lit edge and a soft contact shadow; the end-effector is a three-prong claw (a blade on two limbs) that opens while searching and reaching and closes on landing, with a ring, a spark and a glint along the held element's edge drawn in the overlay only. The body is an armoured shell (eight plates, a lit rim, a core eye, four small pulsing lights). Readability: the body target is pushed out of text, heading, code and control boxes (two passes), and a limb whose middle joint is over text or code is drawn fainter. Frames from the review are in docs/design/sentinel/. Measured cost: results/sentinel-frame-cost.json.

## Walking (third pass)

The sentinel is a walker, not a hover: the body target is derived from its planted feet (the mean of the points one stance height above each foothold, along the edge normal, with a small lean toward the direction of travel); with fewer than two planted feet it heads for the point above the nearest component edge. The pointer or finger only chooses where to step: footholds are scored for being ahead, on top edges, away from the cursor and from other feet. A foot lifts of its own accord only when more than three are planted and it is the trailing one; releases from tension, distance or a vanished element are forced. Body speed is capped (about 700 px/s, a scuttle). Limits seen in review: a gap wider than the longest reach (the home page hero has about 200 px of empty space under its heading) is crossed slowly and not always; in dense text the body can still overlap text where boxes touch; average speed is a slow crawl, not a run. Frames: docs/design/sentinel/crawl-sequence.png (hero to the code block edge, then along it).

Load and idle: the program may send CADENCE n (run every n-th animation frame; pointer and scroll input wake it immediately). The sentinel asks for 2 at quality 1 and 3 at quality 0 (the quality governor steps down after 20 frames above 3 ms average and up after 500 frames below 1.1 ms), and for 3 when it has been idle for 5 s and is nearly still. Re-measured at 1x, 4x and 6x CPU throttle in results/sentinel-frame-cost.json.

## Purpose and place

Purpose: the sentinel mirrors what A0 does, one unit at a time. A foot that grips a code block or a chart row is a unit being checked: the core brightens, one cyan ring leaves it on arrival, the brightness holds while the grip lasts and fades on release. The only link kept is a thin line between two feet that grip the same code block (a relation that exists on the page). Removed because they served neither purpose nor place: the four secondary body lights, the random graph links between joints (their spawner is switched off and the code is dead weight to delete later), and dependency lines between unrelated blocks. Place: it lives on the ledges of components, body kept out of text, code, headings and controls, so the Install and Benchmarks buttons are footholds, never covered.
