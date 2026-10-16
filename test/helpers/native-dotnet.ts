import { homedir } from 'node:os';
import { join } from 'node:path';
import { runTool, type ToolInfo } from '../../src/toolchain.js';

/** Existing SDK only. PATH covers actions/setup-dotnet; no installer or package download. */
export function findDotnet(): ToolInfo {
  const explicit = process.env.A0_DOTNET;
  const name = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  const candidates =
    explicit !== undefined && explicit.length > 0
      ? [explicit]
      : [
          ...(process.env.DOTNET_ROOT ? [join(process.env.DOTNET_ROOT, name)] : []),
          name,
          join(homedir(), '.dotnet', name),
          '/usr/local/share/dotnet/dotnet',
          '/usr/share/dotnet/dotnet',
          'C:\\Program Files\\dotnet\\dotnet.exe',
        ];
  for (const path of candidates) {
    const probe = runTool(path, ['--version'], { timeoutMs: 10_000 });
    if (probe.ok) return { name: 'dotnet', path, version: probe.stdout.trim() };
  }
  if (explicit !== undefined && explicit.length > 0)
    throw new Error('A0_DOTNET does not name an existing runnable .NET SDK');
  return { name: 'dotnet', path: undefined, version: undefined };
}
