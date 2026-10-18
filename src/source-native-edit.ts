/** Staged whole-function edits through the shared A0 language services; no session/default switch. */
import type { Func, TypedProgram } from './core.js';
import { editProgramWithLanguage, type ProgramEditLanguage } from './edit.js';
import type { nativeSource, NativeSourceResult } from './source-native.js';
import { NativeSourceError } from './source-native-link.js';

type Frontend = ReturnType<typeof nativeSource>;

function failed(result: Extract<NativeSourceResult, { readonly ok: false }>): never {
  const error = new NativeSourceError(result);
  // Only genuine A0-rendered diagnostics participate in the existing ordering/repair policy.
  // A raw native refusal must not become a host-classified semantic diagnostic.
  throw error.a0Error ?? error;
}

function signature(frontend: Frontend, fn: Func): string {
  const active = frontend.activateProgramForFormat({ functions: [fn] });
  if (!active.ok)
    throw new Error(
      `native edit signature activation refused: ${'reason' in active ? active.reason : active.status}`,
    );
  const output = frontend.format(active.input, { scope: 'signature' });
  if (!output.ok)
    throw new Error(
      `native edit signature formatting refused: ${'reason' in output ? output.reason : output.status}`,
    );
  // Signature output is a detached native header fragment with its terminating LF.
  return output.text.endsWith('\n') ? output.text.slice(0, -1) : output.text;
}

/**
 * Borrow an explicit A0 frontend for the existing whole-function/program transaction kernel.
 * The returned program exists only after complete native checking. This is not a partial
 * native EditSession: node, numbered, signed-spec, handle and public command routes are unchanged.
 */
export function editNativeProgram(
  program: TypedProgram,
  text: string,
  frontend: Frontend,
  keepSpecs = false,
): TypedProgram {
  const language: ProgramEditLanguage = {
    parseUnit(source) {
      const unit = frontend.parseUnit(source);
      if (!unit.ok) failed(unit);
      return unit.program;
    },
    check(candidate) {
      const result = frontend.checkProgram(candidate);
      if (!result.ok) failed(result);
      return result.typed;
    },
    signature: (fn) => signature(frontend, fn),
  };
  return editProgramWithLanguage(program, text, language, keepSpecs);
}
