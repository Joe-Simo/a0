/** The existing EditSession, supplied exclusively with the shared A0 source authority. */
import type { Func, Program, TypedProgram } from './core.js';
import {
  EditSession,
  type EditSessionLanguage,
  editProgramWithLanguage,
  lineEditBlocksWithLanguage,
  placeNewCalleesWithLanguage,
  programNeighbourhood,
  replaceNodesWithLanguage,
  type SessionOptions,
  validateOrderedWith,
} from './edit.js';
import { type EditSourceLine, editSourceJoin, editSourceSlice } from './edit-source.js';
import type { nativeSource } from './source-native.js';
import { nativeEditLanguage } from './source-native-edit.js';
import { nativeEditRows } from './source-native-edit-rows.js';
import { NativeEditDiagnostic, NativeEditSourceError } from './source-native-edit-source.js';
import { NativeSourceError } from './source-native-link.js';
import { parseNativeNodeEditOps } from './source-native-node-edit.js';
import { nativeSpecEditLanguage } from './source-native-spec-edit.js';
import { losslessSourceString } from './source-utf8.js';
import { applySpecEditsWithLanguage, type SpecEdit, type SpecWord } from './spec.js';

type Frontend = ReturnType<typeof nativeSource>;

/** Borrowed frontend lifetime belongs to the caller; no second session or source-language mode. */
export function createNativeEditSession(
  program: TypedProgram,
  frontend: Frontend,
  options: SessionOptions = {},
): EditSession {
  const baseAuthority = nativeEditLanguage(frontend);
  let rows = nativeEditRows(frontend);
  const authority = {
    ...baseAuthority,
    check(candidate: Program): TypedProgram {
      const result = frontend.checkProgram(candidate);
      if (!result.ok) {
        const raw = new NativeSourceError(result);
        if (raw.a0Error === undefined) throw raw;
        const mapped = rows.diagnostic(raw.a0Error, candidate, result.state);
        throw new NativeEditDiagnostic(
          new NativeEditSourceError(result, mapped.sourceRows),
          mapped.error,
        );
      }
      rows.transfer(candidate, result.typed);
      return result.typed;
    },
  };

  const revision = (value: Program, kind: 'function' | 'program'): string => {
    const active = frontend.activateProgramForFormat(value);
    if (!active.ok)
      throw new Error(
        `native session revision activation refused: ${'reason' in active ? active.reason : active.status}`,
      );
    const result = frontend.revision(active.input, { kind });
    if (!result.ok)
      throw new Error(
        `native session revision refused: ${'reason' in result ? result.reason : result.status}`,
      );
    return result.revision;
  };
  const protocolLine = (row: EditSourceLine, text: string): EditSourceLine => {
    const start = row.text.indexOf(text);
    if (start < 0) throw new Error('native protocol substring lost its source');
    return editSourceSlice(row, start);
  };
  const specs = (fn: Func, edits: readonly SpecEdit[]) =>
    applySpecEditsWithLanguage(fn, edits, nativeSpecEditLanguage(frontend, fn, rows.remember));
  const language: EditSessionLanguage = {
    revision: (fn) => revision({ functions: [fn] }, 'function'),
    programRevision: (value) => revision(value, 'program'),
    signature: authority.signature,
    acceptView(view) {
      if (view.dense === true || ('compact' in view && view.compact === true))
        throw new Error('native session accepts only the shared A0 source syntax');
    },
    beginReply(raw) {
      losslessSourceString(raw, 'native edit reply');
      rows = nativeEditRows(frontend);
    },
    bodyLines: (source) => [...source],
    protocolLine,
    functionView(_value, fn, view) {
      const render = (shown: Func, numbered: boolean) => {
        const source = rows.render(shown, view.specs === 'hide' && !numbered);
        return editSourceJoin(
          numbered
            ? source.map((row, index) =>
                index === 0 || index === source.length - 1 ? row : { text: `${index} ${row.text}` },
              )
            : source,
        );
      };
      const target = render(fn, view.numbered === true);
      if (view.scope === 'bodies')
        return [target, ...[...fn.calls.values()].map((callee) => render(callee, false))].join(
          '\n',
        );
      if (view.scope === 'deps')
        return [
          target,
          ...[...fn.calls.values()].map((callee) => `${authority.signature(callee)} end`),
        ].join('\n');
      return target;
    },
    programView(value, target) {
      const scoped = target !== undefined && value.byName.has(target);
      const shown = scoped ? programNeighbourhood(value, target) : value.functions;
      return [
        ...(scoped
          ? [`# ${value.functions.length} functions; shown: ${target}, its callees, its callers`]
          : []),
        ...(value.profile === 'strict' ? ['profile strict'] : []),
        ...shown.map((fn) => `${authority.signature(fn)} end`),
      ].join('\n');
    },
    lineBlocks(value, source, defaultFn) {
      const cache = new Map<Func, EditSourceLine[]>();
      return lineEditBlocksWithLanguage(value, source, defaultFn, {
        protocolLine,
        render(fn) {
          const saved = cache.get(fn);
          if (saved !== undefined) return saved;
          const output = rows.render(fn);
          cache.set(fn, output);
          return output;
        },
        parse(source) {
          const parsed = rows.parse(source).functions[0];
          if (parsed === undefined) throw new Error('native numbered edit lost its function');
          return parsed;
        },
        specs,
      });
    },
    editProgram(value, source, keepSpecs) {
      return editProgramWithLanguage(
        value,
        source,
        {
          ...authority,
          parseUnit: (_text, sourceRows) => {
            if (sourceRows === undefined)
              throw new Error('missing native session source ownership');
            return rows.parse(sourceRows);
          },
        },
        keepSpecs,
      );
    },
    editNodes(previous, value, fn, source) {
      const edits = parseNativeNodeEditOps(
        fn,
        editSourceJoin(source),
        frontend,
        source,
        (match, line, _index, sourceRow) => ({
          sign: match[2] as '+' | '-',
          word: match[3] as SpecWord,
          rest: (match[4] ?? '').trim(),
          line,
          ...(sourceRow === undefined ? {} : { source: sourceRow }),
        }),
      );
      const placed = placeNewCalleesWithLanguage(previous, value, fn.name, edits, authority);
      const target = placed.byName.get(fn.name) ?? fn;
      return replaceNodesWithLanguage(target, edits, {
        specs,
        check(replaced, normalized) {
          for (const op of normalized) {
            if (op.source === undefined) continue;
            if (op.kind === 'node') {
              const node = replaced.nodes.find((node) => node.id === op.node.id);
              if (node !== undefined) rows.remember(node, 'node', op.source);
            } else if (op.kind === 'ret') rows.remember(replaced, 'ret', op.source);
          }
          return validateOrderedWith(
            {
              ...placed,
              functions: placed.functions.map((candidate) =>
                candidate === target ? replaced : candidate,
              ),
            },
            authority.check,
            authority.failure,
          );
        },
      });
    },
  };
  return new EditSession(program, options, language);
}
