# a0lang.com live audit, 2026-10-07

Method: real headless Chrome (chrome.exe, new headless, software GL, no GPU) over CDP against the live site. Mobile = 390x844, DPR 2,
touch emulation, iPhone UA. Scripts live in the session scratchpad (`aud/`). All numbers are single runs unless noted; headless software
compositing caps frame rate at 30 fps in places, so frame pacing numbers are pessimistic.

## Prioritized findings

### 1. HIGH: header overflows the viewport at 390px on all three pages (GitHub icon cut off)
- Evidence: `innerWidth` reports 422 at a 390 device width (layout viewport grew by 32 px). `header.top` right=422, `nav.nav` w=398, `.hright` right=410,
  `a.ico-gh` right=410 against clientWidth 390. Screenshots show the GitHub glyph sliced at the right edge on home, docs and benchmarks. On a real
  iPhone this means either a zoomed-out page (min-scale) or a sideways pannable page. Landscape 844x390 is fine (scrollWidth 876 = innerWidth 876).
- Fix: `site/gen/style.css` lines ~422 and ~254/343 (the 480px and 640px nav rules). At <=480px the nav's min-content is 398 px (brand 27 + Docs + Benchmarks +
  80 px icons + gaps 8-12 + padding 12 x 2). Drop `.links a` to `.8rem` and `.links{gap:6px}`, `.nav{gap:6px}`, and add `.nav{min-width:0}` `.links{min-width:0;flex:1 1 auto}`; or hide the X
  icon below 400px (it is also in the footer). Add a regression probe `document.documentElement.scrollWidth <= innerWidth` at 360, 390, 414.

### 2. HIGH (a11y): `aria-live="polite"` on the whole `<main id="app">`
- Evidence: present in `site/index.html`, `docs.html`, `bench.html` and the prerender (`main#app[aria-live=polite]`). The page program re-renders this region
  (home: 693 DOM nodes mutate in the first 440 ms, bench up to 10,790 nodes), so a screen reader may announce hydration/re-render churn.
- Fix: remove `aria-live` from the three `site/*.html` shells (owner: the html templates emitted by `tools/site-build.ts`); put `aria-live` only on the one small status element that actually changes (e.g. the live sentinel readout).

### 3. MEDIUM: benchmarks page has no `<h1>`
- Evidence: axe `page-has-heading-one` (moderate) on /benchmarks; home h1 is "A0", docs h1 is "Docs". The prerendered bench HTML starts at `<h2>`.
- Fix: `site/gen/bench.tpl` add `<h1>Benchmarks</h1>` (visually the same as docs). Also home: the real headline ("A small language AI models can edit...") is an `<h2>` under h1 "A0"; consider h1 = headline for SEO/outline (`site/gen/page.tpl`).

### 4. MEDIUM (a11y): in-text links distinguishable only by colour (axe `link-in-text-block`, serious, 3 nodes on every page)
- Evidence: footer paragraph links `@joesimo`, `GitHub`, `Sponsor` (`p:nth-child(2) > a`) have 1.61:1 contrast against surrounding text (need 3:1) and no underline (`.foot a{text-decoration:none}`).
- Fix: `site/gen/style.css` line 140: `.foot a{text-decoration:underline;text-underline-offset:3px}` (or border-bottom). Also fixes the tiny tap area below.

### 5. MEDIUM (a11y): scrollable code block lacks keyboard-reachable content for axe (`scrollable-region-focusable`, serious, home `#try > pre`)
- It IS tab-focusable (outline `auto 1px`, only 1 px, colour rgb(238,238,238)), axe still flags it. Fix: add `tabindex="0"`, `role="region"` and `aria-label="Install commands"` to the `#try` `<pre>` in `site/gen/page.tpl`, and give `pre.code:focus-visible` a 2px outline in `style.css`.

