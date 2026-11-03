import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readBenchmarkMeasurement,
  requireStableBenchmarkChecksum,
  validateBenchmarkMeasurement,
} from '../tools/benchmark-protocol.js';

test('benchmark protocol accepts finite positive timings and exact u32 checksums', () => {
  for (const time of ['1', '0.125', '.5', '1.', '2e-6', '+3.5E+2']) {
    assert.deepEqual(readBenchmarkMeasurement(`${time} 4294967295\r\n`), {
      ns: Number(time),
      checksum: '4294967295',
    });
  }
  assert.deepEqual(readBenchmarkMeasurement('runtime banner\n1.25 0\n', true), {
    ns: 1.25,
    checksum: '0',
  });
});

test('benchmark protocol rejects unusable timings and ambiguous output instead of fabricating a score', () => {
  for (const output of [
    '-1 0',
    '0 0',
    '1e9999 0',
    '. 0',
    'NaN 0',
    'Infinity 0',
    '1 0\n2 0',
    '',
    '1 -1',
    '1 4294967296',
    '1 01',
    '1 0 extra',
  ]) {
    assert.throws(() => readBenchmarkMeasurement(output), output);
    assert.throws(() => readBenchmarkMeasurement(output, true), output);
  }
  for (const value of [NaN, Infinity, -Infinity, 0, -1])
    assert.throws(() => validateBenchmarkMeasurement(value, '0'));
});

test('benchmark checksums cannot change in an intermediate sample and later recover', () => {
  requireStableBenchmarkChecksum('7', '7', 'fixture');
  assert.throws(() => requireStableBenchmarkChecksum('6', '7', 'fixture'), /checksum changed/);
});
