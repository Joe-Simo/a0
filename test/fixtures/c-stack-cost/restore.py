"""Restore the sealed cohort layout for its unchanged, source-pinned analyzer."""
import argparse
import hashlib
import io
import json
import pathlib
import subprocess
import zipfile


ARCHIVE_SHA256 = '83e6e2c33fa67c106ea5947dfeefde6d4edd1b3f54ac837eeb556fe9072a14ba'
SOURCE_COMMIT = '3b60ea376dbd32efd52f8a8f6b1cf6f8c54178b8'
sha = lambda data: hashlib.sha256(data).hexdigest()

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('archive', type=pathlib.Path)
parser.add_argument('--checkout', type=pathlib.Path, required=True)
parser.add_argument('--out', type=pathlib.Path, required=True,
                    help='New directory under the frozen checkout .a0-tmp; relative paths use that checkout')
args = parser.parse_args()
checkout = args.checkout.resolve(strict=True)
out = (checkout / args.out).resolve() if not args.out.is_absolute() else args.out.resolve()
scratch = (checkout / '.a0-tmp').resolve()
assert scratch.is_relative_to(checkout), 'scratch directory escapes checkout'
assert out.is_relative_to(scratch) and out != scratch, 'output must be a new .a0-tmp subdirectory'
assert not out.exists(), 'refusing to overwrite an existing output or cohort'
archive_bytes = args.archive.read_bytes()
assert sha(archive_bytes) == ARCHIVE_SHA256, 'unexpected cost archive'


def git(*arguments):
    return subprocess.check_output(['git', *arguments], cwd=checkout, text=True).strip()


assert git('rev-parse', 'HEAD') == SOURCE_COMMIT, 'use the original measured source checkout'
assert git('status', '--porcelain') == '', 'frozen checkout must be clean'
with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
    assert archive.testzip() is None, 'archive CRC failure'
    names = archive.namelist()
    members = json.loads(archive.read('members.json'))['members']
    assert len(names) == len(set(names)) == 322
    assert len(members) == 321
    assert set(names) == {row['path'] for row in members} | {'members.json'}
    for row in members:
        data = archive.read(row['path'])
        assert len(data) == row['bytes'] == row['rawBytes']
        assert sha(data) == row['sha256'] == row['rawSHA256'] and row['bytePreserved']
    preparation = json.loads(archive.read('preparation.json'))
    proof = json.loads(archive.read('worker-proof.json'))
    assert preparation['source']['commit'] == SOURCE_COMMIT
    assert git('rev-parse', 'HEAD^{tree}') == preparation['source']['tree']
    assert proof['checkout'] == proof['historical']['checkout'] == preparation['source']
    assert sha(archive.read('worker-proof.json')) == preparation['workerProofSHA256']
    for row in proof['sdkOutputs'] + proof['historical']['outputs']:
        assert sha((checkout / row['path']).read_bytes()) == row['sha256'], row['path']
    protocol = checkout / 'experiments/unification/c-stack-cost/protocol.md'
    assert sha(protocol.read_bytes()) == preparation['protocolSHA256']
    correctness = checkout / 'results/source-frontend-c-stack-relink-artifacts.zip'
    assert sha(correctness.read_bytes()) == preparation['archiveSHA256']

    copies = {}

    def copy(source, destination):
        assert destination not in copies, destination
        copies[destination] = archive.read(source)

    for name in ['preparation.json', 'worker-proof.json', 'samples.json', 'status.json']:
        copy(name, name)
    copy('analysis.json', 'expected-analysis.json')
    for index in range(144):
        for extension in ['stdout', 'stderr']:
            name = f'raw/{index:03}.{extension}'
            copy(name, name)
    for side in ['baseline', 'candidate']:
        for name in ['frontend.wasm', 'build.json']:
            copy(f'subjects/{side}/{name}', f'{side}/{name}')
        for name in ['frontend.wasm', 'stack-proof.json']:
            copy(f'subjects/{side}/{name}', f'archive/final/{side}/{name}')
    copy('subjects/original-build.json', 'archive/inputs/build.json')
    copy('subjects/relink.json', 'archive/final/relink.json')
    copy('inputs/index.json', 'archive/frozen/index.json')
    for index in range(6):
        copy(f'inputs/u{index}.json', f'u{index}.json')
        copy(f'inputs/u{index}.json', f'archive/frozen/u{index}.json')

assert git('status', '--porcelain') == '', 'checkout changed before restoration'
# No existing directory is reused. All archive and SDK checks precede writes.
out.mkdir(parents=True, exist_ok=False)
for name, data in copies.items():
    path = out / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(data)
assert git('status', '--porcelain') == '', 'restoration changed tracked source'
print(f'Restored {len(copies)} files. Run the frozen analyzer, then compare analysis.json with expected-analysis.json.')
