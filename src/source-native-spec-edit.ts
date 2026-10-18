/** Signed spec source uses A0's existing unit parser and the one spec mutation kernel. */
import type { Func, Node } from './core.js';
import { type EditSourceLine, editSourceJoin, editSourceSlice } from './edit-source.js';
import type { nativeSource } from './source-native.js';
import {
  nativeEditContext,
  nativeEditEventText,
  nativeEditFormat,
} from './source-native-edit-context.js';
import { throwNativeEditSource } from './source-native-edit-source.js';
import {
  applySpecEditsWithLanguage,
  type SpecEdit,
  type SpecEditLanguage,
  type SpecExample,
} from './spec.js';

type Frontend = ReturnType<typeof nativeSource>;

/** Cache only detached fragments and canonical rows, for one target transaction. */
export function nativeSpecEditLanguage(
  frontend: Frontend,
  target: Func,
  remember?: (value: object, kind: 'example' | 'pre' | 'post', source: EditSourceLine) => void,
): SpecEditLanguage {
  let context: ReturnType<typeof nativeEditContext> | undefined;
  const rendered = new Map<string, string>();
  const parse = (fn: Func, edit: SpecEdit) => {
    if (fn.name !== target.name) throw new Error('native spec edit target changed');
    context ??= nativeEditContext(frontend, target);
    let payload: EditSourceLine = { text: `${edit.word} ${edit.rest}` };
    if (edit.source !== undefined) {
      const prefix = /^\s*(?:[a-z][a-z0-9_]*:)?[+-]/.exec(edit.source.text);
      if (prefix === null) throw new Error('invalid native signed spec framing');
      payload = editSourceSlice(edit.source, prefix[0].length);
    }
    const rows: EditSourceLine[] = [
      { text: context.header.trimEnd() },
      payload,
      { text: context.ret },
      { text: 'end' },
    ];
    const unit = frontend.parseUnit(editSourceJoin(rows));
    if (!unit.ok) throwNativeEditSource(unit, rows);
    const parsed = unit.program.functions[0];
    if (
      unit.program.functions.length !== 1 ||
      parsed?.name !== fn.name ||
      parsed.spec === undefined ||
      parsed.nodes.length !== 0
    )
      throw new Error('native spec parser did not produce the requested spec');
    if (remember !== undefined) {
      if (parsed.spec.examples[0] !== undefined)
        remember(parsed.spec.examples[0], 'example', payload);
      if (parsed.spec.pre !== undefined) remember(parsed.spec.pre, 'pre', payload);
      if (parsed.spec.post !== undefined) remember(parsed.spec.post, 'post', payload);
    }
    return parsed.spec;
  };
  // Keys use decoded IR fields only; canonical text itself always comes from the native emitter.
  const text = (fn: Func, value: SpecExample | Node, word: 'ex' | 'pre' | 'post'): string => {
    const key = JSON.stringify([word, value], (field, item) =>
      field === 'comments' ? undefined : item,
    );
    const saved = rendered.get(key);
    if (saved !== undefined) return saved;
    const output = nativeEditFormat(frontend, {
      ...fn,
      spec:
        word === 'ex'
          ? { examples: [value as SpecExample] }
          : { examples: [], [word]: value as Node },
    });
    const rows: string[] = [];
    for (let at = 0; at < output.events.length; at += 6)
      if (output.events[at] === (word === 'ex' ? 12 : 14))
        rows.push(nativeEditEventText(output, at));
    if (rows.length !== 1) throw new Error('invalid native spec formatter mapping');
    const row = rows[0] as string;
    // Existing A0720 example diagnostics show only the args and result, without the ex keyword.
    const result = word === 'ex' ? row.slice(3) : row;
    rendered.set(key, result);
    return result;
  };
  return {
    example(fn, edit) {
      const spec = parse(fn, edit),
        example = spec.examples[0];
      if (
        spec.examples.length !== 1 ||
        spec.pre !== undefined ||
        spec.post !== undefined ||
        example === undefined
      )
        throw new Error('native spec parser produced an unexpected example shape');
      return example;
    },
    expression(fn, edit) {
      const spec = parse(fn, edit),
        expression = spec[edit.word];
      if (
        spec.examples.length ||
        expression === undefined ||
        spec[edit.word === 'pre' ? 'post' : 'pre'] !== undefined
      )
        throw new Error('native spec parser produced an unexpected contract shape');
      return expression;
    },
    exampleText: (fn, example) => text(fn, example, 'ex'),
    expressionText: (fn, expression) =>
      text(fn, expression, expression.id === 'pre' ? 'pre' : 'post'),
  };
}

export function applyNativeSpecEdits(fn: Func, edits: readonly SpecEdit[], frontend: Frontend) {
  return applySpecEditsWithLanguage(fn, edits, nativeSpecEditLanguage(frontend, fn));
}
