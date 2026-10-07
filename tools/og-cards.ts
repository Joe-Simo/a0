/**
 * og-cards: the social preview images (1200x630 PNG, one per page type) and the touch icons.
 *
 * Every number on a card is computed here from a results file; nothing is typed in by hand, and
 * each card prints the file it came from. The card is an HTML page written to a temp directory
 * (Geist and Geist Pixel from the `geist` package, the same fonts the site serves) and shot with
 * headless Chrome over the DevTools protocol, so the output needs no image library. Flat colors
 * only: the PNGs stay small (the budget is OG_BUDGET bytes, checked by test/metadata.test.ts).
 *
 *   bun run og-cards      writes site/og/{home,docs,benchmarks}.png, site/apple-touch-icon.png,
 *                         site/favicon-32.png (committed; tools/site-build.ts copies them)
 *
 * Chrome is found through $CHROME or the usual install paths.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The largest an og image may be, in bytes. */
export const OG_BUDGET = 120_000;
export const PITCH = 'A small language AI models can edit without breaking your build.';

export interface Stat {
  readonly big: string;
  readonly label: string;
  readonly source: string;
}
export interface Card {
  readonly file: string;
  readonly kicker: string;
  readonly alt: string;
  readonly stats: readonly Stat[];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

const x = (n: number): string => (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + 'x';

/** The three cards, with every number read from the results files. */
export async function computeCards(root = '.'): Promise<readonly Card[]> {
  const keys = await readJson<{
    cells: Record<string, { n: number; acceptedCount: number }>;
  }>(join(root, 'results', 'app-edit-keys.json'));
  const lat = await readJson<{
    size: { a0: { formattedLines: number; functions: number } };
    a0: { edits: { apply: { median: number } }[] };
    comparisons: { kind: string; ratio: number; verdict: string }[];
  }>(join(root, 'results', 'check-latency-linux-x64.json'));
  const ledger = await readJson<{ entries: unknown[] }>(join(root, 'results', 'loss-ledger.json'));

  const sonnet = keys.cells['sonnet/a0-keys'];
  if (!sonnet) throw new Error('results/app-edit-keys.json lacks sonnet/a0-keys');
  const edits = lat.comparisons.filter((c) => c.kind === 'edit');
  const ratios = edits.map((c) => c.ratio);
  const lo = Math.min(...ratios);
  const hi = Math.max(...ratios);
  const wins = edits.filter((c) => c.verdict === 'win').length;
  const medians = lat.a0.edits.map((e) => e.apply.median);
  const fast = Math.min(...medians);
  const slow = Math.max(...medians);
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const latSrc = 'results/check-latency-linux-x64.json';
  return [
    {
      file: 'home.png',
      kicker: 'a0lang.com',
      alt: `A0: ${PITCH} Sonnet got ${sonnet.acceptedCount} of ${sonnet.n} front-end edits accepted; one edit is checked in ${fast.toFixed(0)} to ${slow.toFixed(0)} ms, where tsc, tsgo and tsc-rs re-check the whole project.`,
      stats: [
        {
          big: `${sonnet.acceptedCount} of ${sonnet.n}`,
          label: 'front-end edits accepted (Sonnet, A0 view)',
          source: 'results/app-edit-keys.json',
        },
        {
          big: `${fast.toFixed(0)} to ${slow.toFixed(0)} ms`,
          label: 'to check one edit in A0 (tsc, tsgo, tsc-rs re-check the whole project)',
          source: latSrc,
        },
      ],
    },
    {
      file: 'docs.png',
      kicker: 'a0lang.com/docs  /  language reference',
      alt: `A0 language reference. A ${fmt(lat.size.a0.formattedLines)}-line, ${lat.size.a0.functions}-function program takes ${fast.toFixed(0)} to ${slow.toFixed(0)} ms per checked edit.`,
      stats: [
        {
          big: fmt(lat.size.a0.formattedLines),
          label: 'lines in the front end the edit benchmark checks',
          source: latSrc,
        },
        { big: `${lat.size.a0.functions}`, label: 'functions in that program', source: latSrc },
        {
          big: `${fast.toFixed(0)} to ${slow.toFixed(0)} ms`,
          label: 'median time to check one edit',
          source: latSrc,
        },
      ],
    },
    {
      file: 'benchmarks.png',
      kicker: 'a0lang.com/benchmarks  /  losses included',
      alt: `A0 benchmarks, losses included: ${fmt(ledger.entries.length)} losses recorded in the ledger, and ${wins} of ${edits.length} edit-check comparisons won.`,
      stats: [
        {
          big: fmt(ledger.entries.length),
          label: 'losses recorded in the open',
          source: 'results/loss-ledger.json',
        },
        {
          big: `${wins} of ${edits.length}`,
          label: 'edit-check comparisons won (A0 per edit against their whole-project check)',
          source: latSrc,
        },
        {
          big: `${x(lo)} to ${x(hi)}`,
          label: 'range: their whole-project time over A0 per-edit time',
          source: latSrc,
        },
      ],
    },
  ];
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cardHtml(card: Card, fontsUrl: string): string {
  const stats = card.stats
    .map(
      (s) =>
        `<div class="s"><div class="n">${esc(s.big)}</div><div class="l">${esc(s.label)}</div><div class="src">${esc(s.source)}</div></div>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Geist";src:url("${fontsUrl}/geist-sans/Geist-Variable.woff2");font-weight:100 900}
@font-face{font-family:"Geist Mono";src:url("${fontsUrl}/geist-mono/GeistMono-Variable.woff2");font-weight:100 900}
@font-face{font-family:"Geist Pixel";src:url("${fontsUrl}/geist-pixel/GeistPixel-Square.woff2")}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;background:#000;overflow:hidden}
body{font-family:"Geist",sans-serif;color:#fff;position:relative}
.frame{position:absolute;inset:28px;border:1px solid #262626;padding:44px 56px;display:flex;flex-direction:column}
.k{font:500 24px "Geist Mono",monospace;color:#8f8f8f;letter-spacing:.02em}
.hero{display:flex;align-items:center;gap:52px;margin-top:26px}
.mark{font:400 210px/1 "Geist Pixel","Geist Mono",monospace;color:#00ff41;letter-spacing:-.02em}
.pitch{font:600 46px/1.15 "Geist",sans-serif;color:#fff;letter-spacing:-.02em;max-width:560px}
.stats{margin-top:auto;display:flex;gap:0;border-top:1px solid #262626;padding-top:26px}
.s{flex:1;padding-right:24px}.s+.s{padding-left:28px;border-left:1px solid #262626}
.n{font:400 50px/1 "Geist Pixel","Geist Mono",monospace;color:#00ff41;white-space:nowrap}
.l{font:500 21px/1.3 "Geist",sans-serif;color:#d9d9d9;margin-top:12px}
.src{white-space:nowrap;font:400 14.5px "Geist Mono",monospace;color:#6f6f6f;margin-top:8px}
</style></head><body><div class="frame"><div class="k">${esc(card.kicker)}</div>
<div class="hero"><div class="mark">A0</div><div class="pitch">${esc(PITCH)}</div></div>
<div class="stats">${stats}</div></div></body></html>`;
}

function findChrome(): string {
  const cands = [
    process.env['CHROME'],
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of cands) if (c && existsSync(c)) return c;
  throw new Error('no Chrome found: set CHROME to a Chrome or Chromium executable');
}

class Shooter {
  private ws!: WebSocket;
  private id = 0;
  private readonly pending = new Map<number, (r: { result?: unknown }) => void>();
  private proc!: ReturnType<typeof spawn>;
  async open(dir: string): Promise<void> {
    const port = 20000 + Math.floor(Math.random() * 20000);
    this.proc = spawn(
      findChrome(),
      [
        `--remote-debugging-port=${port}`,
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--allow-file-access-from-files',
        `--user-data-dir=${join(dir, 'profile')}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    let tabs: { type: string; webSocketDebuggerUrl: string }[] = [];
    for (let i = 0; i < 100 && !tabs.length; i++) {
      try {
        tabs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as typeof tabs;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const page = tabs.find((t) => t.type === 'page');
    if (!page) throw new Error('Chrome did not start');
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => {
      this.ws.onopen = r;
    });
    this.ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as { id?: number; result?: unknown };
      if (d.id !== undefined) this.pending.get(d.id)?.(d);
    };
  }
  send(method: string, params: object = {}): Promise<{ result?: { data?: string } }> {
    return new Promise((res) => {
      const i = ++this.id;
      this.pending.set(i, res as never);
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  /** Load `url` at w x h and return the PNG. */
  async shoot(url: string, w: number, h: number): Promise<Buffer> {
    await this.send('Page.enable');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 400));
    await this.send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
    await new Promise((r) => setTimeout(r, 300));
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(r.result?.data ?? '', 'base64');
  }
  close(): void {
    this.ws.close();
    this.proc.kill();
  }
}

const ICON_SVG = (rx: number, size: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}"><rect width="32" height="32" rx="${rx}" fill="#000"/><path d="M7 24 12 8h3l5 16h-3l-1.2-4h-4.6L10 24Zm5-7h3.4L13.7 11Z" fill="#fff"/><circle cx="24" cy="20" r="4" fill="none" stroke="#ffd166" stroke-width="2"/></svg>`;

export async function main(root = '.'): Promise<void> {
  const cards = await computeCards(root);
  const fontsUrl = `${
    pathToFileURL(join(dirname(createRequire(import.meta.url).resolve('geist/font')), 'fonts')).href
  }`;
  const tmp = await mkdtemp(join(tmpdir(), 'a0-og-'));
  const shooter = new Shooter();
  try {
    await shooter.open(tmp);
    await mkdir(join(root, 'site', 'og'), { recursive: true });
    for (const card of cards) {
      const html = join(tmp, card.file.replace('.png', '.html'));
      await writeFile(html, cardHtml(card, fontsUrl), 'utf8');
      const png = await shooter.shoot(pathToFileURL(html).href, 1200, 630);
      await writeFile(join(root, 'site', 'og', card.file), png);
      process.stdout.write(`site/og/${card.file}: ${png.length} bytes\n`);
    }
    for (const [name, size] of [
      ['apple-touch-icon.png', 180],
      ['favicon-32.png', 32],
    ] as const) {
      const svg = join(tmp, `${name}.html`);
      await writeFile(
        svg,
        `<!doctype html><body style="margin:0;background:#000">${ICON_SVG(0, size)}</body>`,
        'utf8',
      );
      const png = await shooter.shoot(pathToFileURL(svg).href, size, size);
      await writeFile(join(root, 'site', name), png);
      process.stdout.write(`site/${name}: ${png.length} bytes\n`);
    }
  } finally {
    shooter.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
