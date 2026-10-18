/** Read-only reference-contract probes; never called by compiler or public tools. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, validate, run, checkArgument, A0Error } from '../../../dist/src/core.js';
import { parseDense } from '../../../dist/src/dense.js';
import { parseSource } from '../../../dist/src/source.js';
import { nativeSource } from '../../../dist/src/source-native.js';
import { parseSource as parseSurface } from '../../../dist/tools/surface-v2-frontend.js';
import { writeReport } from '../../../dist/tools/scrub-results.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
process.chdir(root);
const U = (value) => ({ kind: 'u32', value });
const P = (index) => ({ kind: 'param', index });
const N = (id) => ({ kind: 'node', id });
const node = (id, op, args) => ({ id, op, args });
const base = () => parse('fn f u32 -> u32\nn add p0 0\nret n\nend\n');
const constant = (value) => ({
  functions: [{ name: 'f', params: [], result: 'u32', nodes: [], ret: U(value) }],
});
const names = [
  ['negative-zero', -0],
  ['zero', 0],
  ['one', 1],
  ['maximum', 4294967295],
  ['negative-one', -1],
  ['negative-fraction', -0.5],
  ['fraction', 0.5],
  ['minimum-positive', Number.MIN_VALUE],
  ['NaN', NaN],
  ['positive-infinity', Infinity],
  ['negative-infinity', -Infinity],
  ['maximum-plus-one', 4294967296],
  ['huge', 1e50],
];
const result = (program) => {
  try {
    const checked = validate(program);
    let execution;
    if (checked.functions[0].params.length === 0) {
      const value = run(checked.functions[0], []);
      execution = Object.is(value, -0) ? '-0' : String(value);
    }
    return { accepted: true, ...(execution === undefined ? {} : { execution }) };
  } catch (e) {
    if (!(e instanceof A0Error)) throw e;
    return { accepted: false, diagnostic: e.toJSON() };
  }
};
const rows = [];
for (const [label, value] of names) {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value, true);
  const numeric = { label, low: bits.getUint32(0, true), high: bits.getUint32(4, true) };
  let p = base();
  p.functions[0].nodes[0].args = [P(0), U(value)];
  rows.push({ ...numeric, context: 'body operand', ...result(p) });
  p = constant(value);
  rows.push({ ...numeric, context: 'return literal', ...result(p) });
  p = parse('fn f u32 -> u32\nret p0\nend\n');
  p.functions[0].spec = { examples: [{ args: [U(value)], result: U(value) }] };
  rows.push({ ...numeric, context: 'example argument and expected result', ...result(p) });
  p = constant(value);
  p.functions[0].spec = { examples: [{ args: [], result: U(value) }] };
  rows.push({ ...numeric, context: 'return literal matching example result', ...result(p) });
  p = base();
  p.functions[0].spec = { examples: [], pre: node('pre', 'eq', [P(0), U(value)]) };
  rows.push({ ...numeric, context: 'pre operand', ...result(p) });
  p = base();
  p.functions[0].spec = { examples: [], post: node('post', 'eq', [N('r'), U(value)]) };
  rows.push({ ...numeric, context: 'post operand', ...result(p) });
}
const priority = [];
for (const [label, op, args] of [
  ['bad literal before unknown node', 'add', [U(-1), N('missing')]],
  ['unknown node before bad literal', 'add', [N('missing'), U(-1)]],
  ['bad literal before missing parameter', 'add', [U(-1), P(1)]],
  ['wrong arity before bad literal', 'add', [U(-1)]],
  ['bad literal before operation type mismatch', 'add', [U(-1), { kind: 'bool', value: true }]],
  ['array constructor bad literal', 'arr', [U(-1)]],
]) {
  const p = base();
  p.functions[0].nodes[0] = { id: 'n', op, args };
  priority.push({ label, ...result(p) });
}
let p = base();
p.functions[0].nodes[0].args = [U(-1), P(0)];
p.functions[0].ret = U(NaN);
priority.push({ label: 'body bad literal before invalid return literal', ...result(p) });
p = base();
p.functions[0].nodes[0].id = 'bad-name';
p.functions[0].nodes[0].args = [U(-1), P(0)];
priority.push({ label: 'invalid node name before bad literal', ...result(p) });
p = base();
p.functions[0].spec = { examples: [], pre: node('pre', 'eq', [U(-1), N('missing')]) };
priority.push({ label: 'contract binding before bad literal', ...result(p) });
p = base();
p.functions[0].spec = { examples: [], pre: node('pre', 'eq', [U(-1), P(1)]) };
priority.push({ label: 'contract parameter resolution before bad literal', ...result(p) });
p = base();
p.functions[0].spec = { examples: [{ args: [U(-1)], result: { kind: 'bool', value: false } }] };
priority.push({ label: 'example result type before invalid argument execution', ...result(p) });
const report = {
  schema: 1,
  implementationInputCommit: 'f03a575e82fa25cfb88930bf5f4d28fad3fcf21d',
  executionCheckoutCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  rows,
  priority,
};

const spellings = [
  '-0',
  '0',
  '1',
  '4294967295',
  '-1',
  '-0.5',
  '0.5',
  '5e-324',
  'NaN',
  'Infinity',
  '-Infinity',
  '4294967296',
  '1e50',
  '9'.repeat(400),
];
const sourceRows = [];
const inputs = {
  canonical: [parse, (w) => `fn f u32 -> u32\nn add p0 ${w}\nret n\nend\n`],
  flat: [parseSource, (w) => `fn f u32 -> u32\nn add A ${w}\nret n\nend\n`],
  dense: [parseDense, (w) => `fn f\nn add A ${w}\n`],
  denseCompact: [(text) => parseDense(text, { compact: true }), (w) => `fn f\nn add A ${w}\n`],
  surface: [parseSurface, (w) => `fn f(A)\nn=A+${w}\nn\n`],
};
for (const [frontend, [read, text]] of Object.entries(inputs))
  for (const spelling of spellings) {
    try {
      const typed = validate(read(text(spelling)));
      const literals = typed.functions
        .flatMap((f) => [f.ret, ...f.nodes.flatMap((n) => n.args)])
        .filter((a) => a.kind === 'u32')
        .map((a) => a.value);
      if (literals.some((v) => !Number.isInteger(v) || v < 0 || v > 4294967295))
        throw new Error('accepted source created invalid numeric IR');
      sourceRows.push({ frontend, spelling, accepted: true, literals });
    } catch (e) {
      if (!(e instanceof A0Error)) throw e;
      sourceRows.push({ frontend, spelling, accepted: false, diagnostic: e.toJSON() });
    }
  }
try {
  validate(parseDense('fn f (u32,bool) -> u32\nn A.4294967296\n', { compact: true }));
  throw new Error('expected invalid Dense dot field index to fail');
} catch (e) {
  if (!(e instanceof A0Error)) throw e;
  sourceRows.push({
    frontend: 'dense',
    spelling: 'A.4294967296',
    accepted: false,
    diagnostic: e.toJSON(),
  });
}
const argumentsRows = spellings.slice(0, -1).map((label) => {
  const value = Number(label);
  try {
    checkArgument('u32', value, 'p0');
    return { label, accepted: true };
  } catch (e) {
    if (!(e instanceof A0Error)) throw e;
    return { label, accepted: false, diagnostic: e.toJSON() };
  }
});
report.sourceProbes = sourceRows;
report.runtimeArgumentProbes = argumentsRows;

// Optional existing native artifact: this records the current representation refusal,
// not a new checker or a claim of native diagnostic-renderer parity.
if (process.argv[3]) {
  const bytes = readFileSync(process.argv[3]);
  const module = new WebAssembly.Module(bytes);
  const cases = [];
  let input = base();
  cases.push(['valid body', input]);
  input = base();
  input.functions[0].nodes[0].args = [U(NaN), P(0)];
  cases.push(['invalid body operand', input]);
  cases.push(['invalid direct return', constant(-1)]);
  input = base();
  input.functions[0].spec = { examples: [], pre: node('pre', 'eq', [P(0), U(-1)]) };
  cases.push(['invalid pre operand', input]);
  input = base();
  input.functions[0].spec = { examples: [{ args: [U(-1)], result: U(-1) }] };
  cases.push(['invalid example argument', input]);
  input = base();
  input.functions[0].nodes[0].args = [U(-1), N('missing')];
  cases.push(['invalid literal before unknown reference', input]);
  input = base();
  input.functions[0].nodes[0].args = [U(1), P(1)];
  cases.push(['representable missing parameter', input]);
  report.nativeBoundary = {
    artifactBytes: bytes.length,
    artifactSHA256: createHash('sha256').update(bytes).digest('hex'),
    diagnosticsConfigured: false,
    cases: cases.map(([label, program]) => {
      const engine = nativeSource(module);
      try {
        const checked = engine.checkProgram(program);
        return {
          label,
          reference: result(program),
          native: { returned: true, ok: checked.ok, status: checked.status, id: checked.state[1] },
        };
      } catch (error) {
        return {
          label,
          reference: result(program),
          native: { returned: false, errorName: error.name, errorMessage: error.message },
        };
      } finally {
        engine.close();
      }
    }),
  };
}

report.scope =
  'Reference behavior and source reachability inventory only. No API, parser, checker, evaluator or source representation changes. Invalid handbuilt u32 payloads are outside the defined u32 value contract; their current validator behavior is recorded without changing it. These probes are not an exhaustive enumeration of all source strings or a performance measurement.';
report.summary = {
  structuredContexts: rows.length,
  priorityCases: priority.length,
  sourceCases: sourceRows.length,
  acceptedSourceCases: sourceRows.filter((r) => r.accepted).length,
  acceptedInvalidNumericIR: 0,
  runtimeArgumentCases: argumentsRows.length,
};
report.sourceFiles = Object.fromEntries(
  [
    'src/core.ts',
    'src/spec.ts',
    'src/source.ts',
    'src/dense.ts',
    'src/edit.ts',
    'src/mcp.ts',
    'tools/surface-v2-frontend.ts',
    'src/source-native-program.ts',
    'compiler/check_arena_shared.a0',
    'compiler/diagnostics_arena.a0',
  ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
);
report.probeSHA256 = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex');
await writeReport(process.argv[2] ?? 'results/native-numeric-contract.json', report);
console.log(JSON.stringify(report.summary));