### 6. MEDIUM: no caching for the app shell, wasm and JS (every visit revalidates)
- `curl -sI`: `/page.wasm`, `/app.js`, `/*.html`, `/sentinel.wasm`, `/live/*.js`, `/wire.js`, `/favicon.svg`, `/results/*` all `Cache-Control: public, max-age=0, must-revalidate`. Only `/fonts/*` is `max-age=31536000, immutable` (and is brotli-less: woff2 already compressed, fine).
- Transfer on a cold visit: home 222,663 B over 16 requests (fonts 141 KB of that; page.wasm 25.9 KB, sentinel.wasm 15.6 KB, app.js 8.3 KB, 7 small `/live/*.js` files 1.7-3.3 KB each); docs 197,311 B / 9 req; bench 238,286 B / 9 req (bench.wasm 58.4 KB). Home needs 16 requests, 9 of them for live.js and its 6 modules plus sentinel.wasm: a waterfall of small modules.
- Fix: `tools/site-build.ts` VERCEL `headers` (and therefore ROOT_VERCEL): add `{source:'/(.*)\\.wasm', ...}` and `/(.*)\\.js` with `Cache-Control: public, max-age=300, stale-while-revalidate=86400` (cheap, safe) or content-hash the filenames and use `immutable`. Optionally bundle `site/live.ts` + `site/live/*.ts` into one file (7 requests -> 1) in the same build script. Add `<link rel=modulepreload>` for live.js and `<link rel=preload as=fetch crossorigin>` for sentinel.wasm.

### 7. MEDIUM: `prefers-reduced-motion` stops the sentinel but not everything
- Evidence (home, emulated `reduce`): sentinel frames in 2 s: 129 -> 0 (good, loop stops, `running:true` but idle; rain canvas freezes, screenshots a/b identical). Remaining: `html{scroll-behavior:smooth}` still computes `smooth` under reduce; the hero `rise` animation (`H1.name`, `P.tag`) is still declared (it finishes in 0.6 s but is not disabled); bench bar `transition` is disabled correctly.
- Fix: `site/gen/style.css` line 5 / 200 / 415: add `@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.hero .name,.hero .tag,.hero .sub{animation:none}}`.

### 8. MEDIUM (mobile UX): first viewport on phones has no CTA and no readable value proposition
- Evidence (390x844): `h1` "A0 / for AI" at y=661..712 (54 px type) in the lower third; viewport above it is rain + sentinel only. The real headline `<h2>` and the Install / Benchmarks pills are 1 screen down (pills at ~y 1490 of 844). Interactive items in the first viewport: only header links.
- Fix: `site/gen/style.css` `.hero` height on mobile: `@media(max-width:640px){.hero{min-height:0;height:62svh}}` so the headline block and "Install" pill land above the fold, or move the pill row into the hero in `site/gen/page.tpl`. Use `svh` not `vh` (home `.stage` is fixed at 914 px tall at 844 viewport: `DIV.stage` h=914, `CANVAS` 422x914, i.e. it follows the large viewport and resizes when browser chrome hides, risking resize jank/CLS in `site/live.ts onResize`).

### 9. LOW/MEDIUM: tap targets under 44 px (mobile, listed)
Home: `a.brand` "A0" 27x32; header "Docs" 32x44 (width <44); `a.ico-x`, `a.ico-gh` 40x40; `a.pill` Install 57x34, `a.pill.ghost` 251x34 (height 34); footer `@joesimo` 61x18, `GitHub` 43x18, `Sponsor` 52x18.
Docs: brand, Docs, two icons, "Configurations for other agents" 228x21, 3 footer links (18 px high).
Bench: brand, Docs, icons 40x40, 5 `summary` toggles ("Show all 4x languages") 358x41, 3 footer links.
- Fix: `style.css`: `.pill{min-height:44px}`, `.ico{width:44px;height:44px}`, `.brand{min-width:44px;min-height:44px;display:inline-flex;align-items:center}`, `.foot a{display:inline-block;padding:13px 6px}`, `details>summary{min-height:44px}`. (Header links already have `min-height:44px` at line 359; widen padding for Docs.)

### 10. LOW: text below 13 px
- Mobile: only 2 text nodes (both home pill labels, `a.pill` and `a.pill.ghost`, 12.8 px = .8rem at <=640px, line 356). Docs 0, bench 0. Fix: raise `.pill` to `.875rem` at line 254/356.

### 11. LOW: mobile sticky chips rail (benchmarks)
- `nav.rail` is `position:sticky; top:56px; height:57px; width:390` and works under the 56 px header (screenshots show it pinned, "Native speed" active chip green). Issues: first chip "Method" touches the left screen edge (0 px gutter, border clipped), and body text bleeds through the rail's translucent background (chip row is readable but headline text is visible behind it). Fix: `.rail{padding-left:16px;scroll-padding-left:16px}` and a more opaque background (`style.css` `.rail`).
- 55+ `td/th` are `position:sticky` (first column), fine; wide tables (`table.ops.rank`, 540-583 px) sit in `.tblwrap` scrollers and legible; bar charts and tables screenshot cleanly at 390 (labels wrap, numbers readable).

