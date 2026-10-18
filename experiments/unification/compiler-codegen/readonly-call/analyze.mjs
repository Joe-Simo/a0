import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReport } from '../../../../dist/tools/scrub-results.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (name) => readFileSync(join(root, 'results', name));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const reportBytes = read('source-cost-readonly-call.json');
const sampleBytes = read('source-cost-readonly-call-samples.json');
assert.equal(hash(reportBytes), 'a5ea0dd6edb1229a54815243782692eddb0a44aa5deab571c62bd3e5900beab0');
assert.equal(hash(sampleBytes), 'e4faf1bfa6ba79b6dc355dcebea2dca42908283af75068055b99711d73bb3a81');
const report = JSON.parse(reportBytes);
const samples = JSON.parse(sampleBytes);
const accepted = samples.filter((sample) => !sample.warmup);
const arms = Object.keys(report.rows[0].arms);
const fields = Object.keys(report.rows[0].arms[arms[0]]);
const median = (values) => {
  assert.ok(values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  assert.equal(sorted.length % 2, 1);
  return sorted[(sorted.length - 1) / 2];
};

assert.equal(samples.length, report.samples);
assert.equal(
  samples.length,
  report.rows.length * arms.length * (report.measuredRounds + report.warmups),
);
assert.equal(accepted.length, report.rows.length * arms.length * report.measuredRounds);
const cellKeys = samples.map((sample) => `${sample.unit}|${sample.arm}|${sample.round}`);
assert.equal(new Set(cellKeys).size, cellKeys.length);
const maxLoad1 = Math.max(
  ...samples.flatMap((sample) => [sample.load[0], sample.loadBefore, sample.loadAfter]),
);
assert.equal(maxLoad1, report.maxLoad1);
assert.ok(maxLoad1 <= 10);

let verifiedReportedMedians = 0;
const rows = report.rows.map((row) => {
  const expectedOutput = report.outputControls.find((control) => control.unit === row.unit);
  assert.ok(expectedOutput);
  const measuredArms = Object.fromEntries(
    arms.map((arm) => {
      const cells = samples.filter((sample) => sample.unit === row.unit && sample.arm === arm);
      assert.deepEqual(
        cells.map((sample) => sample.round).sort((a, b) => a - b),
        [-1, 0, 1, 2, 3, 4, 5, 6],
      );
      for (const cell of cells) {
        assert.equal(cell.warmup, cell.round === -1);
        assert.equal(cell.outputSha256, expectedOutput.expectedSHA256);
        assert.equal(
          cell.preload.artifactSha256,
          arm === 'flat-a0-control' ? report.controlPreload.artifactSha256 : report.artifact.sha256,
        );
      }
      const measured = cells.filter((sample) => !sample.warmup);
      const values = Object.fromEntries(
        fields.map((field) => {
          const value = median(measured.map((sample) => sample[field]));
          assert.equal(value, row.arms[arm][field], `${row.unit};${arm};${field}`);
          verifiedReportedMedians += 1;
          return [field, value];
        }),
      );
      values.frontendProcessCpuMs = median(
        measured.map((sample) => (sample.frontendCpu.user + sample.frontendCpu.system) / 1000),
      );
      return [arm, values];
    }),
  );
  const candidate = measuredArms['flat-a0'];
  const comparisons = Object.fromEntries(
    arms
      .filter((arm) => arm !== 'flat-a0')
      .map((arm) => {
        const control = measuredArms[arm];
        const comparedFields = Object.fromEntries(
          Object.keys(candidate).map((field) => [
            field,
            {
              candidate: candidate[field],
              control: control[field],
              difference: candidate[field] - control[field],
              ratio: control[field] === 0 ? null : candidate[field] / control[field],
            },
          ]),
        );
        const pairedFrontendRatios = accepted
          .filter((sample) => sample.unit === row.unit && sample.arm === 'flat-a0')
          .map((sample) => {
            const paired = accepted.find(
              (other) =>
                other.unit === row.unit && other.arm === arm && other.round === sample.round,
            );
            assert.ok(paired);
            return { round: sample.round, ratio: sample.frontendMs / paired.frontendMs };
          })
          .sort((a, b) => a.round - b.round);
        return [
          arm,
          {
            fields: comparedFields,
            increasedMedianFields: Object.keys(comparedFields).filter(
              (field) => comparedFields[field].difference > 0,
            ),
            pairedFrontendRatios,
            slowerFrontendPairs: pairedFrontendRatios.filter((pair) => pair.ratio > 1).length,
          },
        ];
      }),
  );
  return { unit: row.unit, medians: measuredArms, comparisons };
});

await writeReport(join(root, 'results', 'source-cost-readonly-call-analysis.json'), {
  schema: 1,
  scope:
    'Independent descriptive recomputation from every frozen raw cell. Every median field and increase is retained, including process frontend CPU. No uncertainty interval, significance test, causal attribution, general gain, no-regression, official source cutover, default adoption, CLI/model/target execution or combined-candidate claim.',
  candidate: report.candidate,
  control: report.control,
  baseline: report.baseline,
  controlMode: report.controlMode,
  reportSHA256: hash(reportBytes),
  samplesSHA256: hash(sampleBytes),
  cells: samples.length,
  acceptedCells: accepted.length,
  verifiedReportedMedians,
  independentlyDerivedCpuMedians: report.rows.length * arms.length,
  everyCellOutputHashVerified: true,
  everyCellPreloadIdentityVerified: true,
  maxLoad1,
  candidateWasmBytes: report.artifact.bytes,
  controlWasmBytes: report.controlPreload.totalWasmBytes,
  candidateWasmSHA256: report.artifact.sha256,
  controlWasmSHA256: report.controlPreload.artifactSha256,
  rows,
});
console.log(
  `PASS ${verifiedReportedMedians} reported medians, ${report.rows.length * arms.length} CPU medians; ${accepted.length}/${samples.length} accepted cells; every loss retained`,
);
