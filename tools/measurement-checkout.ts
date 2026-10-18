/** Immutable source identities for measurements; ignored build/scratch output is not a source edit. */
import { spawnSync } from 'node:child_process';

export interface CommittedCheckout {
  readonly commit: string;
  readonly tree: string;
}

export function committedTree(path: string): CommittedCheckout {
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: path, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout.trim();
  };
  if (git('status', '--porcelain', '--untracked-files=normal') !== '')
    throw new Error('measurements require a clean committed checkout');
  return { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}
