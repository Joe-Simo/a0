// Node only, no packages. Two jobs:
//   node summary.mjs speed EXEC.json|- WASM.json|-   print the headline numbers of an exec-bench and a wasm-bench file
//   node summary.mjs same A.json B.json              exit 0 when the files are equal apart from generatedAt
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const [cmd, a, b] = process.argv.slice(2);

function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) if (k !== 'generatedAt') o[k] = strip(v[k]);
    return o;
  }
  return v;
}

if (cmd === 'same') {
  process.exit(JSON.stringify(strip(read(a))) === JSON.stringify(strip(read(b))) ? 0 : 1);
}

if (cmd === 'speed') {
  if (a && a !== '-') {
    const e = read(a);
    console.log(`exec-bench: ${e.platform}, node ${e.node}, ${e.clang}, ${e.rustc ?? 'no rustc'}`);
    console.log(`  samples per side ${e.samplesPerSide}, scale ${e.scale}, load gate ${JSON.stringify(e.loadGate)}`);
    const g = e.geomeans ?? {};
    // A geomean is the baseline's time per call divided by A0's emitted C, over the kernels; above 1 A0 is faster.
    const show = ['c', 'rust', 'zig', 'go', 'java', 'typescript', 'js', 'python'].filter((k) => typeof g[k] === 'number');
    console.log(`  geomean baseline/A0: ${show.map((k) => `${k} ${g[k].toFixed(3)}`).join(', ') || '(none; a quick run)'}`);
  }
  if (b && b !== '-') {
    const w = read(b);
    console.log(`wasm-bench: ${w.platform}, ${w.engine}`);
    console.log(`  ${w.clang}`);
    console.log(`  samples ${w.samples}, load gate ${JSON.stringify(w.loadGate)}`);
    console.log(`  geomean clang/A0 run time ${w.geomeanSpeedup} (above 1 A0 is faster)`);
  }
  process.exit(0);
}

console.error('usage: summary.mjs speed EXEC|- WASM|-   |   summary.mjs same A B');
process.exit(2);
