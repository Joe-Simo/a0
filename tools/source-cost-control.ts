import assert from 'node:assert/strict';

/** Keep transport changes and Wasm build-option experiments in separate matched controls. */
export function verifySourceCostControl(
  candidate: Readonly<Record<string, unknown>>,
  control: Readonly<Record<string, unknown>>,
  transport: boolean,
): void {
  const fields = [
    'sourceSHA256',
    'modules',
    'frontendABI',
    'aggregateBytes',
    'stackBytes',
    'libcSHA256',
    'builtinsSHA256',
    'clang',
    'linker',
    ...(transport
      ? ['clangFlags', 'requiredWasmFeatures', 'optimization', 'symbols', 'symbolFlags']
      : ['cSHA256', 'driverSHA256', 'nativeInputs']),
  ];
  for (const field of fields) {
    assert.ok(Object.hasOwn(candidate, field), `candidate lacks ${field}`);
    assert.ok(Object.hasOwn(control, field), `control lacks ${field}`);
    assert.deepEqual(control[field], candidate[field], `control differs in ${field}`);
  }
}
