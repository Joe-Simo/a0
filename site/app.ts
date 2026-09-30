/**
 * Generic browser runtime for an A0 page program (a0lang.com).
 *
 * The page is one A0 io program (site/page.a0 linked with examples/life.a0), compiled to
 * freestanding wasm32 through C. Everything on the page, including its stylesheet, its
 * layout, its buttons, the Life grid logic, the timer, and the persisted state, comes from
 * the word stream that program writes. This file knows nothing about the page: it feeds
 * events in, interprets the A0 UI protocol out, and builds DOM.
 *
 * Input words:  event x y ntext text[ntext] nstate state[nstate]
 * Output words: 1 OPEN tag | 2 TEXT n bytes | 3 CLOSE | 4 ATTR key n bytes | 5 ONCLICK event
 *               6 STATE n words | 8 ONSUBMIT event | 9 STYLE n bytes | 10 GRID event rows row...
 *               11 TIMER ms event | 12 SIZE prop percent (1 width, 2 height, 3 left, 4 bottom)
 *               13 SHADER n bytes (a GLSL fragment shader drawn on a canvas in the open element)
 * Tags and attribute keys are small integer tables shared with the program (see page.a0).
 */

const IN_CAP = 512;
const OUT_CAP = 65536;
const TEXT_CAP = 64;

interface IoExports {
  readonly memory: WebAssembly.Memory;
  readonly __heap_base: WebAssembly.Global;
}

async function load(url: string): Promise<WebAssembly.Exports> {
  const { instance } = await WebAssembly.instantiateStreaming(await fetch(url), {});
  return instance.exports;
}

/** Run one io session: input words in, output words + result out (C io struct layout). */
function runSession(
  exp: WebAssembly.Exports,
  entry: string,
  input: readonly number[],
): { output: Uint32Array; result: number } {
  const e = exp as unknown as IoExports;
  const base = e.__heap_base.value as number;
  const needed = base + (IN_CAP + 2 + OUT_CAP + 1) * 4;
  if (e.memory.buffer.byteLength < needed)
    e.memory.grow(Math.ceil((needed - e.memory.buffer.byteLength) / 65536));
  const words = new Uint32Array(e.memory.buffer, base, IN_CAP + 2 + OUT_CAP + 1);
  words.fill(0);
  words.set(input.slice(0, IN_CAP), 0);
  words[IN_CAP] = Math.min(input.length, IN_CAP);
  const fn = exp[entry] as (io: number) => number;
  const result = fn(base) >>> 0;
  const nout = words[IN_CAP + 2 + OUT_CAP] as number;
  return {
    output: Uint32Array.from(words.subarray(IN_CAP + 2, IN_CAP + 2 + Math.min(nout, OUT_CAP))),
    result,
  };
}

// --- A0 UI protocol -------------------------------------------------------------

const TAGS: Record<number, string> = {
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
};
const ATTRS: Record<number, string> = {
  1: 'id',
  2: 'class',
  3: 'href',
  4: 'type',
  5: 'placeholder',
  6: 'aria-label',
};
const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface Rendered {
  readonly state: number[];
  readonly timer: { ms: number; event: number } | undefined;
}

interface EventSink {
  (event: number, x?: number, y?: number): void;
}

function drawGrid(canvas: HTMLCanvasElement, rows: readonly number[]): void {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const style = getComputedStyle(canvas);
  const n = rows.length;
  const cell = canvas.width / 32;
  ctx.fillStyle = style.backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = style.color;
  for (let r = 0; r < n; r += 1) {
    const row = rows[r] as number;
    for (let c = 0; c < 32; c += 1)
      if ((row >>> c) & 1) ctx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
  }
}

/** Running shader scenes; each is stopped before the page re-renders. */
const scenes: (() => void)[] = [];

const QUAD_VS = `#version 300 es
in vec2 a;
void main(){gl_Position=vec4(a,0.,1.);}`;