### 12. LOW (SEO/sharing)
- `twitter:card` is `summary` and there is NO `og:image` / `twitter:image` on any page (home, docs, bench) so shares render without a preview image. Fix: add a 1200x630 PNG to site/ and emit `og:image`, `og:site_name`, `twitter:image`, `twitter:card=summary_large_image` in `site/gen/*.tpl` / `tools/site-build.ts`.
- 404: Vercel plain-text "The page could not be found / NOT_FOUND" (79 B, text/plain, no nav, no link home). Fix: emit `site/dist/404.html` (a page with the header and a link to / and /docs/) in `tools/site-build.ts`.
- `sitemap.xml` has no `<lastmod>` and lists non-HTML (`/llms.txt`, `/primer.txt`); harmless. `robots.txt` (63 B) OK. Also no JSON-LD (SoftwareSourceCode/WebSite) -- optional.
- Cache for `/robots.txt`/`/sitemap.xml` is `max-age=0` and they are not compressed (tiny, fine).

### 13. INFO: performance (cache disabled, 1280x800 unless noted; software rendering)
| page | FCP/LCP ms | LCP element | CLS | long tasks (start,dur ms) | JS heap | nodes | h1 exists |
|---|---|---|---|---|---|---|---|
| home | 360 / 360 | `a` (brand text) | 0 | 1 (123, 171) | 1.8 MB | 693 | 295 ms |
| docs | 676 / 676 | `p` | 0.007 | 1 (573, 76) | 1.1 MB | 682 | 573 ms |
| bench | 624 / 624 | `p.take` | 0.0009 | 3 (387,211) (680,76) (1023,92) | 1.1 MB | 6,309 | n/a (no h1) |
| mobile home | 248 / 368 | `a` | 0 | 1 (243, 73) | 2.2 MB | 693 | 214 ms |
| mobile docs | 436 / 480 | `pre.code` | 0 | 0 | 1.2 MB | 684 | 418 ms |
| mobile bench | 276-544 (3 runs; one outlier 2,640) | `p.take` | 0 | 2 each (~250 ms and ~75-100 ms) | 1.2-1.4 MB | 6,309-10,790 | n/a |
- The prerender paints first (FCP == LCP, h1 present in the served HTML), then the wasm page program re-renders (last DOM mutation at 443 ms home, 862 ms docs, 1,115 ms bench desktop). No layout shift from the swap (CLS <= 0.007): excellent.
- Bench has a 250 ms main-thread task right after load (mobile, un-throttled!) plus 70-110 ms tasks: the page program rebuilds ~6-10 k nodes. At 4x CPU throttle this will be ~1 s. Fix: `site/app.ts` should skip re-rendering when the prerendered DOM already equals the program output (hydration check), or render sections lazily (`content-visibility:auto` on `section` in `style.css`, only 8 `details` open).
- Mobile bench single outlier LCP 2,640 ms (first run) vs 276-544 ms in three reruns: the first request after cold start, not reproducible; ignore but watch.

### 14. INFO: sentinel frame cost (home, `a0Live.stats()`, 5 s of mouse movement)
- 1x: JS frame cost avg 1.35-1.44 ms, p95 1.7-2.2 ms, max 7.9-8.9 ms, interval avg 16.7 ms; rAF intervals p50 16.7, p95 33.3 (software compositing; 30 of 343 frames at 33 ms), max 33.4; zero long tasks; ScriptDuration ~11% of wall.
- 4x CPU throttle: cost avg 6.3 ms, p95 11.6, max 42.3; rAF interval p50 33.3, p95 50.1, p99 83, max 183; 17 long tasks (50-92 ms) in 21 s; stats shows `quality:60` so the adaptive quality governor engages (good). On a 4x-slower phone this means ~30 fps and some 50-90 ms stalls: consider a lower rain count (`site/live.ts`) when `quality<80` and pausing the loop when the hero is offscreen (home scrolled past the stage shows `running:true` frames continuing: 1,019 frames after scroll tests).

