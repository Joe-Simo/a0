import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { OG_BUDGET } from '../tools/og-cards.js';

const PAGES = [
  { shell: 'site/index.html', url: 'https://a0lang.com/', image: 'home' },
  { shell: 'site/docs.html', url: 'https://a0lang.com/docs/', image: 'docs' },
  { shell: 'site/bench.html', url: 'https://a0lang.com/benchmarks', image: 'benchmarks' },
] as const;

const meta = (html: string, attr: 'name' | 'property', key: string): string | undefined =>
  new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html)?.[1];

function pngSize(b: Buffer): { w: number; h: number } {
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

for (const p of PAGES) {
  test(`${p.shell}: title, description, canonical, Open Graph and Twitter card are complete and the image exists`, async () => {
    const html = await readFile(p.shell, 'utf8');
    assert.match(html, /<title>[^<]{8,70}<\/title>/);
    const desc = meta(html, 'name', 'description') ?? '';
    assert.ok(desc.length >= 60 && desc.length <= 200, `description length ${desc.length}`);
    assert.ok(html.includes(`<link rel="canonical" href="${p.url}" />`));
    assert.equal(meta(html, 'name', 'theme-color'), '#000000');
    assert.equal(meta(html, 'property', 'og:url'), p.url);
    assert.equal(meta(html, 'property', 'og:description'), desc);
    assert.ok(meta(html, 'property', 'og:title'));
    assert.ok((meta(html, 'property', 'og:image:alt') ?? '').length > 20);
    assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image');
    const img = `https://a0lang.com/og/${p.image}.png`;
    assert.equal(meta(html, 'property', 'og:image'), img);
    assert.equal(meta(html, 'name', 'twitter:image'), img);
    assert.equal(meta(html, 'property', 'og:image:width'), '1200');
    assert.equal(meta(html, 'property', 'og:image:height'), '630');
    // honest wording: no claim that cannot be backed
    assert.doesNotMatch(desc, /every target|fastest|best/i);
    // the only inline script is a JSON-LD data block (not executed, so the CSP is untouched)
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)];
    for (const m of inline) {
      assert.match(m[1] ?? '', /type="application\/ld\+json"/);
      assert.equal(JSON.parse(m[2] ?? '')['@context'], 'https://schema.org');
    }
    // the image is committed, 1200x630 and within the byte budget, here and in the deploy copy
    for (const f of [`site/og/${p.image}.png`, `deploy/og/${p.image}.png`]) {
      if (f.startsWith('deploy/') && !existsSync(f)) continue;
      const b = await readFile(f);
      assert.deepEqual(pngSize(b), { w: 1200, h: 630 }, f);
      assert.ok(b.length < OG_BUDGET, `${f} is ${b.length} bytes`);
    }
  });
}

test('the touch icon and 32px favicon exist at their declared sizes', async () => {
  assert.deepEqual(pngSize(await readFile('site/apple-touch-icon.png')), { w: 180, h: 180 });
  assert.deepEqual(pngSize(await readFile('site/favicon-32.png')), { w: 32, h: 32 });
  for (const p of PAGES) {
    const html = await readFile(p.shell, 'utf8');
    assert.ok(html.includes('rel="apple-touch-icon" href="/apple-touch-icon.png"'));
    assert.ok(html.includes('href="/favicon-32.png"'));
  }
});
