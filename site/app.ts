/**
 * Browser adapter for A0 programs on a0lang.com.
 *
 * Two A0 programs, both compiled to freestanding wasm32 through C, drive this page:
 *  - site/page.a0 renders the page itself as a UI command stream (the A0 UI protocol)
 *    and keeps its own state word; clicks are fed back as event ids.
 *  - examples/life.a0 is mounted as component 1 (canvas), speaking its session protocol.
 * This file only interprets word streams, builds DOM, and forwards events; no A0
 * semantics live here.
 */

const IN_CAP = 256;
const OUT_CAP = 1024;

interface IoExports {
  readonly memory: WebAssembly.Memory;
  readonly __heap_base: WebAssembly.Global;
}

async function load(url: string): Promise<WebAssembly.Exports> {
  const { instance } = await WebAssembly.instantiateStreaming(await fetch(url), {});
  return instance.exports;
}

/** Run one io session: input words in, output words + result out (C io struct layout). */
function runSession(exp: WebAssembly.Exports, entry: string, input: readonly number[]): { output: Uint32Array; result: number } {
  const e = exp as unknown as IoExports;
  const base = e.__heap_base.value as number;
  const needed = base + (IN_CAP + 2 + OUT_CAP + 1) * 4;
  if (e.memory.buffer.byteLength < needed) e.memory.grow(Math.ceil((needed - e.memory.buffer.byteLength) / 65536));
  const words = new Uint32Array(e.memory.buffer, base, IN_CAP + 2 + OUT_CAP + 1);
  words.fill(0);
  words.set(input.slice(0, IN_CAP), 0);
  words[IN_CAP] = Math.min(input.length, IN_CAP);
  const fn = exp[entry] as (io: number) => number;
  const result = fn(base) >>> 0;
  const nout = words[IN_CAP + 2 + OUT_CAP] as number;
  return { output: Uint32Array.from(words.subarray(IN_CAP + 2, IN_CAP + 2 + Math.min(nout, OUT_CAP))), result };
}

// --- A0 UI protocol -------------------------------------------------------------

const TAGS: Record<number, string> = { 1: 'h1', 2: 'p', 3: 'button', 4: 'code', 5: 'div', 6: 'span', 7: 'ul', 8: 'li', 9: 'a', 10: 'pre', 11: 'h2' };
const ATTRS: Record<number, string> = { 1: 'id', 2: 'class', 3: 'href' };
const decoder = new TextDecoder();

function render(root: HTMLElement, words: Uint32Array, onEvent: (event: number) => void, mount: (id: number, host: HTMLElement) => void): number | undefined {
  root.replaceChildren();
  const stack: HTMLElement[] = [root];
  let state: number | undefined;
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
      case 6:
        state = words[i++] as number;
        break;
      case 7: {
        const host = document.createElement('div');
        top.appendChild(host);
        mount(words[i++] as number, host);
        break;
      }
      default:
        return state;
    }
  }
  return state;
}

// --- Life component (examples/life.a0) ----------------------------------------------

function mountLife(exp: WebAssembly.Exports, host: HTMLElement): void {
  const N = 32;
  host.innerHTML =
    '<canvas id="grid" width="512" height="512" aria-label="Life grid; click a cell to toggle it"></canvas><div class="bar"><button id="step" type="button">Step</button><button id="run" type="button">Run</button><button id="clear" type="button">Clear</button><button id="glider" type="button">Glider</button><span class="stat">generation <b id="generation">0</b></span><span class="stat">population <b id="population">0</b></span></div>';
  const canvas = host.querySelector('#grid') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const popEl = host.querySelector('#population') as HTMLElement;
  const genEl = host.querySelector('#generation') as HTMLElement;
  let grid: Uint32Array = new Uint32Array(N);
  let generation = 0;
  let timer: number | undefined;
  const cell = canvas.width / N;
  const style = getComputedStyle(document.documentElement);
  const draw = (population: number): void => {
    ctx.fillStyle = style.getPropertyValue('--bg').trim() || '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = style.getPropertyValue('--cell').trim() || '#6cf';
    for (let r = 0; r < N; r += 1) {
      const row = grid[r] as number;
      for (let c = 0; c < N; c += 1) if ((row >>> c) & 1) ctx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
    }
    popEl.textContent = String(population);
    genEl.textContent = String(generation);
  };
  const apply = (cmd: number, x = 0, y = 0): void => {
    const r = runSession(exp, 'a0_session', [...grid, cmd, x, y]);
    grid = Uint32Array.from(r.output.subarray(0, N));
    if (cmd === 0) generation += 1;
    if (cmd === 2) generation = 0;
    draw(r.result);
  };
  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    apply(1, Math.floor(((ev.clientX - rect.left) / rect.width) * N), Math.floor(((ev.clientY - rect.top) / rect.height) * N));
  });
  (host.querySelector('#step') as HTMLButtonElement).addEventListener('click', () => apply(0));
  (host.querySelector('#clear') as HTMLButtonElement).addEventListener('click', () => apply(2));
  (host.querySelector('#glider') as HTMLButtonElement).addEventListener('click', () => {
    for (const [r, c] of [[1, 2], [2, 3], [3, 1], [3, 2], [3, 3]] as const) apply(1, c, r);
  });
  const runBtn = host.querySelector('#run') as HTMLButtonElement;
  runBtn.addEventListener('click', () => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
      runBtn.textContent = 'Run';
      return;
    }
    timer = window.setInterval(() => apply(0), 120);
    runBtn.textContent = 'Pause';
  });
  apply(2);
  (window as unknown as { a0life: { apply: typeof apply; grid: () => Uint32Array } }).a0life = { apply, grid: () => grid };
}

// --- Page -------------------------------------------------------------------------

async function main(): Promise<void> {
  const [page, life] = await Promise.all([load('page.wasm'), load('life.wasm')]);
  const root = document.getElementById('app') as HTMLElement;
  let state = 0;
  const show = (event: number): void => {
    const r = runSession(page, 'a0_session', [event, state]);
    const next = render(root, r.output, show, (id, host) => {
      if (id === 1) mountLife(life, host);
    });
    state = next ?? r.result;
  };
  show(0);
  (window as unknown as { a0page: { show: typeof show; state: () => number } }).a0page = { show, state: () => state };
}

main().catch((err: unknown) => {
  const el = document.getElementById('app');
  if (el) el.textContent = `failed to load: ${err instanceof Error ? err.message : String(err)}`;
});
