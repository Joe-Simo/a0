import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A virtual POSIX path as the linker reports it: on Windows `resolve('/p/x')` is `C:\p\x`. */
export const posix = (p: string): string => p.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/');

/** Symlink tests skip, with a reason, where creating a link needs a privilege (Windows without Developer Mode). */
export const SYMLINKS: string | false = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'a0-sym-'));
  try {
    writeFileSync(join(dir, 'a'), '');
    symlinkSync(join(dir, 'a'), join(dir, 'b'));
    return false;
  } catch {
    return 'creating symlinks needs a privilege on this host';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
