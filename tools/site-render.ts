/**
 * Prerender an A0 page program to static HTML at build time.
 *
 * The site is built in the browser by the program's wasm and site/app.ts. Agents and crawlers
 * that do not run JavaScript would see an empty shell, so the build runs the same program
 * once through the reference interpreter and writes the resulting DOM as HTML. The browser
 * runtime then re-renders the identical tree and adds the live parts (scenes, motion).
 * This module interprets the A0 UI protocol word stream exactly as site/app.ts does, into text.
 */

import { readBytes, safeHref } from '../site/wire.js';
import { type IoState, makeIo, run, type TypedFunc, type TypedProgram } from '../src/core.js';

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
  24: 'h6',
  25: 'b',
  26: 'i',
  27: 'textarea',
  28: 'details',
  29: 'summary',
};
const ATTRS: Record<number, string> = {
  1: 'id',
  2: 'class',
  3: 'href',
  4: 'type',
  5: 'placeholder',
  6: 'aria-label',
};
const VOID = new Set(['input']);

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

export interface Prerendered {
  readonly html: string;
  readonly css: string;
  /** Plain text of the page in document order, for text-only consumers. */
  readonly text: string;
}

/** Run `session` with a render event (0) and interpret its output words. */
export function prerender(program: TypedProgram, entry = 'session'): Prerendered {
  const fn = program.byName.get(entry) as TypedFunc;
  const io: IoState = makeIo([0, 0, 0, 0, 0]);
  run(fn, [io]);
  return renderWords(io.output);
}

export function renderWords(words: readonly number[]): Prerendered {
  const decoder = new TextDecoder();
  const out: string[] = [];
  const text: string[] = [];
  const open: { tag: string; attrs: string[]; styles: string[]; started: boolean }[] = [];
  // Chrome (header, nav, footer) and the animated hero scene carry no content for text readers.
  const skipText = (): boolean =>
    open.some(
      (o) => /^(header|nav|footer)$/.test(o.tag) || o.attrs.some((a) => a.includes('id="live"')),
    );
  let css = '';
  let i = 0;
  // Lengths are clamped to the stream, as in site/app.ts.
  const bytes = (): Uint8Array => {
    const r = readBytes(words, i);
    i = r.next;
    return r.bytes;
  };
  // Attributes may follow OPEN before any child, so the start tag is written lazily.
  const flush = (): void => {
    const top = open[open.length - 1];
    if (top === undefined || top.started) return;
    top.started = true;
    const style = top.styles.length > 0 ? ` style="${top.styles.join(';')}"` : '';
    out.push(`<${top.tag}${top.attrs.join('')}${style}>`);
  };
  while (i < words.length) {
    const cmd = words[i++];
    switch (cmd) {
      case 1: {
        flush();
        open.push({
          tag: TAGS[words[i++] as number] ?? 'div',
          attrs: [],
          styles: [],
          started: false,
        });
        break;
      }
      case 2: {
        flush();
        const s = decoder.decode(bytes());
        out.push(escapeText(s));
        if (!skipText()) text.push(s);
        break;
      }
      case 3: {
        flush();
        const top = open.pop();
        if (top !== undefined && !VOID.has(top.tag)) out.push(`</${top.tag}>`);
        if (
          top !== undefined &&
          /^(h1|h2|h3|p|li|tr|pre|section|footer|div|details|summary)$/.test(top.tag)
        )
          text.push('\n');
        else if (top !== undefined && /^(td|th)$/.test(top.tag)) text.push(' \u2014 ');
        else if (top !== undefined && /^(a|span|strong|code|button|b|i)$/.test(top.tag))
          text.push(' ');
        break;
      }
      case 4: {
        const key = ATTRS[words[i++] as number];
        const value = decoder.decode(bytes());
        const top = open[open.length - 1];
        // The same href rule as the browser runtime: no script or data URLs, no other hosts
        // through `//`.
        if (key === 'href' && !safeHref(value)) break;
        if (key !== undefined && top !== undefined && !top.started) {
          // Motion classes are for the browser runtime; static HTML shows everything at once.
          const v =
            key === 'class'
              ? value.replace(/\breveal\b/, 'reveal in').replace(/\bfill\b/, 'fill grown')
              : value;
          top.attrs.push(` ${key}="${escapeAttr(v)}"`);
        }
        break;
      }
      case 5:
        i += 1;
        break;
      case 6: {
        const n = words[i++] as number;
        i += n;
        break;
      }
      case 8:
        i += 1;
        break;
      case 9:
        css += decoder.decode(bytes());
        break;
      case 10: {
        i += 1;
        const n = words[i++] as number;
        i += n;
        break;
      }
      case 11:
        i += 2;
        break;
      case 12: {
        const prop = words[i++] as number;
        const pct = Math.min(100, words[i++] as number);
        const name = ['width', 'width', 'height', 'left', 'bottom'][prop] ?? 'width';
        const top = open[open.length - 1];
        if (top !== undefined && !top.started) top.styles.push(`${name}:${pct}%`);
        break;
      }
      case 13:
        bytes(); // the scene is drawn by the browser runtime only
        break;
      default:
        i = words.length;
    }
  }
  while (open.length > 0) {
    flush();
    const top = open.pop();
    if (top !== undefined && !VOID.has(top.tag)) out.push(`</${top.tag}>`);
  }
  return {
    html: out.join(''),
    css,
    text: text
      .join('')
      .replace(/ +([.,;:])/g, '$1')
      .replace(/ {2,}/g, ' ')
      .replace(/ \u2014 \n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  };
}

/**
 * Content-Security-Policy of every page, as a `<meta>` (the static host sets no headers): scripts
 * only from the site (the module runtime) plus WebAssembly compilation, styles from the site and
 * the page's own inlined stylesheet, no plugins, no `<base>` rewriting, no form posts, and
 * Trusted Types enforced (the runtime writes no HTML strings). `frame-ancestors` is honoured
 * only as a header, so it is not listed here.
 */
export const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
].join('; ');

/**
 * Put the CSP, the prerendered tree and its stylesheet into a page shell. The stylesheet is raw
 * text inside `<style>`, so a `</style` in it would end the element and open live markup: it is
 * refused.
 */
export function fillShell(shell: string, page: Prerendered): string {
  if (/<\/style/i.test(page.css)) throw new Error('page stylesheet contains </style');
  if (!shell.includes('</head>') || !/<main id="app"[^>]*><\/main>/.test(shell))
    throw new Error('page shell lacks </head> or an empty <main id="app">');
  const csp = `  <meta http-equiv="Content-Security-Policy" content="${escapeAttr(SITE_CSP)}" />\n`;
  return shell
    .replace(/(<meta charset="utf-8" \/>\n)/, `$1${csp}`)
    .replace('</head>', () => `  <style>${page.css}</style>\n</head>`)
    .replace(/(<main id="app"[^>]*>)<\/main>/, (_, open: string) => `${open}${page.html}</main>`);
}
