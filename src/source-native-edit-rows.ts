/** Native formatter rows and authentic parser ownership for numbered/session transactions. */
import type { Func, Node, Program } from './core.js';
import { type EditSourceLine, type EditSourceOwner, editSourceJoin } from './edit-source.js';
import type { nativeSource } from './source-native.js';
import { nativeEditEventText, nativeEditFormat } from './source-native-edit-context.js';
import { throwNativeEditSource } from './source-native-edit-source.js';
import type { Spec, SpecExample } from './spec.js';

type Frontend = ReturnType<typeof nativeSource>;
type Kind = EditSourceOwner['kind'];

/** Weak provenance follows immutable decoded IR objects; caches never retain old programs. */
export function nativeEditRows(frontend: Frontend) {
  const provenance = new WeakMap<object, Map<Kind, EditSourceLine>>();
  const saved = (value: object, kind: Kind) => provenance.get(value)?.get(kind);
  const remember = (value: object, kind: Kind, row: EditSourceLine | undefined) => {
    if (row === undefined) return;
    const fields = provenance.get(value) ?? new Map();
    fields.set(kind, row);
    provenance.set(value, fields);
  };
  const render = (fn: Func, skipSpecs = false): EditSourceLine[] => {
    const output = nativeEditFormat(frontend, fn),
      header = nativeEditFormat(frontend, fn, 'signature').text.trimEnd();
    const rows: { start: number; row: EditSourceLine }[] = [];
    let node = 0,
      example = 0,
      contract = 0,
      ret = 0,
      end = 0;
    const contracts = ([fn.spec?.pre, fn.spec?.post] as const).filter(
      (value): value is Node => value !== undefined,
    );
    for (let at = 0; at < output.events.length; at += 6) {
      const kind = output.events[at];
      let owner: EditSourceOwner, value: object;
      if (kind === 4) {
        owner = { fn, kind: 'node', index: node };
        value = fn.nodes[node++] as Node;
      } else if (kind === 12) {
        if (skipSpecs) continue;
        owner = { fn, kind: 'example', index: example };
        value = fn.spec?.examples[example++] as SpecExample;
      } else if (kind === 14) {
        if (skipSpecs) continue;
        const expression = contracts[contract++];
        if (expression === undefined) throw new Error('invalid native contract row ownership');
        owner = { fn, kind: expression.id === 'pre' ? 'pre' : 'post' };
        value = expression;
      } else if (kind === 10) {
        owner = { fn, kind: 'ret' };
        value = fn;
        ret++;
      } else if (kind === 22) {
        owner = { fn, kind: 'end' };
        value = fn;
        end++;
      } else continue;
      if (value === undefined) throw new Error('invalid native edit row ownership');
      const source = saved(value, owner.kind);
      rows.push({
        start: output.events[at + 3] as number,
        row: {
          text: nativeEditEventText(output, at),
          owner,
          ...(source?.origin === undefined ? {} : { origin: source.origin }),
        },
      });
    }
    if (
      node !== fn.nodes.length ||
      ret !== 1 ||
      end !== 1 ||
      (!skipSpecs && (example !== (fn.spec?.examples.length ?? 0) || contract !== contracts.length))
    )
      throw new Error('incomplete native edit row mapping');
    rows.sort((a, b) => a.start - b.start);
    const original = saved(fn, 'header');
    return [
      {
        text: header,
        owner: { fn, kind: 'header' },
        ...(original?.origin === undefined ? {} : { origin: original.origin }),
      },
      ...rows.map(({ row }) => row),
    ];
  };
  const parse = (rows: readonly EditSourceLine[]): Program => {
    const unit = frontend.parseUnit(editSourceJoin(rows));
    if (!unit.ok) throwNativeEditSource(unit, rows);
    const origins = frontend.unitSourceOrigins(unit);
    const functions = unit.program.functions.map((fn, functionIndex): Func => {
      const owner = origins.functions[functionIndex];
      if (owner === undefined) throw new Error('missing native parsed function ownership');
      const row = (line: number) => rows[line - 1];
      const owned = (source: EditSourceLine | undefined, kind: Kind) =>
        source?.owner?.kind === kind ? source.owner : undefined;
      const header = row(owner.header.line),
        end = row(owner.end.line),
        ret = row(owner.ret.line);
      const previous = owned(header, 'header')?.fn;
      const restoreNode = (
        node: Node,
        source: EditSourceLine | undefined,
        kind: 'node' | 'pre' | 'post',
      ): Node => {
        const prior = owned(source, kind);
        const old =
          prior === undefined
            ? undefined
            : kind === 'node'
              ? prior.fn.nodes[prior.index as number]
              : prior.fn.spec?.[kind];
        const restored =
          old === undefined
            ? node
            : { ...node, ...(old.comments === undefined ? {} : { comments: old.comments }) };
        remember(restored, kind, source);
        return restored;
      };
      const nodes = fn.nodes.map((node, index) => {
        const location = owner.nodes[index];
        if (location === undefined) throw new Error('missing native parsed node ownership');
        return restoreNode(node, row(location.span.line), 'node');
      });
      let spec: Spec | undefined;
      if (fn.spec !== undefined) {
        spec = {
          examples: fn.spec.examples.map((example, index) => {
            const location = owner.examples[index];
            if (location === undefined) throw new Error('missing native parsed example ownership');
            const source = row(location.span.line),
              prior = owned(source, 'example');
            const old = prior?.fn.spec?.examples[prior.index as number];
            const restored =
              old?.comments === undefined ? example : { ...example, comments: old.comments };
            remember(restored, 'example', source);
            return restored;
          }),
          ...(fn.spec.pre === undefined
            ? {}
            : {
                pre: restoreNode(
                  fn.spec.pre,
                  owner.pre === undefined ? undefined : row(owner.pre.line),
                  'pre',
                ),
              }),
          ...(fn.spec.post === undefined
            ? {}
            : {
                post: restoreNode(
                  fn.spec.post,
                  owner.post === undefined ? undefined : row(owner.post.line),
                  'post',
                ),
              }),
        };
      }
      const retOwner = owned(ret, 'ret'),
        endOwner = owned(end, 'end');
      const restored: Func = {
        ...fn,
        nodes,
        ...(spec === undefined ? {} : { spec }),
        ...(previous === undefined
          ? {}
          : {
              params: previous.params,
              result: previous.result,
              ...(previous.comments === undefined ? {} : { comments: previous.comments }),
            }),
        ...(retOwner?.fn.retComments === undefined ? {} : { retComments: retOwner.fn.retComments }),
        ...(endOwner?.fn.endComments === undefined ? {} : { endComments: endOwner.fn.endComments }),
        ...(endOwner?.fn.afterComments === undefined
          ? {}
          : { afterComments: endOwner.fn.afterComments }),
      };
      remember(restored, 'header', header);
      remember(restored, 'ret', ret);
      remember(restored, 'end', end);
      return restored;
    });
    return { ...unit.program, functions };
  };
  return { render, parse, remember };
}