function mountShader(el: HTMLElement, fragment: string): void {
  const canvas = document.createElement('canvas');
  canvas.className = 'scene';
  el.appendChild(canvas);
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
  if (gl === null) return;
  const shader = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (sh === null) return null;
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
  if (vs === null || fs === null || prog === null) return;
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
  const uDark = gl.getUniformLocation(prog, 'u_dark');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  let mouse: [number, number] = [0.5, 0.5];
  let visible = true;
  let frame = 0;
  const onMove = (ev: PointerEvent): void => {
    mouse = [ev.clientX / innerWidth, 1 - ev.clientY / innerHeight];
  };
  const size = (): void => {
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
  const draw = (): void => {
    size();
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, still ? 0 : (performance.now() - t0) / 1000);
    gl.uniform2f(uMouse, mouse[0], mouse[1]);
    gl.uniform1f(uDark, dark.matches ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  let last = 0;
  const loop = (now: number): void => {
    // 30 frames per second is enough for a slow scene and halves the GPU time.
    if (visible && !document.hidden && now - last >= 32) {
      last = now;
      draw();
    }
    frame = still ? 0 : requestAnimationFrame(loop);
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) visible = e.isIntersecting;
  });
  io.observe(el);
  const ro = new ResizeObserver(() => draw());
  ro.observe(el);
  addEventListener('pointermove', onMove, { passive: true });
  dark.addEventListener('change', draw);
  loop(performance.now());
  scenes.push(() => {
    cancelAnimationFrame(frame);
    io.disconnect();
    ro.disconnect();
    removeEventListener('pointermove', onMove);
    dark.removeEventListener('change', draw);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  });
}

function render(
  root: HTMLElement,
  styleEl: HTMLStyleElement,
  words: Uint32Array,
  onEvent: EventSink,
  inputText: string,
): Rendered {
  for (const stop of scenes.splice(0)) stop();
  root.replaceChildren();
  const shaders = new Map<HTMLElement, string>();
  const stack: HTMLElement[] = [root];
  let state: number[] = [];
  let timer: Rendered['timer'];
  let css = '';
  let i = 0;
  const bytes = (): Uint8Array => {
    const n = words[i++] as number;
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k += 1) out[k] = (words[i++] as number) & 0xff;
    return out;
  };
  while (i < words.length) {
    const cmd = words[i++];
    const top = stack[stack.length - 1] as HTMLElement;
    switch (cmd) {
      case 1: {
        const el = document.createElement(TAGS[words[i++] as number] ?? 'div');
        top.appendChild(el);
        stack.push(el);
        break;
      }
      case 2:
        top.appendChild(document.createTextNode(decoder.decode(bytes())));
        break;
      case 3:
        if (stack.length > 1) stack.pop();
        break;
      case 4: {
        const key = ATTRS[words[i++] as number];
        const value = decoder.decode(bytes());
        if (key !== undefined) top.setAttribute(key, value);
        break;
      }
      case 5: {
        const event = words[i++] as number;
        top.addEventListener('click', () => onEvent(event));
        break;
      }
      case 6: {
        const n = words[i++] as number;
        state = Array.from(words.subarray(i, i + n));
        i += n;
        break;
      }
      case 8: {
        // ONSUBMIT: Enter in this text input sends the event; the field's bytes travel as input.
        const event = words[i++] as number;
        const input = top as HTMLInputElement;
        input.type = 'text';
        input.value = inputText;
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') onEvent(event);
        });
        break;
      }
      case 9:
        css += decoder.decode(bytes());
        break;
      case 10: {
        // GRID: a bitmap of 32-bit rows drawn on a canvas; clicking a cell sends event (x, y).
        const event = words[i++] as number;
        const n = words[i++] as number;
        const rows = Array.from(words.subarray(i, i + n));
        i += n;
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 16 * n;
        top.appendChild(canvas);
        canvas.addEventListener('click', (ev) => {
          const rect = canvas.getBoundingClientRect();
          onEvent(
            event,
            Math.floor(((ev.clientX - rect.left) / rect.width) * 32),
            Math.floor(((ev.clientY - rect.top) / rect.height) * n),
          );
        });
        // Draw after the stylesheet is applied so colors come from the program's CSS.
        queueMicrotask(() => drawGrid(canvas, rows));
        break;
      }
      case 11: {
        const ms = words[i++] as number;
        const event = words[i++] as number;
        timer = { ms, event };
        break;
      }
      case 12: {
        // SIZE prop percent: 1 width, 2 height, 3 left, 4 bottom (a computed bar or point).
        const prop = words[i++] as number;
        const pct = Math.min(100, words[i++] as number);
        const name = ['width', 'width', 'height', 'left', 'bottom'][prop] ?? 'width';
        top.style.setProperty(name, `${pct}%`);
        break;
      }
      case 13:
        // SHADER: the program's fragment shader (GLSL ES 3.0), possibly in several chunks,
        // becomes a canvas filling the open element. The runtime only supplies the quad,
        // the clock, the resolution, the pointer, and the color scheme.
        shaders.set(top, (shaders.get(top) ?? '') + decoder.decode(bytes()));
        break;
      default:
        i = words.length;
    }
  }
  if (styleEl.textContent !== css) styleEl.textContent = css;
  for (const [el, src] of shaders) mountShader(el, src);
  return { state, timer };
}

