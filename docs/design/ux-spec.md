# a0lang.com UX spec (2026-10-07)

Principle: each element states its purpose (its job for one reader) and place (why here, in this order, at this size); no job means cut or merge. Evidence: live Chrome at 1280x800 and 390x844 plus site/gen sources. The live title still reads "the programming language built for AI", the repo "a small language AI models can edit" (deploy lag).

## 1. Readers and journeys

| Reader | Question | Path | Moment to act | Today |
|---|---|---|---|---|
| Developer, 60 s | Is this for me, and can I try it now? | Home: statement, sample, Install | Copy install line within the first viewport | Headline is an h2 at y=896, Install pill y=1405, install commands y=3692; the first screen is rain, "A0 for AI" and the sentinel. |
| Engineer wiring an agent | How do I connect it? | Home "Connect your agent" then /docs/#connect | Copy `claude mcp add a0 -- a0 mcp .` | Absent from home; docs step 4 shows literal backticks in prose. |
| Skeptic | Is it true, and where does it lose? | Home loss line, /benchmarks, loss ledger | Open results/*.json for a figure; see the worst loss | Losses are on home (8 of 19, 4.31x mat4) but bench has no h1 in source and method is a wall of 5 paragraphs before any chart. |

## 2. Element table

| Element | Purpose | Place | Verdict | Concrete change |
|---|---|---|---|---|
| Header (brand, Docs, Benchmarks, Sponsor, X, GitHub) | Orient and let all three readers jump | Fixed top, 56 px | Change | Cut X and Sponsor (in the footer). Keep brand, Docs, Benchmarks, GitHub: fits 390 px (live clips the GitHub icon). |
| Wordmark "A0 for AI" (54-190 px) | Name the product | Currently the LAST thing in a 800 px hero | Change | Drop it; the header brand does that job and the hero opens with the h1. |
| Headline (today h2 at y=896) | Say what A0 is for | Must be first text, y<=160 | Change | Becomes h1 (see section 4). Hero height 800 to content height (about 520 desktop, 62svh mobile). |
| Subline | Say how, in one sentence, and what it is not for | Under h1 | Merge | Absorb the MIT/limits paragraph (y~570 in sample block); one subline, 2 lines max. |
| Code sample + sentinel | Prove "small and readable" | Right under the subline; sentinel overlaps it (screenshot: mesh drawn over `a mul p0 p1`) | Change | Sentinel never paints over `pre`; sample gets a copy button. |
| CTAs (Install, Benchmarks pill) | Next step | Today after the sample, 40 px high, ghost 280 px wide | Change | See section 3. |
| Sec "Is it as fast as C?" | Skeptic: speed, with losses | After "Connect your agent" | Keep, retitle | "Where A0 is slower than C". Lead sentence names the loss first. |
| Sec "How much does an edit cost?" | Agent engineer: cost | Next | Keep | Move the one-function 2.42x loss into the first sentence; today it is the last clause. |
| Sec "What does one source compile to?" | Developer: reach | Today a legend with no visual | Merge | Fold into the Install section as one line of targets; a legend with no chart has no job. |
| Sec "Try it" (install block) | The action | Today 4.6 screens down | Move up | Becomes section 2 (right after the hero) as "Install and connect". |
| Charts (3) | Compare, with losses | See section 5 | Change | Rules in section 5. |
| Rail / chips (docs, bench) | Where am I; jump | Left sticky rail (desktop), top chips (mobile) | Keep | Mobile chips: 16 px gutter, opaque background. |
| Footer | Licence, who, how measured | End | Change | Links 44 px tall with underline; keep method sentence; cut duplicated social links from header. |
| Docs Quick start | Install, run, edit, connect in order | Top of docs | Change | Step 4 becomes its own anchored block #connect with copy buttons; replace raw backticks with `code`; install shows ONE command per OS tab, not `brew` and `curl` both. |
| /benchmarks method block | Let the skeptic trust the method | First block, 6 lines of prose | Change | 5-row table (Machine, Date, Runs, Load gate, Baselines); prose in a details. |
| /benchmarks losses block | Show where A0 loses | Currently last chip "Where A0 loses" | Move up | Put "Where A0 loses" as the SECOND rail item, directly after Method. |

## 3. Call-to-action hierarchy

| Page | Primary (accent fill) | Secondary (outline) | Lives |
|---|---|---|---|
| Home | **Install A0** (copies the one-line install, then scrolls to #install) | **Connect your agent** | Hero, directly under the sample; repeated once at the end of the last section. |
| Docs | **Install A0** (anchor #quickstart) | **Connect your agent** (#connect) | Sidebar head. |
| Benchmarks | **Reproduce a result** (anchor to the commands) | **Where A0 loses** (anchor) | Top of method block. |
| 404 | **Go home** | **Read the docs** | Centered. |

"Benchmarks, including where A0 loses" is retired as a CTA: the header already links it and at 280 px it outweighs Install.

One accent-filled button per page.

### Copy-to-clipboard: runtime feature

Need: a general runtime capability, CSP-safe: `navigator.clipboard.writeText` inside a trusted click handler (user gesture), no inline script.

Protocol addition (comment in site/ui.a0, handler in site/app.ts):
- New word 14 `COPY n bytes`: applies to the open element (like ONCLICK); payload is the text to copy.
- `app.ts` case 14: on click, `writeText(text)`; on success set `data-copied="1"` for 1500 ms and update a polite `role="status"` span to "Copied"; on failure select the sibling `<code>` and set `data-copied="fail"`. No event goes to the program, so no re-render.
- A0 side: `fn copy io u32 -> io` in ui.a0 writes 14 plus the string.
- Label "Copy" becomes "Copied" in place (no toast); `button.copy` is 44x44 minimum.
- Test: grant clipboard-write, click, `readText()` equals the command; no CSP console error.

## 4. Information scent and order

Opening statement (h1, one sentence; each fact below exists in results/ or the documented limits): **"A0 is a small language for code that an AI agent edits one function at a time, with every edit checked before it lands; it has no floats, heap or recursion, so use C, Rust or TypeScript for those."**

Sub-line: "1.16x C's time (geometric mean, 19 test programs, slower on 8); on a one-function file 2.42x TypeScript's tokens."

| # | Section | Reader need | Hand-off (last line) |
|---|---|---|---|
| 0 | Hero: statement, sample, Install A0 / Connect your agent | What is it, can I run it | "Two commands and your agent is editing." -> Install |
| 1 | Install and connect (moved up from y=3692): install, then the MCP line, then targets in one line | Act | "Works? Then check whether you should trust it." -> Speed |
| 2 | Where A0 is slower than C (chart 1) | Honest speed | "Speed is not the point; edits are. What does an edit cost?" |
| 3 | What an edit costs (chart 2) | Token cost incl. 2.42x loss | "Cheap only if it is also caught: how fast?" |
| 4 | How fast a wrong edit is caught (chart 3) | The checked-edit promise | "Every number links to its file." -> /benchmarks |
| 5 | Footer: licence, method sentence, GitHub | Trust, exit | -> docs |

Home drops from 7 sections to 4 plus hero and footer (4,667 px to about 3,000); Targets merge into Install, the glossary moves to /docs/#words.

## 5. Visual system rules

| Rule | Value (testable) |
|---|---|
| Type scale | 12 (caption, 13 min on touch), 15 (body-small), 17 (body), 24 (h3), 32 (h2), 48 (h1 desktop) / 32 (h1 mobile); line-height 1.55 body, 1.15 headings; mono 14. Nothing else. |
| Measure | Prose max-width 68ch, never wider than 75ch or narrower than 45ch on phone; charts 820 px max. |
| Spacing scale | 4, 8, 16, 24, 40, 64 px only; section gap 64 desktop, 40 mobile; page gutter 16 px mobile. |
| Colour roles | Surface #000 and #0b0b0b (cards); text #ededed; muted #a0a0a0 (contrast >= 4.5:1 on surface); line #222. Accent #00ff41 ONLY for the A0 mark, the A0 bars and the primary button fill. Not for links, not for headings. |
| Charts | A0 bar solid accent; others outline 1 px #666, no fill; every bar labelled with name and value at the bar end; losses (A0 slower) carry the text "slower" in muted bold, never colour alone; bars sorted worst-for-A0 first when the chart is about speed. Value text >= 13 px. |
| Motion | Allowed: rain, sentinel, bar grow-in once (400 ms, on first view). Banned: hero rise, smooth scroll, hover transforms. `@media (prefers-reduced-motion: reduce)`: rain and sentinel stop, bars render at final width, `scroll-behavior:auto`. |
| Touch targets | >= 44x44 CSS px for every link, button, summary, chip (live: brand 27x32, icons 40x40, footer links 18 px high). |

## 6. States

| State | Behaviour |
|---|---|
| Loading | The prerender is the real page (FCP = LCP, CLS <= 0.007); hydration must not replace identical DOM; no `aria-live` on `main`. |
| No JS | `<noscript>` line: "Charts and the animation need JavaScript; every number and command is plain text." `html:not(.js) .hero{min-height:0}` removes the empty 800 px black screen. |
| 404 | Static `404.html` (today plain text, no navigation): header, "That page does not exist.", Go home, Read the docs. |
| Slow device | Sentinel governor (`quality` 25-100) halves the rain below 80, stops offscreen or hidden; p95 frame cost at 4x throttle under 12 ms (11.6 now). |

## 7. Implementation list (parallel by file)

| # | Item | Files | Size | Risk | Acceptance (headless Chrome) |
|---|---|---|---|---|---|
| 1 | Header diet and 390 px fit; 44 px targets | site/gen/style.css (header, pill, footer rules) | S | low | At 360/390/414: scrollWidth <= innerWidth; every `a,button,summary` rect >= 44x44. |
| 2 | Hero rewrite: h1 = statement, small brand, hero height by content, sample + two CTAs inside first viewport | site/gen/page.tpl (sec_hero, sec_pitch, sec_sample) | M | med | At 1280x800 and 390x844: h1 top < 160, Install button fully visible without scroll. |
| 3 | Reorder home: Install and connect to section 1, merge Targets, drop Words, add hand-off lines | site/gen/page.tpl | M | med | h2 order equals section 4; page height < 3,400 px at 1280. |
| 4 | COPY protocol word 14, status span, CSP-safe handler | site/app.ts, site/ui.a0 (header and helper), site/gen/tags.tpl (no new tag) | M | med | Click Copy: clipboard equals command; `data-copied` set then cleared in 1.5 s; no CSP console error. |
| 5 | Copy buttons on install, MCP line, sample; docs step 4 into #connect; fix raw backticks | site/gen/docs.tpl, site/gen/page.tpl | S | low | `document.body.innerText` has no "`"; 3 `button.copy` on home. |
| 6 | Bench: h1, method table, "Where A0 loses" second in rail, reduced rail gutter and opaque chips | site/gen/bench.tpl, site/gen/style.css (.rail only) | M | low | h1 count = 1; chip 2 text "Where A0 loses"; first chip left >= 16 px. |
| 7 | Chart rules: outline others, labels, "slower" text on losses | site/gen/style.css (.chart), page.tpl/bench.tpl row markup | M | med | Each `.lrow` has label and value text; A0 fill computed color #00ff41, others transparent with border. |
| 8 | Motion rules and reduced-motion block | site/gen/style.css (motion lines only), site/live.ts (pause offscreen, halve rain at quality<80) | S | low | With `reduce`: sentinel frames in 2 s = 0, `scroll-behavior` = auto, hero animation none. |
| 9 | Sentinel never over `pre` | site/live.ts, site/gen/style.css (.stage z-index, clip to hero) | S | low | Screenshot at scroll 1100: no mesh pixels inside the `pre` rect. |
| 10 | 404.html, `<noscript>`, aria-live off main | tools/site-build.ts | S | low | `curl /xyz` returns HTML with header and 2 links; no-JS home has noscript text; no `aria-live` on `main#app`. |
| 11 | Footer: underlined 44 px links | style.css (.foot) | S | low | axe link-in-text-block: 0 hits. |

Groups: page.tpl (2, 3, 5), docs.tpl (5), bench.tpl (6), style.css (1, 6, 7, 8, 9, 11; split by rule range: header/footer, chart, motion), app.ts + ui.a0 (4), live.ts (8, 9), site-build.ts (10, 12). Add to section 5: focus ring 2 px #ededed offset 3, hover only brightens, scrollWidth <= innerWidth at 360/390/414. Item 12: cache headers and one bundled live module (repeat visit < 5 KB).
