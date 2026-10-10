/**
 * Generic browser runtime for an A0 page program (a0lang.com).
 *
 * The page is one A0 io program (site/page.a0 or site/docs.a0 with what it
 * uses), compiled to freestanding wasm32 through C. Everything on the page, including its
 * stylesheet, its layout, its buttons, the text it computes, the timer, and the persisted
 * state, comes from the word stream that program writes. This file knows nothing about the
 * page: it feeds events in, interprets the A0 UI protocol out, and builds DOM.
 *
 * Input words:  event x y ntext text[ntext] nstate state[nstate]
 *   text is the current bytes of the page's input or textarea (at most TEXT_CAP), state is
 *   what the last render's STATE command left; together they fit IN_CAP words.
 * Output words: 1 OPEN tag | 2 TEXT n bytes | 3 CLOSE | 4 ATTR key n bytes | 5 ONCLICK event
 *               6 STATE n words | 8 ONSUBMIT event (Enter in an input, Ctrl/Cmd+Enter in a
 *               textarea, sends the event) | 9 STYLE n bytes | 10 GRID event rows row...
 *               11 TIMER ms event | 12 SIZE prop percent (1 width, 2 height, 3 left, 4 bottom)
 *               13 SHADER n bytes (a GLSL fragment shader drawn on a canvas in the open element)
 *               14 COPY n bytes (the open element copies the bytes to the clipboard when activated;
 *               no event goes to the program; see docs/UI-PROTOCOL.md)
 * Tags and attribute keys are small integer tables shared with the program (see page.a0).
 */
import { readBytes, safeHref } from './wire.js';
// The same capacities as tools/site-build.ts gives the C io struct (ioInputCapacity/ioOutputCapacity).
const IN_CAP = 1024;
const OUT_CAP = 131072;
/** Bytes of the input field sent with an event: 3 + 1 + TEXT_CAP + 1 + state words <= IN_CAP. */
const TEXT_CAP = 480;
async function load(url) {
    const { instance } = await WebAssembly.instantiateStreaming(await fetch(url), {});
    return instance.exports;
}
/** Run one io session: input words in, output words + result out (C io struct layout). */
function runSession(exp, entry, input) {
    const e = exp;
    const base = e.__heap_base.value;
    const needed = base + (IN_CAP + 2 + OUT_CAP + 1) * 4;
    if (e.memory.buffer.byteLength < needed)
        e.memory.grow(Math.ceil((needed - e.memory.buffer.byteLength) / 65536));
    const words = new Uint32Array(e.memory.buffer, base, IN_CAP + 2 + OUT_CAP + 1);
    words.fill(0);
    words.set(input.slice(0, IN_CAP), 0);
    words[IN_CAP] = Math.min(input.length, IN_CAP);
    const fn = exp[entry];
    const result = fn(base) >>> 0;
    const nout = words[IN_CAP + 2 + OUT_CAP];
    return {
        output: Uint32Array.from(words.subarray(IN_CAP + 2, IN_CAP + 2 + Math.min(nout, OUT_CAP))),
        result,
    };
}
// --- A0 UI protocol -------------------------------------------------------------
const TAGS = {
    1: 'h1',
    2: 'p',
    3: 'button',
    4: 'code',
    5: 'div',
    6: 'span',
    7: 'ul',
    8: 'li',
    9: 'a',
    10: 'pre',
    11: 'h2',
    12: 'input',
    13: 'section',
    14: 'nav',
    15: 'h3',
    16: 'strong',
    17: 'footer',
    18: 'header',
    19: 'table',
    20: 'tr',
    21: 'td',
    22: 'th',
    23: 'small',
    24: 'h6',
    25: 'b',
    26: 'i',
    27: 'textarea',
    28: 'details',
    29: 'summary',
    30: 'caption',
};
const ATTRS = {
    1: 'id',
    2: 'class',
    3: 'href',
    4: 'type',
    5: 'placeholder',
    6: 'aria-label',
    7: 'title',
    8: 'aria-labelledby',
    9: 'role',
    10: 'scope',
    11: 'aria-hidden',
    12: 'tabindex',
};
const decoder = new TextDecoder();
const encoder = new TextEncoder();
function drawGrid(canvas, rows) {
    const ctx = canvas.getContext('2d');
    const style = getComputedStyle(canvas);
    const n = rows.length;
    const cell = canvas.width / 32;
    ctx.fillStyle = style.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = style.color;
    for (let r = 0; r < n; r += 1) {
        const row = rows[r];
        for (let c = 0; c < 32; c += 1)
            if ((row >>> c) & 1)
                ctx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
    }
}
/** Running shader scenes; each is stopped before the page re-renders. */
const scenes = [];
/**
 * The glyph atlas every scene may sample as `u_font`: 64 characters of Geist Mono, white on
 * transparent, in a 16 x 4 grid of square cells. Built once, after the font has loaded.
 */
