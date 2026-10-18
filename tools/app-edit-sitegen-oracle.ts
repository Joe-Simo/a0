/** Full generator -> native source check -> generated page session -> UI protocol oracle. */
import assert from 'node:assert/strict';
import { relative, resolve } from 'node:path';
import type { TypedProgram } from '../src/core.js';
import type { nativeSource } from '../src/source-native.js';
import { linkNativeSource } from '../src/source-native-link.js';
import type { ApplicationIoResult, applicationRuntime } from './app-edit-application-runtime.js';
import type { approvedApplicationSources } from './app-edit-application-sources.js';
import { generatorInputBytes } from './site-gen.js';
import { ATTRS, renderWords, TAGS } from './site-render.js';

interface TextCase {
  readonly id: string;
  readonly templateBody: string;
  readonly expectedText: string;
  readonly expectedAttributes: Readonly<Record<string, string>>;
}
interface CssCase {
  readonly id: string;
  readonly theme: 'light' | 'dark' | null;
  readonly selectors: readonly string[];
  readonly declarations: string;
  readonly prefixCss: string;
  readonly suffixCss: string;
}
export interface SitegenCases {
  readonly g1: { readonly cases: readonly TextCase[] };
  readonly g2: { readonly cases: readonly CssCase[] };
}
type Runtime = Awaited<ReturnType<typeof applicationRuntime>>;
type Sources = Awaited<ReturnType<typeof approvedApplicationSources>>;
// The full execution dataset is parsed for each independent fixture. Keep each child
// bounded even when several such calls share its compiled generator.
export const APPLICATION_GENERATOR_BATCH_CALLS = 4;

const SESSION_HEADER = `1use "ui.a0"
2fn session io -> u32
2r0 read p0
2t0 at r0 1
2r1 read t0
2t1 at r1 1
2r2 read t1
2t2 at r2 1
2r3 read t2
2t3 at r3 1
2r4 read t3
2tok at r4 1
`;
const SESSION_FOOTER = '2\n2ret 0\n2end\n';

/** Strict framing before the existing renderer; no malformed/unknown commands are ignored. */
export function applicationUiContents(words: readonly number[], expectedOpenElements = 0) {
  let at = 0;
  const stack: { started: boolean }[] = [];
  const opcodes: number[] = [];
  const flush = () => {
    const top = stack.at(-1);
    if (top) top.started = true;
  };
  const text: string[] = [];
  const attributes: [number, string][] = [];
  const take = (count: number) => {
    assert.ok(Number.isInteger(count) && count >= 0 && at + count <= words.length, 'UI bounds');
    const value = words.slice(at, at + count);
    at += count;
    return value;
  };
  const bytes = () => {
    const size = take(1)[0] as number;
    const value = take(size);
    assert.ok(
      value.every((word) => word <= 255),
      'UI byte range',
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value));
  };
  while (at < words.length) {
    const op = take(1)[0] as number;
    opcodes.push(op);
    switch (op) {
      case 1: {
        const tag = take(1)[0] as number;
        assert.ok(TAGS[tag] !== undefined, 'unknown UI tag');
        flush();
        stack.push({ started: false });
        break;
      }
      case 2:
        flush();
        text.push(bytes());
        break;
      case 3:
        assert.ok(stack.length > 0, 'UI close');
        flush();
        stack.pop();
        break;
      case 4: {
        const key = take(1)[0] as number;
        assert.ok(ATTRS[key] !== undefined, 'unknown UI attribute');
        assert.ok(stack.at(-1) && !stack.at(-1)?.started, 'late or unowned UI attribute');
        attributes.push([key, bytes()]);
        break;
      }
      case 5:
      case 8:
        take(1);
        break;
      case 6:
        take(take(1)[0] as number);
        break;
      case 9:
      case 13:
      case 14:
        bytes();
        break;
      case 10:
        take(1);
        take(take(1)[0] as number);
        break;
      case 11:
      case 12:
        take(2);
        break;
      default:
        throw new Error(`unknown UI command ${op}`);
    }
  }
  // The real renderer closes outstanding roots at EOF. The frozen production page uses
  // one such root; focused fixtures explicitly close every element.
  assert.equal(stack.length, expectedOpenElements, 'UI unclosed element');
  return { text: text.join(''), attributes, opcodes, rendered: renderWords(words) };
}

function exactText(actual: string, expected: string, label: string) {
  if (actual === expected) return;
  let at = 0;
  while (at < actual.length && at < expected.length && actual[at] === expected[at]) at += 1;
  assert.equal(
    actual.slice(at, at + 48),
    expected.slice(at, at + 48),
    `${label} at character ${at}`,
  );
}

/** Expected CSS starts from authored selector arrays, never a parser or split of candidate CSS. */
function cssFixture(item: CssCase): { input: string; expected: string } {
  const rule = `${item.selectors.join(',')}{${item.declarations}}`;
  if (item.theme === null) {
    const input = `${item.prefixCss}${rule}${item.suffixCss}\n`;
    return { input, expected: input };
  }
  const prefix = `@media (prefers-color-scheme:${item.theme}){`;
  const scope = (condition: string) =>
    `${item.selectors
      .map((raw) => {
        const selector = raw.trim();
        return selector.startsWith(':root')
          ? `:root:where(${condition})${selector.slice(5)}`
          : `:where(:root${condition}) ${selector}`;
      })
      .join(',')}{${item.declarations}}`;
  const other = item.theme === 'dark' ? 'light' : 'dark';
  return {
    input: `${item.prefixCss}${prefix}${rule}}${item.suffixCss}\n`,
    expected: `${item.prefixCss}${prefix}${scope(`:not([data-theme=${other}])`)}}${scope(`[data-theme=${item.theme}]`)}${item.suffixCss}\n`,
  };
}

