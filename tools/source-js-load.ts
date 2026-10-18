/** Strict experimental loader: fresh cold compiler proof precedes any component execution. */
import { compileJsSourceArtifact, readJsSourceArtifact } from './source-js-artifact.js';
import { prepareJsCompiler } from './source-js-prepare.js';

export async function prepareJsSource(directory: string) {
  await prepareJsCompiler('verify', directory);
  return compileJsSourceArtifact(await readJsSourceArtifact(directory));
}
