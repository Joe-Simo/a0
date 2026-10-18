"""Independent replay of the preregistered fixed-object source-cost cohort."""
import hashlib
import json
import math
import pathlib
import statistics
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[3]
out = pathlib.Path(sys.argv[1]).resolve()
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda path: json.loads(path.read_bytes())
prep_bytes = (out / 'preparation.json').read_bytes()
prep = json.loads(prep_bytes)
status = read(out / 'status.json')
samples = read(out / 'samples.json')
proof_bytes = (out / 'worker-proof.json').read_bytes()
proof = json.loads(proof_bytes)
assert status['completed'] and status['outcome'] == 'pass'
assert status['expected'] == status['attempted'] == len(samples) == 144
assert status['preparationSHA256'] == sha(prep_bytes)
assert prep['workerProofSHA256'] == sha(proof_bytes)
assert prep['source'] == status['source'] == proof['checkout']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip() == prep['source']['commit']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=root, text=True).strip() == prep['source']['tree']
assert subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip() == ''
assert sha((root / 'experiments/unification/c-stack-cost/protocol.md').read_bytes()) == prep['protocolSHA256']
assert sha((root / 'dist/tools/source-cost-worker.js').read_bytes()) == prep['workerSHA256']
for item in proof['sdkOutputs'] + proof['historical']['outputs']:
    assert sha((root / item['path']).read_bytes()) == item['sha256']
assert proof['historical']['checkout'] == prep['source']
assert sha((root / 'results/source-frontend-c-stack-relink-artifacts.zip').read_bytes()) == prep['archiveSHA256']
original_bytes = (out / 'archive/inputs/build.json').read_bytes()
original = json.loads(original_bytes)
relink_bytes = (out / 'archive/final/relink.json').read_bytes()
relink = json.loads(relink_bytes)
assert relink['originalBuildSHA256'] == sha(original_bytes)
for side, key in [('baseline', 'control'), ('candidate', 'candidate')]:
    subject = proof['subjects'][key]
    artifact = (out / side / 'frontend.wasm').read_bytes()
    build_bytes = (out / side / 'build.json').read_bytes()
    assert artifact == (out / f'archive/final/{side}/frontend.wasm').read_bytes()
    assert sha(artifact) == relink['artifacts'][side]['sha256'] == subject['preload']['artifactSha256']
    assert len(artifact) == subject['preload']['totalWasmBytes']
    assert subject['buildText'].encode() == build_bytes and json.loads(build_bytes) == subject['build']
    assert subject['preload']['components'] == [{'file': 'frontend.wasm', 'sha256': sha(artifact), 'bytes': len(artifact)}]
    stack = read(out / f'archive/final/{side}/stack-proof.json')
    assert stack['artifactSHA256'] == sha(artifact) and stack['artifactBytes'] == len(artifact)
    assert len(stack['functions']) == 109 and stack['maxLinearStackBytes'] == 127888
assert proof['subjects']['control']['build'] == original
candidate = proof['subjects']['candidate']['build'].copy()
assert candidate.pop('researchOnlyStackRelink') == {
    'kind': 'derived-measurement-descriptor-not-production-build',
    'originalBuildSHA256': sha(original_bytes), 'relinkRecordSHA256': sha(relink_bytes),
    'correctnessArchiveSHA256': prep['archiveSHA256'], 'productionBuildTimeGuardAcceptanceClaimed': False,
}
for key in ['stackBytes', 'wasmBytes', 'wasmSHA256', 'linkerFlags']:
    candidate.pop(key)
assert candidate == {k: v for k, v in original.items() if k not in ['stackBytes', 'wasmBytes', 'wasmSHA256', 'linkerFlags']}
units = prep['inputs']
assert len(units) == 6 and [u['id'] for u in units] == list(range(6))
assert len({u['unit'] for u in units}) == 6
for u in units:
    raw = (out / u['input']).read_bytes()
    assert sha(raw) == u['inputSHA256']
    assert raw == (out / 'archive/frozen' / u['input']).read_bytes()
    assert sha(json.loads(raw)['unified'].encode()) == u['sourceSHA256']
expected = []
arms = ['flat-a0-control', 'flat-a0']
for rnd in range(-1, 11):
    rotation = rnd + 1
    for offset in range(6):
        u = units[(rotation + offset) % 6]
        for pos in range(2):
            expected.append({'index': len(expected), 'round': rnd, 'unit': u['unit'], 'id': u['id'], 'arm': arms[(rotation + u['id'] + pos) % 2], 'warmup': rnd < 0})