export async function sitegenOracle(
  program: TypedProgram,
  kind: 'g1' | 'g2',
  cases: SitegenCases,
  runtime: Runtime,
  sources: Sources,
  frontend: ReturnType<typeof nativeSource>,
): Promise<string[]> {
  const failures: string[] = [];
  const capture = async (label: string, check: () => Promise<void>) => {
    try {
      await check();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const root = resolve('.a0-tmp/application-generated-source');
  const page = async (
    result: ApplicationIoResult,
    consumed: number,
    sessionConsumed: number,
    expectedOpenElements: number,
  ) => {
    assert.equal(result.value, 0, 'generator return');
    assert.equal(result.position, consumed, 'generator input consumption');
    assert.ok(
      result.output.every((word) => word <= 255),
      'generator byte output',
    );
    const source = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(result.output));
    const files = new Map([
      ['page.a0', source],
      ['ui.a0', sources.text('site/ui.a0')],
    ]);
    const generated = await linkNativeSource(
      resolve(root, 'page.a0'),
      async (path) => {
        const local = relative(root, path).replaceAll('\\', '/');
        const value = files.get(local);
        if (value === undefined)
          throw new Error('generated program requested a dependency outside the frozen UI');
        return value;
      },
      frontend,
      { root, canonicalPath: async (path) => resolve(path) },
    );
    const session = (await runtime.execute(generated.program, 'session', [[0, 0, 0, 0, 0]]))[0];
    assert.ok(session);
    assert.equal(session.value, 0, 'page session return');
    assert.equal(session.position, sessionConsumed, 'page session input consumption');
    return { source, ...applicationUiContents(session.output, expectedOpenElements) };
  };
  const checks: {
    label: string;
    template: string;
    css: string | undefined;
    sessionConsumed: number;
    expectedOpenElements: number;
    check: (output: Awaited<ReturnType<typeof page>>) => void;
  }[] = [];
  const packed = (
    label: string,
    template: string,
    check: (output: Awaited<ReturnType<typeof page>>) => void,
    css?: string,
    sessionConsumed = 5,
    expectedOpenElements = 0,
  ) => checks.push({ label, template, css, sessionConsumed, expectedOpenElements, check });

  // This complete shipped template and its original datasets remain in every task's contract.
  packed(
    'preserve full production page generation and session',
    sources.text('site/gen/page.tpl'),
    (output) => {
      exactText(output.source, sources.text('site/page.a0'), 'unchanged production page source');
      assert.ok(output.rendered.html.includes('a0lang') || output.rendered.text.includes('A0'));
    },
    undefined,
    1,
    1,
  );
  if (kind === 'g1') {
    for (const item of cases.g1.cases) {
      const template = `f tags site/gen/tags.tpl\nf exec results/exec-benchmark-full.json\n${SESSION_HEADER}${item.templateBody}${SESSION_FOOTER}`;
      packed(item.id, template, (output) => {
        assert.ok(
          output.opcodes.every((op) => [1, 2, 3, 4].includes(op)),
          'unexpected focused UI effect',
        );
        assert.equal(output.text, item.expectedText, 'literal expanded text');
        assert.deepEqual(
          output.attributes,
          Object.entries(item.expectedAttributes).map(([key, value]) => {
            assert.equal(key, 'title');
            return [7, value];
          }),
          'literal expanded attributes',
        );
      });
    }
  } else {
    for (const item of cases.g2.cases)
      for (const sectioned of [false, true]) {
        const css = cssFixture(item);
        const padding = `/*${'p'.repeat(990)}*/\n`;
        const emit = sectioned
          ? '{css_first\ns 9 css 0 995\n}\n{css_rest\ns 9 css 995\n}\n'
          : 's 9 css\n';
        const template = `f tags site/gen/tags.tpl\nf css fixture.css\n${SESSION_HEADER}${emit}<div\n+title unaffected\n"unaffected\n>\n${SESSION_FOOTER}`;
        packed(
          `${item.id}/${sectioned ? 'sectioned' : 'ordinary'}`,
          template,
          (output) => {
            assert.ok(
              output.opcodes.every((op) => [1, 2, 3, 4, 9].includes(op)),
              'unexpected focused UI effect',
            );
            exactText(output.rendered.css, `${padding}${css.expected}\n`, 'complete scoped CSS');
            assert.equal(output.text, 'unaffected', 'unrelated text');
            assert.deepEqual(output.attributes, [[7, 'unaffected']], 'unrelated attribute');
          },
          padding + css.input,
        );
      }
  }
  // These are independent calls into the same complete program. Batch only the fixed
  // generator invocation; every returned page still gets its own native check and IO oracle.
  const inputs = await Promise.all(
    checks.map(async ({ template, css }) => {
      const data = await generatorInputBytes(Buffer.from(template), async (path) =>
        path === 'fixture.css' && css !== undefined ? Buffer.from(css) : sources.bytes(path),
      );
      return Array.from({ length: data.length / 4 }, (_, at) => data.readUInt32LE(at * 4));
    }),
  );
  const outputs: ApplicationIoResult[] = [];
  for (let at = 0; at < inputs.length; at += APPLICATION_GENERATOR_BATCH_CALLS)
    outputs.push(
      ...(await runtime.execute(
        program,
        'sitegen',
        inputs.slice(at, at + APPLICATION_GENERATOR_BATCH_CALLS),
      )),
    );
  for (const [index, check] of checks.entries())
    await capture(check.label, async () => {
      const output = outputs[index];
      const input = inputs[index];
      assert.ok(output && input, 'complete generator result');
      check.check(
        await page(output, input.length, check.sessionConsumed, check.expectedOpenElements),
      );
    });
  return failures;
}
