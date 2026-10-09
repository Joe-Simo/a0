/**
 * Added cost of `a0 check --dense=a0`: fresh-process wall time of `a0 check FILE.a0` against
 * `a0 check --dense=a0 FILE.a0d` (the dense form of the same program, src/dense.ts formatDense), for
 * single-file programs the A0 reader accepts. Samples are interleaved (canonical, dense, canonical, ...);
 * medians are reported with the Windows CPU load (Win32_Processor LoadPercentage) before and after.
 *
 *   node dist/tools/dense-cli-bench.js [--samples=15] [--out=results/dense-cli-bench.json]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/core.js';
import { formatDense } from '../src/dense.js';
import { ROOT } from './dense-loader.js';
import { reportJson } from './scrub-results.js';

const PROGRAMS = ['examples/kernels.a0', 'examples/life.a0', 'site/lib/fx.a0'];

function load(): number | null {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
      ],
      { encoding: 'utf8' },
    );
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function main(): void {
  const args = process.argv.slice(2);
  const samples = Number(args.find((a) => a.startsWith('--samples='))?.slice(10) ?? 15);
  const out = args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'results/dense-cli-bench.json';
  const cli = join(ROOT, 'dist', 'src', 'cli.js');
  const dir = mkdtempSync(join(tmpdir(), 'a0-dense-bench-'));
  const loadBefore = load();
  const rows = [];
  try {
    for (const rel of PROGRAMS) {
      const canonPath = join(ROOT, rel);
      const program = parse(readFileSync(canonPath, 'utf8'));
      const densePath = join(dir, rel.replace(/[/\\]/g, '_').replace(/\.a0$/, '.a0d'));
      writeFileSync(densePath, formatDense(program));
      const time = (argv: string[]): { ms: number; out: string; ok: boolean } => {
        const t0 = process.hrtime.bigint();
        const r = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8' });
        return {
          ms: Number(process.hrtime.bigint() - t0) / 1e6,
          out: r.stdout,
          ok: r.status === 0,
        };
      };
      const canon: number[] = [];
      const dense: number[] = [];
      let same = true;
      for (let i = 0; i < samples; i += 1) {
        const a = time(['check', canonPath]);
        const b = time(['check', '--dense=a0', densePath]);
        if (!a.ok || !b.ok || a.out !== b.out) same = false;
        canon.push(a.ms);
        dense.push(b.ms);
      }
      rows.push({
        program: rel,
        denseBytes: Buffer.byteLength(formatDense(program)),
        sameOutput: same,
        canonicalMedianMs: Math.round(median(canon)),
        denseA0MedianMs: Math.round(median(dense)),
        ratio: Number((median(dense) / median(canon)).toFixed(2)),
        canonicalMs: canon.map(Math.round),
        denseA0Ms: dense.map(Math.round),
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const loadAfter = load();
  const report = {
    what: 'fresh-process a0 check FILE.a0 vs a0 check --dense=a0 FILE.a0d, interleaved',
    samples,
    cpuLoadPercent: { before: loadBefore, after: loadAfter },
    publishable: loadBefore !== null && loadAfter !== null && loadBefore < 25 && loadAfter < 25,
    rows,
  };
  writeFileSync(join(ROOT, out), reportJson(report));
  process.stdout.write(
    `${JSON.stringify({ ...report, rows: rows.map(({ canonicalMs, denseA0Ms, ...r }) => r) }, null, 1)}\n`,
  );
}

main();
