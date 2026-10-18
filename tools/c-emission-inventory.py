#!/usr/bin/env python3
"""Read-only lexical census of two fixed generated C artifacts; no timing claim.

Prints JSON to stdout. Archive it through tools/scrub-results.ts writeReport.
Function/call-looking token counts describe these generated fixtures, not a C AST.
"""
import argparse
import collections
import hashlib
import json
import re
from pathlib import Path


LEX = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|/\*.*?\*/|//[^\n]*', re.S)
HEAD = re.compile(r'(?m)^([A-Za-z_][^\n;{}]*?)\b(a0[A-Za-z0-9_]+)\([^\n;{}]*\)\s*\{')


def group(name):
    for prefix, label in [('a0o_', 'owned'), ('a0r_', 'ref'), ('a0v_', 'view'), ('a0_', 'value')]:
        if name.startswith(prefix):
            return label
    return 'helper'


def inspect(path):
    raw = path.read_bytes()
    text = raw.decode('ascii')
    masked = LEX.sub(lambda m: ''.join('\n' if c == '\n' else ' ' for c in m[0]), text)
    functions = {}
    headers = {}
    conditional_redefinitions = []
    occurrences = []
    for match in HEAD.finditer(masked):
        at, depth = match.end(), 1
        while depth:
            assert at < len(masked), 'unterminated function'
            depth += (masked[at] == '{') - (masked[at] == '}')
            at += 1
        name = match[2]
        if name in functions:
            conditional_redefinitions.append(name)
        functions[name] = text[match.start():at]
        headers[name] = text[match.start():match.end() - 1].strip()
        occurrences.append((name, at - match.start()))
    counts = collections.Counter(group(name) for name in functions)
    sizes = collections.Counter()
    for name, body in functions.items():
        sizes[group(name)] += len(body)
    stats = {
        'sha256': hashlib.sha256(raw).hexdigest(),
        'bytes': len(raw),
        'distinctFunctionNames': len(functions),
        'rawFunctionDefinitionsIncludingPreprocessorBranches': len(occurrences),
        'conditionalRedefinitions': conditional_redefinitions,
        'counts': dict(counts),
        'bytesByCategory': dict(sizes),
        'lastDefinitionBytesByName': sum(map(len, functions.values())),
        'allFunctionDefinitionBytes': sum(size for _, size in occurrences),
        'outsideAllFunctionBytes': len(text) - sum(size for _, size in occurrences),
        'fullStateAssignments': len(re.findall(r'\*p0\s*=', text)),
        'voidParamStatements': len(re.findall(r'\(void\)p\d+;', text)),
        'allVoidStatements': len(re.findall(r'\(void\)', text)),
        'constAggregatePointerLocals': len(re.findall(r'const a0t\w* \*const n_?\w+', text)),
        'aggregateLocals': len(re.findall(r'(?m)^  (?:const )?a0t\w* n_?\w+\s*[=;]', text)),
        'aggregatePointerLocals': len(re.findall(r'(?m)^  (?:const )?a0t\w* \*const n_?\w+', text)),
        'arenaAllocCallTokens': len(re.findall(r'\ba0arena_alloc\(', text)),
        'ownedCallTokens': len(re.findall(r'\ba0o_\w+\(', text)),
        'refCallTokens': len(re.findall(r'\ba0r_\w+\(', text)),
        'typeNameTokens': len(re.findall(r'\ba0t\w*\b', text)),
        'typeNameTokenBytes': sum(len(m[0]) for m in re.finditer(r'\ba0t\w*\b', text)),
    }
    return text, functions, headers, stats


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('old', type=Path)
parser.add_argument('new', type=Path)
args = parser.parse_args()
old_text, old, old_headers, old_stats = inspect(args.old)
text, new, headers, new_stats = inspect(args.new)
common = old.keys() & new.keys()
growth = sorted(common, key=lambda name: len(new[name]) - len(old[name]), reverse=True)
owned = []
for name, header in headers.items():
    if not name.startswith('a0o_'):
        continue
    value = 'a0_' + name[4:]
    assert value in headers
    parameters = headers[value].split('(', 1)[1].rsplit(')', 1)[0].split(',')
    public_p0 = next(p for p in parameters if re.search(r'\bp0\s*$', p))
    small = '*' not in public_p0  # Existing public ABI uses pointers exactly for large p0.
    borrowed_extras = [int(i) for i in re.findall(r'const a0t\w+ \* p(\d+)', header) if int(i) >= 2]
    owned.append({'name': name, 'smallState': small, 'scalarOnlyExtras': not borrowed_extras,
                  'publicDefinitionBytes': len(new[value])})
references = collections.Counter(re.findall(r'\b(a0\w+)\(', text))
aggregate_helpers = [name for name in new if re.fullmatch(r'a0(?:mk|zero|set|put)_\w+', name)]
unused_helpers = [name for name in aggregate_helpers if references[name] == 1]
print(json.dumps({
    'schema': 1,
    'method': 'Static lexical census of frozen SAME-S0 generated C. Raw bytes only; no transformed output, native build, execution, timing, or promised savings.',
    'old': old_stats,
    'new': new_stats,
    'commonFunctionCount': len(common),
    'commonFunctionDefinitionGrowth': sum(len(new[name]) - len(old[name]) for name in common),
    'topCommonDefinitionGrowth': [
        {'name': name, 'oldBytes': len(old[name]), 'newBytes': len(new[name]),
         'growth': len(new[name]) - len(old[name])} for name in growth[:22]
    ],
    'bodySharingHypothesis': {
        'smallStateCandidates': sum(row['smallState'] for row in owned),
        'largeStateCandidates': sum(not row['smallState'] for row in owned),
        'smallStatePublicDefinitionBytes': sum(row['publicDefinitionBytes'] for row in owned if row['smallState']),
        'smallStateScalarOnlyExtrasCandidates': sum(row['smallState'] and row['scalarOnlyExtras'] for row in owned),
        'smallStateScalarOnlyExtrasPublicDefinitionBytes': sum(row['publicDefinitionBytes'] for row in owned if row['smallState'] and row['scalarOnlyExtras']),
        'candidates': owned,
    },
    'privateAggregateHelpers': {
        'definitions': len(aggregate_helpers),
        'definitionOnly': len(unused_helpers),
        'definitionOnlyBytes': sum(len(new[name]) for name in unused_helpers),
    },
}, indent=2))
