/**
 * Browser adapter for the A0 Life component (a0lang.com demo).
 *
 * The A0 program (examples/life.a0) is compiled to C, then to a freestanding wasm32
 * module. This adapter owns the DOM and the grid state, and speaks the A0 io session
 * protocol through the C io struct in linear memory: 32 rows + command + x + y in,
 * 32 rows out, population as the result. No A0 semantics live here.
 */

const IN_CAP = 256;
const OUT_CAP = 1024;
const N = 32;

interface Exports {
  readonly memory: WebAssembly.Memory;
  readonly __heap_base: WebAssembly.Global;
  readonly a0_session: (io: number) => number;
}

async function load(): Promise<Exports> {
  const response = await fetch('life.wasm');
  const { instance } = await WebAssembly.instantiateStreaming(response, {});
  return instance.exports as unknown as Exports;
}

function session(exp: Exports, grid: Uint32Array, cmd: number, x: number, y: number): { rows: Uint32Array; population: number } {
  const base = exp.__heap_base.value as number;
  const needed = base + (IN_CAP + 2 + OUT_CAP + 1) * 4;
  if (exp.memory.buffer.byteLength < needed) exp.memory.grow(Math.ceil((needed - exp.memory.buffer.byteLength) / 65536));
  const words = new Uint32Array(exp.memory.buffer, base, IN_CAP + 2 + OUT_CAP + 1);
  words.fill(0);
  words.set(grid, 0);
  words[N] = cmd;
  words[N + 1] = x;
  words[N + 2] = y;
  words[IN_CAP] = N + 3; // ninput
  const population = exp.a0_session(base) >>> 0;
  const nout = words[IN_CAP + 2 + OUT_CAP] as number;
  const rows = Uint32Array.from(words.subarray(IN_CAP + 2, IN_CAP + 2 + Math.min(nout, N)));
  return { rows, population };
}

function main(exp: Exports): void {
  const canvas = document.getElementById('grid') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const popEl = document.getElementById('population') as HTMLElement;
  const genEl = document.getElementById('generation') as HTMLElement;
  const stepBtn = document.getElementById('step') as HTMLButtonElement;
  const runBtn = document.getElementById('run') as HTMLButtonElement;
  const clearBtn = document.getElementById('clear') as HTMLButtonElement;
  const gliderBtn = document.getElementById('glider') as HTMLButtonElement;
  let grid: Uint32Array = new Uint32Array(N);
  let generation = 0;
  let timer: number | undefined;
  const cell = canvas.width / N;

  const draw = (population: number): void => {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--cell').trim() || '#6cf';
    for (let r = 0; r < N; r += 1) {
      const row = grid[r] as number;
      for (let c = 0; c < N; c += 1) if ((row >>> c) & 1) ctx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
    }
    popEl.textContent = String(population);
    genEl.textContent = String(generation);
  };
  const apply = (cmd: number, x = 0, y = 0): void => {
    const r = session(exp, grid, cmd, x, y);
    grid = r.rows;
    if (cmd === 0) generation += 1;
    if (cmd === 2) generation = 0;
    draw(r.population);
  };
  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - rect.left) / rect.width) * N);
    const y = Math.floor(((ev.clientY - rect.top) / rect.height) * N);
    apply(1, x, y);
  });
  stepBtn.addEventListener('click', () => apply(0));
  clearBtn.addEventListener('click', () => apply(2));
  gliderBtn.addEventListener('click', () => {
    for (const [r, c] of [[1, 2], [2, 3], [3, 1], [3, 2], [3, 3]] as const) apply(1, c, r);
  });
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

load().then(main, (err: unknown) => {
  const el = document.getElementById('status');
  if (el) el.textContent = `failed to load life.wasm: ${err instanceof Error ? err.message : String(err)}`;
});
