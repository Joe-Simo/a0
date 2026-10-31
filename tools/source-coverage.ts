/** Reproducible candidate-language audit; no parser or public-default changes. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { compile } from '../src/backends.js';
import {
  A0Error,
  ALL_OPS,
  formatProgram,
  formatSource as legacySource,
  type Program,
  parse,
  validate,
} from '../src/core.js';
import { revision } from '../src/edit.js';
import { link, parseFile } from '../src/link.js';
import { formatSource, parseSource } from '../src/source.js';
import { nativeSource } from '../src/source-native.js';
import { linkNativeSource } from '../src/source-native-link.js';
import { losslessSourceString } from '../src/source-utf8.js';
import { isReject, listSources } from './dense-loader.js';
import { writeReport } from './scrub-results.js';
import { nativeSourceArtifact } from './source-native-artifact.js';

/** Static literals are evidence, not a claim to extract dynamic template-generated cases. */
async function literals(root: string) {
  const seen = new Set<string>();
  const result: { path: string; line: number; source: string }[] = [];
  for (const name of (await readdir(join(root, 'test'))).sort()) {
    if (!name.endsWith('.ts')) continue;
    const path = `test/${name}`;
    const ast = ts.createSourceFile(
      path,
      await readFile(join(root, path), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        /\bfn\s/.test(node.text) &&
        /\bend\b/.test(node.text) &&
        !seen.has(node.text)
      ) {
        seen.add(node.text);
        result.push({
          path,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          source: node.text,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return result;
}

export async function auditSourceCoverage(root = process.cwd()) {
  const engine = nativeSource(await nativeSourceArtifact());
  const read = (path: string) => readFile(path, 'utf8');
  const converted = new Map<string, string>();
  const ops = new Set<string>();
  const types = new Set<string>();
  const features = {
    strict: 0,
    examples: 0,
    preconditions: 0,
    postconditions: 0,
    text: 0,
    imports: 0,
  };
  const observe = (program: Program) => {
    if (program.profile === 'strict') features.strict++;
    features.imports += program.uses?.length ?? 0;
    for (const fn of program.functions) {
      const pending = [...fn.params, fn.result];
      for (let type = pending.pop(); type !== undefined; type = pending.pop()) {
        if (typeof type === 'string') types.add(type);
        else {
          types.add(type.kind);
          if (type.kind === 'arr') pending.push(type.elem);
          else pending.push(...type.fields);
        }
      }
      features.examples += fn.spec?.examples.length ?? 0;
      if (fn.spec?.pre) features.preconditions++;
      if (fn.spec?.post) features.postconditions++;
      for (const node of fn.nodes) {
        ops.add(node.op);
        if (node.text !== undefined) features.text++;
      }
    }
  };
  const compare = (source: string, expected: Program, label: string) => {
    const actual = engine.parse(source);
    assert.ok(actual.ok, `${label}: native status ${actual.status}, diagnostic ${actual.state[1]}`);
    assert.equal(legacySource(actual.program), legacySource(expected), `${label}: metadata/IR`);
    const typed = validate(expected);
    assert.equal(formatProgram(actual.typed), formatProgram(typed), `${label}: checked IR`);
    for (const fn of typed.functions) {
      const actualFunction = actual.typed.byName.get(fn.name);
      assert.ok(actualFunction, `${label}: function ${fn.name}`);
      assert.equal(revision(actualFunction), revision(fn), `${label}: revision ${fn.name}`);
    }
    for (const target of ['c', 'js'] as const)
      assert.equal(
        compile(actual.typed, target).text,
        compile(typed, target).text,
        `${label}: ${target}`,
      );
    observe(expected);
  };
  const graphs: string[] = [],
    rejects: { path: string; id: string }[] = [];
  const transportRejects: { path: string; line: number; reason: string }[] = [];
  let syntaxRejects = 0,
    candidateLiterals = 0,
    legacyLiterals = 0;
  try {
    for (const path of listSources(root)) {
      const label = relative(root, path);
      if (isReject(path, root)) {
        let program: Program;
        try {
          program = parse(await read(path));
        } catch (error) {
          assert.ok(error instanceof A0Error);
          syntaxRejects++;
          continue;
        }
        let id: string | undefined;
        try {
          validate(parseSource(formatSource(program)));
        } catch (error) {
          assert.ok(error instanceof A0Error);
          id = error.id;
        }
        assert.ok(id, `${label}: reject unexpectedly accepted`);
        const actual = engine.parse(formatSource(program));
        assert.ok(!actual.ok, label);
        assert.equal(`A${String(actual.state[1]).padStart(4, '0')}`, id, label);
        rejects.push({ path: label, id });
        continue;
      }
      const expected = await link(path, read);
      const actual = await linkNativeSource(
        path,
        async (file) => {
          let source = converted.get(file);
          if (source === undefined) {
            source = formatSource((await parseFile(file, read)).program);
            converted.set(file, source);
          }
          return source;
        },
        engine,
      );
      assert.equal(
        legacySource(actual.program),
        legacySource(expected.program),
        `${label}: graph metadata`,
      );
      assert.equal(
        formatProgram(actual.program),
        formatProgram(expected.program),
        `${label}: graph IR`,
      );
      for (const target of ['c', 'js'] as const)
        assert.equal(
          compile(actual.program, target).text,
          compile(expected.program, target).text,
          `${label}: graph ${target}`,
        );
      observe(expected.program);
      graphs.push(label);
    }
    for (const row of await literals(root)) {
      try {
        losslessSourceString(row.source);
      } catch (error) {
        assert.match(String(error), /unpaired UTF-16 surrogate/);
        assert.throws(() => engine.parse(row.source), /unpaired UTF-16 surrogate/);
        transportRejects.push({
          path: row.path,
          line: row.line,
          reason: 'unpaired UTF-16 surrogate',
        });
        continue;
      }
      for (const grammar of ['legacy', 'candidate'] as const) {
        let expected: Program;
        try {
          expected = grammar === 'legacy' ? parse(row.source) : parseSource(row.source);
          validate(expected);
        } catch (error) {
          if (error instanceof A0Error) continue;
          throw error;
        }
        compare(
          grammar === 'legacy' ? formatSource(expected) : row.source,
          expected,
          `${row.path}:${row.line} ${grammar}`,
        );
        if (grammar === 'legacy') legacyLiterals++;
        else candidateLiterals++;
      }
    }
    return {
      scope:
        'All accepted repository graphs plus accepted static top-level test literals; malformed UTF-16 fixtures are checked for transport refusal; dynamic templates and external projects remain outside this audit.',
      graphs,
      rejects,
      syntaxRejects,
      transportRejects,
      legacyLiterals,
      candidateLiterals,
      operations: ALL_OPS.filter((op) => ops.has(op)),
      missingOperations: ALL_OPS.filter((op) => !ops.has(op)),
      types: [...types].sort(),
      features,
      outputs: ['c', 'js'],
      mismatches: 0,
      limitations: [
        'No exhaustive language proof',
        'Static extraction excludes dynamic templates and nested fixture directories',
        'Native cost, independent AI accuracy and full-platform gates remain outstanding',
      ],
    };
  } finally {
    engine.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await auditSourceCoverage();
  await writeReport(process.argv[2] ?? 'results/source-language-coverage.json', result);
  console.log(
    JSON.stringify({
      graphs: result.graphs.length,
      legacyLiterals: result.legacyLiterals,
      candidateLiterals: result.candidateLiterals,
      operations: result.operations.length,
      features: result.features,
      mismatches: result.mismatches,
    }),
  );
}