const ATLAS_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<>=+-*/:;|$#@%&?!{}[]()~^_.,Z';
let atlasPromise;
function glyphAtlas() {
    atlasPromise ??= (async () => {
        const cell = 32;
        const font = `500 ${cell - 6}px "Geist Mono", ui-monospace, monospace`;
        try {
            await document.fonts.load(font);
        }
        catch {
            // the fallback monospace face is drawn instead
        }
        const c = document.createElement('canvas');
        c.width = 16 * cell;
        c.height = 4 * cell;
        const ctx = c.getContext('2d');
        if (ctx === null)
            return null;
        ctx.font = font;
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < 64; i += 1)
            ctx.fillText(ATLAS_CHARS[i] ?? '0', (i % 16) * cell + cell / 2, Math.floor(i / 16) * cell + cell / 2);
        return c;
    })();
    return atlasPromise;
}
const QUAD_VS = `#version 300 es
in vec2 a;
void main(){gl_Position=vec4(a,0.,1.);}`;
function mountShader(el, fragment) {
    const canvas = document.createElement('canvas');
    canvas.className = 'scene';
    canvas.setAttribute('aria-hidden', 'true');
    el.appendChild(canvas);
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
    if (gl === null)
        return;
    const shader = (type, src) => {
        const sh = gl.createShader(type);
        if (sh === null)
            return null;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(sh));
            return null;
        }
        return sh;
    };
    const vs = shader(gl.VERTEX_SHADER, QUAD_VS);
    const fs = shader(gl.FRAGMENT_SHADER, fragment);
    const prog = gl.createProgram();
    if (vs === null || fs === null || prog === null)
        return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(prog));
        return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uMouse = gl.getUniformLocation(prog, 'u_mouse');
    gl.uniform1i(gl.getUniformLocation(prog, 'u_font'), 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let mouse = [0.5, 0.5];
    let visible = true;
    let frame = 0;
    const onMove = (ev) => {
        mouse = [ev.clientX / innerWidth, 1 - ev.clientY / innerHeight];
    };
    const size = () => {
        // The scene is soft glow art: render at most ~1 megapixel and let the browser scale it.
        const scale = Math.min(1, Math.sqrt(1000000 / Math.max(1, el.clientWidth * el.clientHeight)));
        const w = Math.floor(el.clientWidth * scale);
        const h = Math.floor(el.clientHeight * scale);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
    };
    const t0 = performance.now();
    const draw = () => {
        size();
        gl.uniform2f(uRes, canvas.width, canvas.height);
        // Reduced motion shows one fixed moment of the scene instead of the start (often empty).
        gl.uniform1f(uTime, still ? 12 : (performance.now() - t0) / 1000);
        gl.uniform2f(uMouse, mouse[0], mouse[1]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    let last = 0;
    const loop = (now) => {
        // 30 frames per second is enough for the scene and halves the GPU time.
        if (document.hidden) {
            frame = 0;
            return;
        }
        if (visible && now - last >= 33) {
            last = now;
            draw();
        }
        frame = still ? 0 : requestAnimationFrame(loop);
    };
    const io = new IntersectionObserver((entries) => {
        for (const e of entries)
            visible = e.isIntersecting;
    });
    io.observe(el);
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    addEventListener('pointermove', onMove, { passive: true });
    let live = true;
    // The loop stops while the tab is hidden and restarts when it is shown again.
    const onVis = () => {
        if (live && !still && !document.hidden && frame === 0)
            frame = requestAnimationFrame(loop);
    };
    document.addEventListener('visibilitychange', onVis);
    void glyphAtlas().then((atlas) => {
        if (!live || atlas === null)
            return;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
        draw();
    });
    loop(performance.now());
    scenes.push(() => {
        cancelAnimationFrame(frame);
        io.disconnect();
        ro.disconnect();
        live = false;
        removeEventListener('pointermove', onMove);
        document.removeEventListener('visibilitychange', onVis);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
    });
}
// --- COPY (word 14) ---------------------------------------------------------------
/** How long `data-copied` stays on an element after a copy, in milliseconds. */
const COPIED_MS = 1500;
const copyTimers = new WeakMap();
let copyStatus;
/** The polite live region, outside the page root so a re-render does not drop it. */
function announce(message) {
    if (copyStatus === undefined) {
        copyStatus = document.createElement('div');
        copyStatus.className = 'copy-status';
        copyStatus.setAttribute('role', 'status');
        copyStatus.setAttribute('aria-live', 'polite');
        copyStatus.setAttribute('aria-atomic', 'true');
        document.body.appendChild(copyStatus);
    }
    const region = copyStatus;
    // Clearing first makes a repeated message announce again.
    region.textContent = '';
    window.setTimeout(() => {
        region.textContent = message;
    }, 30);
}
/** execCommand('copy') from a temporary textarea; only used when the Clipboard API is missing or refuses. */
function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    }
    catch {
        ok = false;
    }
    area.remove();
    return ok;
}
/**
 * Last resort: select the text beside the button (the previous element, else the next) so Ctrl+C
 * copies it.
 */
