#!/usr/bin/env python3
"""Static symbol-reference reachability for fixed generated C; never rewrites C.

All external definitions and canonical nonvariant helpers remain roots. Contexts
add explicit host/test call forms or preserve all variants for open-library C.
This lexical overapproximation unions conditional definitions and counts only
existing byte ranges. It is not a C parser, package proposal or deletion pass.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import re

LEX = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|/\*.*?\*/|//[^\n]*', re.S)
HEAD = re.compile(r'(?m)^([A-Za-z_][^\n;{}]*?)\b(a0[A-Za-z0-9_]+)\([^\n;{}]*\)\s*\{')
TOKEN = re.compile(r'\b(a0[A-Za-z0-9_]+)\b')
VARIANT = re.compile(r'^a0([orv])_')
KINDS = {'o': 'owned', 'r': 'ref', 'v': 'view'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def parse(path):
    raw = path.read_bytes()
    text = raw.decode('ascii')
    masked = LEX.sub(lambda match: ''.join('\n' if c == '\n' else ' ' for c in match[0]), text)
    definitions = collections.defaultdict(list)
    outside = list(masked)
    for match in HEAD.finditer(masked):
        at, depth = match.end(), 1
        while depth:
            assert at < len(masked), 'unterminated definition'
            depth += (masked[at] == '{') - (masked[at] == '}')
            at += 1
        separator_end = at
        while separator_end < len(text) and text[separator_end].isspace():
            separator_end += 1
        name = match[2]
        header = text[match.start():match.end() - 1].strip()
        definitions[name].append({
            'header': header,
            'line': text.count('\n', 0, match.start()) + 1,
            'bytes': at - match.start(),
            'bytesIncludingTrailingWhitespace': separator_end - match.start(),
            'body': masked[match.end():at - 1],
            'external': not re.search(r'\bstatic\b', header),
        })
        outside[match.start():at] = ' ' * (at - match.start())
    names = set(definitions)
    variants = {name for name in names if VARIANT.match(name)}
    assert all(len(definitions[name]) == 1 for name in variants), 'conditional variant needs explicit review'
    graph = {name: set() for name in names}
    calls, bare = collections.Counter(), collections.Counter()
    for name, bodies in definitions.items():
        for definition in bodies:
            for token in TOKEN.finditer(definition['body']):
                target = token[1]
                if target not in names:
                    continue
                graph[name].add(target)
                if target in variants:
                    counter = calls if definition['body'][token.end():].lstrip().startswith('(') else bare
                    counter[target] += 1
    outside_refs = {token[1] for token in TOKEN.finditer(''.join(outside))} & names
    return raw, definitions, variants, graph, calls, bare, outside_refs


def closure(graph, roots):
    parent = {name: None for name in roots}
    queue = collections.deque(sorted(roots))
    while queue:
        name = queue.popleft()
        for target in sorted(graph[name]):
            if target not in parent:
                parent[target] = name
                queue.append(target)
    assert all(graph[name] <= parent.keys() for name in parent), 'fixed point is incomplete'
    return parent


def inspect(path, descriptor):
    raw, definitions, variants, graph, calls, bare, outside = parse(path)
    names = set(definitions)
    external = {name for name, entries in definitions.items() if any(row['external'] for row in entries)}
    canonical_helpers = names - external - variants
    assert not external & variants, 'an external-linkage variant must always be retained as public ABI'
    roots = external | canonical_helpers | outside
    incoming = {name: set() for name in names}
    for source, targets in graph.items():
        for target in targets:
            incoming[target].add(source)
    rows, sets = [], {}
    for context in descriptor['contexts']:
        requested = set(context['extraRoots'])
        extra = requested & names
        context_roots = roots | extra
        if context.get('allVariantsAreRoots'):
            context_roots |= variants
        parents = closure(graph, context_roots)
        live = variants & parents.keys()
        dead = variants - live
        sets[context['name']] = dead
        assert all(not (incoming[name] & parents.keys()) for name in dead)
        rows.append({
            'context': context['name'],
            'meaning': context['meaning'],
            'publicExternalRoots': len(external),
            'additionalCanonicalHelperRoots': len(canonical_helpers),
            'outsideDefinitionReferenceRoots': sorted(outside),
            'requestedExtraRoots': sorted(requested),
            'absentExtraRoots': sorted(requested - names),
            'resolvedExtraRootSignatures': [
                {'symbol': name, 'headers': [row['header'] for row in definitions[name]]}
                for name in sorted(extra)
            ],
            'allVariantsExplicitlyRetained': bool(context.get('allVariantsAreRoots')),
            'reachableVariants': len(live),
            'unreachableVariants': len(dead),
            'unreachableExistingDefinitionBytes': sum(definitions[name][0]['bytes'] for name in dead),
            'unreachableDefinitionAndTrailingWhitespaceBytes': sum(definitions[name][0]['bytesIncludingTrailingWhitespace'] for name in dead),
            'unreachableByKind': {
                kind: {'definitions': sum(bool(re.match('^a0' + prefix + '_', name)) for name in dead),
                       'bytes': sum(definitions[name][0]['bytes'] for name in dead if name.startswith('a0' + prefix + '_'))}
                for prefix, kind in KINDS.items()
            },
            'unreachableDefinitions': [
                {'symbol': name, 'bytes': definitions[name][0]['bytes'],
                 'bytesIncludingTrailingWhitespace': definitions[name][0]['bytesIncludingTrailingWhitespace'],
                 'sourceLine': definitions[name][0]['line'],
                 'referencedOnlyByUnreachableVariants': sorted(incoming[name])}
                for name in sorted(dead)
            ],
        })
    return {
        'sha256': sha(raw),
        'bytes': len(raw),
        'distinctDefinitions': len(names),
        'rawDefinitionsIncludingConditionalBranches': sum(map(len, definitions.values())),
        'externalDefinitions': len(external),
        'externalDefinitionsAllPublicA0Prefix': all(name.startswith('a0_') for name in external),
        'variantDefinitions': len(variants),
        'variantsByKind': {kind: sum(name.startswith('a0' + prefix + '_') for name in variants) for prefix, kind in KINDS.items()},
        'allVariantDefinitionsStatic': all(not row['external'] for name in variants for row in definitions[name]),
        'variantCallReferenceOccurrences': sum(calls.values()),
        'variantBareOrAddressReferenceOccurrences': sum(bare.values()),
        'variantSymbolReferenceGraph': [
            source + ' -> ' + ', '.join(sorted(targets & variants))
            for source, targets in sorted(graph.items()) if targets & variants
        ],
        'graphUsesAllExplicitSymbolReferences': True,
        'conditionalDefinitionReferencesUnioned': True,
        'contexts': rows,
    }, sets, definitions


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('baseline', type=Path)
parser.add_argument('candidate', type=Path)
parser.add_argument('--consumed-abi', type=Path, required=True)
args = parser.parse_args()
descriptor_raw = args.consumed_abi.read_bytes()
descriptor = json.loads(descriptor_raw)
artifacts, dead_sets, definition_sets = {}, {}, {}
for label, path in [('baseline', args.baseline), ('candidate', args.candidate)]:
    artifacts[label], dead_sets[label], definition_sets[label] = inspect(path, descriptor)
assert definition_sets['baseline'].keys() == definition_sets['candidate'].keys(), 'comparison must keep the same functions and variants'
comparison = []
for context in descriptor['contexts']:
    name = context['name']
    baseline, candidate = dead_sets['baseline'][name], dead_sets['candidate'][name]
    comparison.append({
        'context': name,
        'becameReachable': sorted(baseline - candidate),
        'becameReachableExistingDefinitionBytes': sum(definition_sets['candidate'][symbol][0]['bytes'] for symbol in baseline - candidate),
        'becameUnreachable': sorted(candidate - baseline),
        'becameUnreachableExistingDefinitionBytes': sum(definition_sets['candidate'][symbol][0]['bytes'] for symbol in candidate - baseline),
    })
print(json.dumps({
    'schema': 1,
    'status': 'static-inventory-no-pruning-implementation',
    'scope': 'Reference-graph fixed points for the two frozen SAME-S0 C-stage artifacts. Only existing byte ranges are counted. No source/C rewriting, compilation, runtime benchmark, package-size gain or default/library ABI waiver is claimed.',
    'toolSHA256': sha(Path(__file__).read_bytes()),
    'consumedABIDescriptorSHA256': sha(descriptor_raw),
    'rootPolicy': 'Every external public definition and canonical nonvariant helper is retained. Explicit host/shim/test roots are added by context. The default open-library context retains every variant, including arbitrary dynamic/address-taking consumers.',
    'limitations': ['Lexical generated-C analysis, not a general C parser or preprocessor.',
                    'Conditional reference branches are unioned conservatively.',
                    'The frontend consumer context is an overlay onto these S0 stage modules, not a census of a separately built frontend artifact.',
                    'The counted unreachable definition bytes are a raw upper bound; analysis/emitter/package costs and actual emitted or executable savings are unmeasured.',
                    'Default library C and arbitrary module-include hosts retain all variant compatibility.'],
    'artifacts': artifacts,
    'comparison': comparison,
    'timingClaims': False,
}, indent=2))
