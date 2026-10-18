/** Detached contextual fragments from the authoritative A0 formatter. */
import type { Func } from './core.js';
import type { nativeSource } from './source-native.js';
import type { NativeFormatResult } from './source-native-format.js';

type Frontend = ReturnType<typeof nativeSource>;
export type NativeFormattedText = Extract<NativeFormatResult, { readonly ok: true }>;

export function nativeEditFormat(
  frontend: Frontend,
  fn: Func,
  scope: 'function' | 'signature' = 'function',
): NativeFormattedText {
  const active = frontend.activateProgramForFormat({ functions: [fn] });
  if (!active.ok)
    throw new Error(
      `native edit activation refused: ${'reason' in active ? active.reason : active.status}`,
    );
  const output = frontend.format(active.input, { scope, mapping: true });
  if (!output.ok)
    throw new Error(
      `native edit formatting refused: ${'reason' in output ? output.reason : output.status}`,
    );
  return output;
}

export function nativeEditEventText(output: NativeFormattedText, at: number): string {
  const start = output.events[at + 3],
    length = output.events[at + 4];
  if (
    start === undefined ||
    length === undefined ||
    start > output.bytes.length ||
    length > output.bytes.length - start
  )
    throw new Error('invalid native edit formatter event');
  return new TextDecoder('utf-8', { fatal: true }).decode(
    output.bytes.subarray(start, start + length),
  );
}

/** Both strings are detached before any subsequent parser/checker activation. */
export function nativeEditContext(frontend: Frontend, fn: Func): { header: string; ret: string } {
  const header = nativeEditFormat(frontend, fn, 'signature').text;
  const output = nativeEditFormat(frontend, fn);
  const returns: string[] = [];
  for (let at = 0; at < output.events.length; at += 6)
    if (output.events[at] === 10) returns.push(nativeEditEventText(output, at));
  if (returns.length !== 1) throw new Error('invalid native edit return mapping');
  return { header, ret: returns[0] as string };
}
