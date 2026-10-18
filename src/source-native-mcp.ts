/** MCP dependencies over one borrowed A0 frontend; the caller owns assets and lifetime. */
import type { Program } from './core.js';
import type { McpLanguageServices } from './mcp.js';
import type { nativeSource } from './source-native.js';
import { createNativeEditSession } from './source-native-edit-session.js';
import { nativeSourceGraphLoader } from './source-native-link.js';

type Frontend = ReturnType<typeof nativeSource>;

export function nativeMcpLanguageServices(frontend: Frontend): McpLanguageServices {
  const activate = (program: Program) => {
    const result = frontend.activateProgramForFormat(program);
    if (!result.ok)
      throw new Error(
        `native MCP formatting activation refused: ${'reason' in result ? result.reason : result.status}`,
      );
    return result.input;
  };
  const format = (program: Program, scope: 'source' | 'program') => {
    const result = frontend.format(activate(program), { scope });
    if (!result.ok)
      throw new Error(
        `native MCP formatting refused: ${'reason' in result ? result.reason : result.status}`,
      );
    return result.text;
  };
  return {
    acceptsPath: (path) => path.endsWith('.a0'),
    load: nativeSourceGraphLoader(frontend),
    createSession: (program) => createNativeEditSession(program, frontend),
    formatProgram: (program) => format(program, 'program'),
    formatSource: (program) => format(program, 'source'),
    revision(fn) {
      const result = frontend.revision(activate({ functions: [fn] }), { kind: 'function' });
      if (!result.ok)
        throw new Error(
          `native MCP revision refused: ${'reason' in result ? result.reason : result.status}`,
        );
      return result.revision;
    },
  };
}