### 15. INFO: touch behaviour (sentinel and scrolling)
- Listeners (recorded via patched addEventListener): `pointermove` x2, `pointerdown`, `pointerup`, `pointercancel` on window, `pointerleave` on html, `scroll` on window -- ALL `{passive:true}`; no `touchstart/touchmove/wheel` listeners exist, so nothing can block scrolling.
- Swipes via `Input.dispatchTouchEvent` (12 moves x 30 px = 360 px finger travel, 5 swipes): scrollY change 345, 345, 345 (+ a fling to 498), 345 px per swipe; inertial fling continues in the 3rd (275 first swipe includes warm-up). `touch-action` is `auto` on body, html, canvas and `.stage`: scrolling smooth.
- Sentinel: finger at (110,205) moved the mesh centre to about (158,240) CSS px with visible lag (follows, eases toward touch); stats keep running (frames +35 during horizontal touch). Screenshot `shots/touch-hold.png`.
- Orientation (844x390): no horizontal overflow on any page (scrollWidth == innerWidth 876), home h1 at y=206 inside the 390 px height; bench has no h1. 

### 16. INFO: no-JS (`Emulation.setScriptExecutionDisabled`)
- Static prerender reads well on all three: home h1 + 7 `h2`, 3,678 chars of text, 2 code blocks; docs 8,901 chars, 11 `h2`, 11 rail links, 10 `pre`; bench 31,724 chars, 12 `h2`, 8 tables, 5 `details`, 16 bar `.chart` elements all visible (CSS bars, no canvas).
- Missing without JS: rain canvas and sentinel (expected, 0 canvases), home sticky rail (0 links vs 11 on docs/bench; home has none anyway), the hero looks empty for the whole first screen (screenshot `shots/nojs-home.png`: "A0 ... for AI" at y=580-690 on a black 800 px screen with the sub-copy below the fold). No `<noscript>` anywhere. Fix: none needed; optionally hide `.stage` space (`hero{min-height:50vh}` via `html:not(.js)`) in `style.css`.

### 17. INFO: keyboard
- Tab x40 on home: skip link (first stop, green 2 px outline, off 2 px, visible) -> brand -> Docs -> Benchmarks -> Sponsor -> X -> GitHub -> Install -> Benchmarks pill -> `pre#try` -> @joesimo -> GitHub -> Sponsor -> BODY (leaves the document) -> repeats. No focus trap; order matches visual order. Outline widths: 2 px solid rgb(189,189,189) (off 3) on links, green rgb(0,255,65) off -4 on icon buttons, 1 px `auto` on the `pre` (weak). No invisible rings (every stop `:focus-visible` true, outline-style not none). Header is fixed so `scroll-padding-top:80px` keeps focused items out from under it.
- Contrast (computed WCAG ratios for 27 / 20 / 56 unique visible text styles on home/docs/bench against the effective composited background, large-text threshold 3:1): 0 under 4.5:1 and none within 1.5 of the threshold. axe lists `color-contrast` as incomplete for 47 / 83 / 77 nodes because home text is over the canvas; my pixel-free calc treats the page background (#000-ish) as base. The rain is dim green (<= ~10% luminance), so no practical risk, but a real-pixel check on the hero is advisable.

## What is already excellent
- Static prerender: FCP == LCP at 250-680 ms, hydration swap has CLS <= 0.007, content is complete with JS off.
- Brotli on HTML, wasm (202,235 -> 25,766 B), app.js (23,117 -> 8,076 B); fonts immutable one-year cache; whole home page 223 KB; JS heap 1-2 MB.
- Strict CSP, nosniff, DENY framing, referrer and permissions policies; canonical, description, og:title/description/url on every page; robots.txt, sitemap.xml, llms.txt (+primer, docs, full guide) all reachable and well formed.
- All input listeners passive, no touch/wheel handlers; swipes track finger 1:1 (345 px per 360 px); sentinel follows touch; adaptive quality governor; loop stops under `prefers-reduced-motion`.
- Skip link, logical Tab order, no traps, visible focus rings, text >= 13 px almost everywhere (2 exceptions on mobile), zero contrast failures, no horizontal overflow in landscape, charts are real HTML/CSS (no canvas) and tables remain legible at 390 px.
- axe: only 3-4 rule hits per page, none critical; no missing alt, labels, lang or landmark errors.
