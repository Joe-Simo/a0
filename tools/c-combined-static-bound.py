#!/usr/bin/env python3
"""Static optimistic package bounds; no compiler or generated-C transformation.

Uses the existing reference-graph reader and an existing sharing-census result.
Deleting type tokens entirely is deliberately impossible C, not an alias design.
"""
import argparse
import contextlib
import hashlib
import io
import json
from pathlib import Path
import re
import runpy
import sys


def identity(path):
    raw = path.read_bytes()
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('baseline', type=Path)
parser.add_argument('candidate', type=Path)
parser.add_argument('source', type=Path)
parser.add_argument('--sharing-census', type=Path, required=True)
parser.add_argument('--consumed-abi', type=Path, required=True)
parser.add_argument('--optimized-proof', type=Path, default=Path('results/c-stage-standard-optimizer.json'))
parser.add_argument('--package-inventory', type=Path, default=Path('results/c-emission-static-inventory.json'))
args = parser.parse_args()
optimized = json.loads(args.optimized_proof.read_bytes())
package = json.loads(args.package_inventory.read_bytes())['packageLowerBound']
census = json.loads(args.sharing_census.read_bytes())
source = identity(args.source)
baseline = identity(args.baseline)
candidate = identity(args.candidate)
assert source == {'bytes': optimized['reproduction']['sourceBytes'],
                  'sha256': optimized['reproduction']['sourceSHA256']}
assert baseline == {'bytes': optimized['reproduction']['rows'][-1]['cBytes'],
                    'sha256': optimized['reproduction']['rows'][-1]['cSHA256']}
assert census['status'] == 'passed' and census['wrapperCount'] == 263
assert census['sameSignaturesAndVariantSymbols']
assert census['nonwrapperBodiesAndCallRoutesByteIdentical'] and census['allOtherTextByteIdentical']
assert baseline == {'bytes': census['baselineBytes'], 'sha256': census['baselineSHA256']}
assert candidate == {'bytes': census['candidateBytes'], 'sha256': census['candidateSHA256']}
sys.argv = ['tools/c-variant-reachability.py', str(args.baseline), str(args.candidate),
            '--consumed-abi', str(args.consumed_abi)]
with contextlib.redirect_stdout(io.StringIO()):
    graph = runpy.run_path('tools/c-variant-reachability.py')
artifacts = graph['artifacts']
definitions = graph['definition_sets']['candidate']
type_token = re.compile(r'\ba0t_[A-Za-z0-9_]+\b')
mandatory = sum(row['bytes'] for row in package['mandatory'])
retained = sum(row['bytes'] for row in package['retained'])
assert source['bytes'] + baseline['bytes'] + mandatory + retained == package['totalBytes']
rows = []
for context in artifacts['candidate']['contexts']:
    dead = graph['dead_sets']['candidate'][context['context']]
    body_tokens, internal_header_tokens = [], []
    for name, entries in definitions.items():
        if name in dead:
            continue
        for definition in entries:
            body_tokens.extend(type_token.findall(definition['body']))
            if not definition['external']:
                internal_header_tokens.extend(type_token.findall(definition['header']))
    body_bytes = sum(map(len, body_tokens))
    private_header_bytes = sum(map(len, internal_header_tokens))
    variant_bytes = context['unreachableDefinitionAndTrailingWhitespaceBytes']
    actual_known_components = source['bytes'] + candidate['bytes'] + mandatory + retained
    after_free_variants = actual_known_components - variant_bytes
    after_free_body_types = after_free_variants - body_bytes
    after_free_all_internal_types = after_free_body_types - private_header_bytes
    rows.append({
        'context': context['context'],
        'existingCandidateCBytes': candidate['bytes'],
        'unreachableVariants': len(dead),
        'unreachableDefinitionAndOwnTrailingWhitespaceBytes': variant_bytes,
        'remainingBodyAggregateTypeTokenCount': len(body_tokens),
        'remainingBodyAggregateTypeTokenBytes': body_bytes,
        'remainingPrivateHeaderAggregateTypeTokenCount': len(internal_header_tokens),
        'remainingPrivateHeaderAggregateTypeTokenBytes': private_header_bytes,
        'unchangedSourcePlusCandidateCPlusKnownRequiredFiles': actual_known_components,
        'optimisticAfterFreeVariantOmissionBytes': after_free_variants,
        'impossibleAfterAlsoDeletingAllBodyTypeTokensBytes': after_free_body_types,
        'impossibleAfterAlsoDeletingPrivateHeaderTypeTokensBytes': after_free_all_internal_types,
        'excessOverUnchangedCeilingEvenWithImpossibleDeletions': after_free_all_internal_types - package['ceilingBytes'],
        'couldMeetCeilingEvenWithImpossibleDeletions': after_free_all_internal_types <= package['ceilingBytes'],
    })
print(json.dumps({
    'schema': 1,
    'status': 'combined-static-bound-no-implementation',
    'scope': 'Existing verified Sopt source emitted by the isolated existing-owned-sharing compiler. Reference graphs and type-token byte arithmetic only; generated output is never rewritten.',
    'decision': 'The combined bound still exceeds the unchanged ceiling even with impossible free deletions. Defer alias/pruning implementation and default adoption; no timing conclusion.',
    'toolSHA256': identity(Path(__file__))['sha256'],
    'inputs': {
        'source': source, 'baselineC': baseline, 'candidateC': candidate,
        'sharingCensus': identity(args.sharing_census),
        'consumedABIDescriptor': identity(args.consumed_abi),
        'optimizedProof': identity(args.optimized_proof),
        'packageInventory': identity(args.package_inventory),
        'referenceGraphTool': identity(Path('tools/c-variant-reachability.py')),
    },
    'sharingCensus': census,
    'variantReferenceGraph': artifacts,
    'packageLowerBound': package,
    'combinedContexts': rows,
    'boundAssumptions': [
        'Retain the unchanged Sopt source at zero cost for incorporating sharing, root analysis, interned type writing or other implementation changes. It is not a self-reproducing combined candidate.',
        'Keep the existing public/canonical type declarations, public signatures, exported names and all outside-function text.',
        'Count unreachable variants using explicit consumer roots. The default library retains every variant.',
        'Omit each unreachable definition and its own trailing whitespace for free; type tokens inside those definitions are excluded to avoid double counting.',
        'Then delete every aggregate type-name token in every retained function body for free, and additionally every private function header token. Zero-length type names are invalid C and strictly overestimate any alias savings.',
        'Charge no alias definitions, emitted references, compiler source, memory, build or runtime cost.',
        'Retain the earlier verified mandatory host/runtime/script and frontend fixture/notices snapshots without modification; final metadata and other package files remain excluded.',
    ],
    'existingCompilerSourceEditedForInventory': False,
    'generatedCRewritten': False,
    'candidateCCompiledOrExecuted': False,
    'packageAssembled': False,
    'defaultAdopted': False,
    'timingClaims': False,
}, indent=2))