// --- Page -------------------------------------------------------------------------

async function main(): Promise<void> {
  const root = document.getElementById('app') as HTMLElement;
  const page = await load(root.dataset.program ?? '/page.wasm');
  const styleEl = document.createElement('style');
  document.head.appendChild(styleEl);
  let state: number[] = [];
  let pending: number | undefined;
  const show: EventSink = (event, x = 0, y = 0) => {
    if (pending !== undefined) window.clearTimeout(pending);
    pending = undefined;
    const field = root.querySelector('input') as HTMLInputElement | null;
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
    if (typeof animate === 'function') animate();
    if (next.timer !== undefined) {
      const { ms, event: ev } = next.timer;
      pending = window.setTimeout(() => show(ev), ms);
    }
  };
  // Generic motion hooks: `.reveal` elements get `in` when scrolled into view, `.fill`
  // bars grow after layout, and `.count` numbers count up once. The program chooses the classes.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) e.target.classList.add('in');
    },
    { threshold: 0.15 },
  );
  const animate = (): void => {
    root.querySelectorAll('.reveal').forEach((el) => observer.observe(el));
    requestAnimationFrame(() => {
      root.querySelectorAll('.fill').forEach((el) => el.classList.add('grown'));
    });
    for (const el of Array.from(root.querySelectorAll('.count'))) {
      const target = el.textContent ?? '';
      const m = /^(\d+)(\.\d+)?(.*)$/.exec(target);
      if (m === null || el.classList.contains('counted')) continue;
      el.classList.add('counted');
      const whole = Number(m[1]);
      const frac = m[2] ?? '';
      const suffix = m[3] ?? '';
      const t0 = performance.now();
      const step = (now: number): void => {
        const k = Math.min(1, (now - t0) / 900);
        const eased = 1 - (1 - k) * (1 - k) * (1 - k);
        el.textContent = `${Math.round(whole * eased)}${k >= 1 ? frac : ''}${suffix}`;
        if (k < 1) requestAnimationFrame(step);
        else el.textContent = target;
      };
      requestAnimationFrame(step);
    }
  };
  show(0);
  animate();
  // The page exists only after the first render, so honor a fragment in the URL now.
  if (location.hash.length > 1) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  (window as unknown as { a0page: { show: EventSink; state: () => number[] } }).a0page = {
    show,
    state: () => state,
  };
}

main().catch((err: unknown) => {
  const el = document.getElementById('app');
  if (el) el.textContent = `failed to load: ${err instanceof Error ? err.message : String(err)}`;
});
