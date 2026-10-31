import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveUnlocked } from '../../../dist/src/protection/cli.js';
import { createIdentity, unlockIdentity, utf8 } from '../../../dist/src/protection/crypto.js';
import { MemoryVaultStore } from '../../../dist/src/protection/store.js';
import { SealedProject } from '../../../dist/src/protection/vault.js';
import { nativeSource } from '../../../dist/src/source-native.js';
import { nativeSourceGraphLoader } from '../../../dist/src/source-native-link.js';
import { prepareSourceDiagnostic } from '../../../dist/tools/source-native-load.js';

const password = utf8.encode('owned graph protocol fixture identity');
const identity = await unlockIdentity(await createIdentity(password), password);
password.fill(0);
const project = await SealedProject.create(new MemoryVaultStore(), identity);
await project.write(
  'main.a0',
  utf8.encode('fn sensitive_graph_marker\nr add missing 1\nret r\nend\n'),
);
const frontend = new WebAssembly.Module(
  await readFile(join(process.env.A0_GRAPH_FRONTEND, 'frontend.wasm')),
);
const engine = nativeSource(
  frontend,
  await prepareSourceDiagnostic(process.env.A0_GRAPH_DIAGNOSTIC),
);
const consumer = process.argv[2];
const load =
  consumer === 'external-ai'
    ? async () => {
        throw new Error('LOADER_WAS_CALLED');
      }
    : nativeSourceGraphLoader(engine);
try {
  await serveUnlocked(project, process.cwd(), consumer, undefined, load);
} finally {
  engine.close();
}