assert prep['sequence'] == expected
numeric = [
    'modulePreparationMs', 'postCheckMs', 'beforePreparationRssBytes',
    'beforePreparationHeapUsedBytes', 'beforePreparationExternalBytes',
    'frontendHeapTotalBytes', 'frontendArrayBufferBytes', 'heapTotalBytes',
    'arrayBufferBytes', 'frontendMs', 'emitCMs', 'pipelineMs', 'initialPeakRssBytes',
    'initialRssBytes', 'frontendRssBytes', 'frontendHeapUsedBytes',
    'frontendExternalBytes', 'frontendPeakRssBytes', 'peakRssBytes', 'rssBytes',
    'heapUsedBytes', 'externalBytes', 'wasmLinearMemoryBytes',
]
loads = []
for sample, wanted in zip(samples, expected):
    assert {k: sample[k] for k in wanted} == wanted
    prefix = out / 'raw' / f"{sample['index']:03}"
    stdout = prefix.with_suffix('.stdout').read_bytes()
    stderr = prefix.with_suffix('.stderr').read_bytes()
    assert sha(stdout) == sample['stdoutSHA256']
    assert sha(stderr) == sample['stderrSHA256']
    assert stderr == b''
    assert sample['exitStatus'] == 0 and sample['signal'] is None and 'error' not in sample
    measured = json.loads(stdout)
    assert sample['measurement'] == measured
    side = 'control' if sample['arm'] == 'flat-a0-control' else 'candidate'
    assert measured['preload'] == proof['subjects'][side]['preload']
    u = units[sample['id']]
    assert measured['outputSha256'] == u['measuredOutputSHA256']
    assert measured['outputBytes'] == u['outputBytes']
    for key in numeric:
        assert isinstance(measured[key], (float, int)) and math.isfinite(measured[key]) and measured[key] >= 0, key
    assert math.isfinite(sample['wallMs']) and sample['wallMs'] > 0
    assert measured['pipelineMs'] + 1e-8 >= measured['frontendMs'] + measured['emitCMs']
    for key in ['frontendCpu', 'pipelineCpu', 'processCpu', 'modulePreparationCpu']:
        assert set(measured[key]) == {'user', 'system'}
        assert all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0 for v in measured[key].values())
    assert sum(measured['processCpu'].values()) >= sum(measured['pipelineCpu'].values()) >= sum(measured['frontendCpu'].values())
    for key in ['loadBeforeChild', 'loadAfterChild']:
        assert len(sample[key]) == 3
        assert all(math.isfinite(v) and v >= 0 for v in sample[key])
        assert sample[key][0] <= 10
        loads.append(sample[key][0])
    assert 0 <= measured['loadBefore'] <= 10 and 0 <= measured['loadAfter'] <= 10
    loads.extend([measured['loadBefore'], measured['loadAfter']])
    measured['wallMs'] = sample['wallMs']
    for key in ['frontend', 'pipeline', 'process', 'modulePreparation']:
        measured[key + 'CpuMs'] = sum(measured[key + 'Cpu'].values()) / 1000
metrics = numeric + ['wallMs', 'frontendCpuMs', 'pipelineCpuMs', 'processCpuMs', 'modulePreparationCpuMs']
rows = []
for u in units:
    values = {arm: [s['measurement'] for s in samples if s['id'] == u['id'] and s['arm'] == arm and not s['warmup']] for arm in arms}
    assert all(len(v) == 11 for v in values.values())
    pairs = []
    for rnd in range(11):
        pair = [s for s in samples if s['id'] == u['id'] and s['round'] == rnd]
        assert len(pair) == 2 and {s['arm'] for s in pair} == set(arms)
        pairs.append({s['arm']: s['measurement'] for s in pair})
    row = {'unit': u['unit'], 'id': u['id'], 'metrics': {}}
    for metric in metrics:
        baseline = [v[metric] for v in values[arms[0]]]
        candidate = [v[metric] for v in values[arms[1]]]
        b, c = statistics.median(baseline), statistics.median(candidate)
        differences = [p[arms[1]][metric] - p[arms[0]][metric] for p in pairs]
        percentages = [100 * (p[arms[1]][metric] / p[arms[0]][metric] - 1) if p[arms[0]][metric] else None for p in pairs]
        row['metrics'][metric] = {
            'baseline': {'median': b, 'min': min(baseline), 'max': max(baseline)},
            'candidate': {'median': c, 'min': min(candidate), 'max': max(candidate)},
            'medianDelta': c - b,
            'medianDeltaPercent': 100 * (c / b - 1) if b else None,
            'pairedDifferences': differences,
            'pairedPercentages': percentages,
            'medianPairedDifference': statistics.median(differences),
        }
    rows.append(row)
result = {
    'schema': 1, 'status': 'independent-replay-pass', 'source': prep['source'],
    'children': len(samples), 'warmupChildren': sum(s['warmup'] for s in samples),
    'measuredChildren': sum(not s['warmup'] for s in samples), 'measuredPairs': 66,
    'maxObservedLoad': max(loads), 'metricCount': len(metrics), 'rows': rows,
    'rawSamplesSHA256': sha((out / 'samples.json').read_bytes()),
    'preparationSHA256': sha(prep_bytes), 'workerProofSHA256': sha(proof_bytes),
}
(out / 'analysis.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: v for k, v in result.items() if k != 'rows'}))