function selectNeighbour(el) {
    const near = el.previousElementSibling ?? el.nextElementSibling;
    if (near === null)
        return;
    const range = document.createRange();
    range.selectNodeContents(near);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
}
/**
 * Copy `text` for the user's click on `el`. The click handler calls this synchronously, so the
 * Clipboard API runs inside the user gesture. `data-copied` is `1` on success and `fail` when
 * nothing could copy; it clears after COPIED_MS. The label is not touched: CSS styles the state.
 */
async function copyFor(el, text) {
    let ok = false;
    try {
        await navigator.clipboard.writeText(text);
        ok = true;
    }
    catch {
        ok = legacyCopy(text);
    }
    if (!ok)
        selectNeighbour(el);
    window.clearTimeout(copyTimers.get(el));
    el.setAttribute('data-copied', ok ? '1' : 'fail');
    announce(ok ? 'Copied' : 'Could not copy: the text is selected, press Ctrl+C');
    copyTimers.set(el, window.setTimeout(() => el.removeAttribute('data-copied'), COPIED_MS));
}
function render(root, styleEl, words, onEvent, inputText) {
    for (const stop of scenes.splice(0))
        stop();
    root.replaceChildren();
    const shaders = new Map();
    const stack = [root];
    let state = [];
    let timer;
    let css = '';
    let i = 0;
    const bytes = () => {
        const r = readBytes(words, i);
        i = r.next;
        return r.bytes;
    };
    while (i < words.length) {
        const cmd = words[i++];
        const top = stack[stack.length - 1];
        switch (cmd) {
            case 1: {
                const el = document.createElement(TAGS[words[i++]] ?? 'div');
                if (el.tagName === 'TH')
                    el.setAttribute('scope', 'col');
                // a code block can scroll sideways: keyboard users reach it, and screen readers name it
                if (el.tagName === 'PRE') {
                    el.setAttribute('tabindex', '0');
                    el.setAttribute('role', 'group');
                    el.setAttribute('aria-label', 'Code example');
                }
                top.appendChild(el);
                stack.push(el);
                break;
            }
            case 2:
                top.appendChild(document.createTextNode(decoder.decode(bytes())));
                break;
            case 3:
                if (stack.length > 1)
                    stack.pop();
                break;
            case 4: {
                const key = ATTRS[words[i++]];
                const value = decoder.decode(bytes());
                if (key !== undefined && (key !== 'href' || safeHref(value)))
                    top.setAttribute(key, value);
                break;
            }
            case 5: {
                const event = words[i++];
                top.addEventListener('click', () => onEvent(event));
                break;
            }
            case 6: {
                const n = words[i++];
                state = Array.from(words.subarray(i, i + n));
                i += n;
                break;
            }
            case 8: {
                // ONSUBMIT: Enter in a text input, or Ctrl/Cmd+Enter in a textarea, sends the event; the
                // field's bytes travel as input. An input keeps what was typed; a textarea shows the
                // TEXT the program writes into it (the program echoes the submitted source).
                const event = words[i++];
                if (top instanceof HTMLTextAreaElement) {
                    top.addEventListener('keydown', (ev) => {
                        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                            ev.preventDefault();
                            onEvent(event);
                        }
                    });
                }
                else {
                    const input = top;
                    input.type = 'text';
                    input.value = inputText;
                    input.addEventListener('keydown', (ev) => {
                        if (ev.key === 'Enter')
                            onEvent(event);
                    });
                }
                break;
            }
            case 9:
                css += decoder.decode(bytes());
                break;
            case 10: {
                // GRID: a bitmap of 32-bit rows drawn on a canvas; clicking a cell sends event (x, y).
                const event = words[i++];
                const n = words[i++];
                const rows = Array.from(words.subarray(i, i + n));
                i += n;
                const canvas = document.createElement('canvas');
                canvas.width = 512;
                canvas.height = 16 * n;
                top.appendChild(canvas);
                canvas.addEventListener('click', (ev) => {
                    const rect = canvas.getBoundingClientRect();
                    onEvent(event, Math.floor(((ev.clientX - rect.left) / rect.width) * 32), Math.floor(((ev.clientY - rect.top) / rect.height) * n));
                });
                // Draw after the stylesheet is applied so colors come from the program's CSS.
                queueMicrotask(() => drawGrid(canvas, rows));
                break;
            }
            case 11: {
                const ms = words[i++];
                const event = words[i++];
                timer = { ms, event };
                break;
            }
            case 12: {
                // SIZE prop percent: 1 width, 2 height, 3 left, 4 bottom (a computed bar or point).
                const prop = words[i++];
                const pct = Math.min(100, words[i++]);
                const name = ['width', 'width', 'height', 'left', 'bottom'][prop] ?? 'width';
                top.style.setProperty(name, `${pct}%`);
                break;
            }
            case 13:
                // SHADER: the program's fragment shader (GLSL ES 3.0), possibly in several chunks,
                // becomes a canvas filling the open element. The runtime only supplies the quad,
                // the clock, the resolution, the pointer, and a glyph atlas.
                shaders.set(top, (shaders.get(top) ?? '') + decoder.decode(bytes()));
                break;
            case 14: {
                // COPY: activating the element (a click, or Enter/Space on a button) copies the text. The
                // attribute carries it in the DOM too, as in the prerendered page. No event is sent.
                const text = decoder.decode(bytes());
                top.setAttribute('data-copy', text);
                top.addEventListener('click', () => void copyFor(top, text));
                break;
            }
            default:
                i = words.length;
        }
    }
    if (styleEl.textContent !== css)
        styleEl.textContent = css;
    for (const [el, src] of shaders)
        mountShader(el, src);
    return { state, timer };
}
// --- Page -------------------------------------------------------------------------
async function main() {
    const root = document.getElementById('app');
    // The live-program request is read from the static shell before the first render, so nothing the
    // page program does to its root can lose it (see site/live.ts).
    const liveConfig = { ...root.dataset };
    const page = await load(root.dataset.program ?? '/page.wasm');
    // The prerendered page ships the stylesheet inline; the program's own copy replaces it.
    for (const old of Array.from(document.head.querySelectorAll('style')))
        old.remove();
    const styleEl = document.createElement('style');
    document.head.appendChild(styleEl);
    let state = [];
    let pending;
    const show = (event, x = 0, y = 0) => {
        if (pending !== undefined)
            window.clearTimeout(pending);
        pending = undefined;
        const field = root.querySelector('input, textarea');
        const text = field?.value ?? '';
        const textBytes = Array.from(encoder.encode(text)).slice(0, TEXT_CAP);
        const r = runSession(page, 'a0_session', [
            event,
            x,
            y,
            textBytes.length,
            ...textBytes,
            state.length,
            ...state,
        ]);
        const next = render(root, styleEl, r.output, show, text);
        state = next.state;
        if (typeof animate === 'function')
            animate();
        if (next.timer !== undefined) {
            const { ms, event: ev } = next.timer;
            pending = window.setTimeout(() => show(ev), ms);
        }
    };
    // Scroll-spy for the left rail (`.rail a[href="#id"]`, on the home page and the docs): the link
    // of the section being read gets `on`. The section is the last one (in rail order) that
    // has started inside a band just under the fixed header; the first link is on above the first section, the
    // last at the bottom of the page. A click or a hash change sets the link at once and holds the
    // observer back until the smooth scroll has ended.
    let spyOff;
    let spyHold = 0;
    const spy = () => {
        spyOff?.();
        const links = Array.from(root.querySelectorAll('.rail a[href^="#"]'));
        const targets = links.map((a) => document.getElementById(a.getAttribute('href')?.slice(1) ?? ''));
        if (links.length === 0) {
            spyOff = undefined;
            return;
        }
        // The band under the header (96px) down to 45% of the viewport. The observer wakes `pick`
        // when a section crosses it; `pick` reads the geometry itself, so a late callback is harmless.
        const inBand = (t) => {
            const r = t.getBoundingClientRect();
            return r.bottom > 96 && r.top < innerHeight * 0.45;
        };
        const mark = (i) => {
            links.forEach((a, j) => {
                a.classList.toggle('on', j === i);
                if (j === i)
                    a.setAttribute('aria-current', 'location');
                else
                    a.removeAttribute('aria-current');
            });
        };
        const pick = () => {
            if (spyHold > 0)
                return;
            const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
            // Of the sections in the band, the last one that has started (its top is within 160px of
            // the viewport top, just under the header) is the one being read; the previous section's tail is also in the band.
            let i = atEnd ? links.length - 1 : -1;
            if (!atEnd)
                targets.forEach((t, j) => {
                    if (t !== null && inBand(t) && (i < 0 || t.getBoundingClientRect().top < 160))
                        i = j;
                });
            if (i < 0) {
                // Between bands: the last section already passed, or the first above them all.
                const passed = targets.map((t) => t !== null && t.getBoundingClientRect().top < 160);
                i = Math.max(0, passed.lastIndexOf(true));
            }
            mark(i);
        };
        const io = new IntersectionObserver(() => pick(), { rootMargin: '-96px 0px -55% 0px' });
        for (const t of targets)
            if (t !== null)
                io.observe(t);
        const hold = (i) => {
            mark(i);
            spyHold += 1;
            const release = () => {
                spyHold -= 1;
                pick();
            };
            if ('onscrollend' in window)
                addEventListener('scrollend', release, { once: true });
            window.setTimeout(release, 1200);
        };
        const onClick = (ev) => {
            const i = links.indexOf(ev.target.closest('a'));
            if (i >= 0)
                hold(i);
        };
        const onHash = () => {
            const i = links.findIndex((a) => a.getAttribute('href') === location.hash);
            if (i >= 0)
                hold(i);
        };
        const onScroll = () => pick();
        root.addEventListener('click', onClick);
        addEventListener('hashchange', onHash);
        addEventListener('scroll', onScroll, { passive: true });
        pick();
        spyOff = () => {
            io.disconnect();
            root.removeEventListener('click', onClick);
            removeEventListener('hashchange', onHash);
            removeEventListener('scroll', onScroll);
        };
    };
    // Generic motion hooks: `.reveal` elements get `in` when scrolled into view, `.fill`
    // bars grow after layout, and `.count` numbers count up once. The program chooses the classes.
    // Content is visible without JS; the `js` class turns on the hidden start state of the motion hooks.
    document.documentElement.classList.add('js');
    const observer = new IntersectionObserver((entries) => {
        for (const e of entries)
            if (e.isIntersecting)
                e.target.classList.add('in');
    }, { threshold: 0, rootMargin: '0px 0px 15% 0px' });
    const animate = () => {
        spy();
        // Anything already on screen is shown at once; only what scrolls into view later fades in.
        root.querySelectorAll('.reveal').forEach((el) => {
            if (el.getBoundingClientRect().top < innerHeight)
                el.classList.add('in');
            else
                observer.observe(el);
        });
        requestAnimationFrame(() => {
            root.querySelectorAll('.fill').forEach((el) => el.classList.add('grown'));
        });
        for (const el of Array.from(root.querySelectorAll('.count'))) {
            const target = el.textContent ?? '';
            const m = /^(\d+)(\.\d+)?(.*)$/.exec(target);
            if (m === null || el.classList.contains('counted'))
                continue;
            el.classList.add('counted');
            const whole = Number(m[1]);
            const frac = m[2] ?? '';
            const suffix = m[3] ?? '';
            const t0 = performance.now();
            const step = (now) => {
                const k = Math.min(1, (now - t0) / 600);
                const eased = 1 - (1 - k) * (1 - k) * (1 - k);
                el.textContent = `${Math.round(whole * eased)}${k >= 1 ? frac : ''}${suffix}`;
                if (k < 1)
                    requestAnimationFrame(step);
                else
                    el.textContent = target;
            };
            requestAnimationFrame(step);
        }
    };
    show(0);
    animate();
    // The page exists only after the first render, so honor a fragment in the URL now.
    if (location.hash.length > 1)
        document.getElementById(location.hash.slice(1))?.scrollIntoView();
    spy();
    // A page may ask for a live (frame-driven) A0 program with data-live on its root; it mounts after the
    // first render, lazily, and a failure leaves the page as it is (see site/live.ts).
    if (liveConfig.live !== undefined)
        void import('./live.js').then((m) => m.mountLive(root, liveConfig)).catch(() => undefined);
    window.a0page = {
        show,
        state: () => state,
    };
}
main().catch((err) => {
    const el = document.getElementById('app');
    if (el)
        el.textContent = `failed to load: ${err instanceof Error ? err.message : String(err)}`;
});
