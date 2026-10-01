import { commands, type ExtensionContext, window, workspace } from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

function createClient(): LanguageClient {
  const command = workspace.getConfiguration('a0').get<string>('server.path', 'a0');
  const serverOptions: ServerOptions = {
    run: { command, args: ['lsp'], transport: TransportKind.stdio },
    debug: { command, args: ['lsp'], transport: TransportKind.stdio },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'a0' }],
    synchronize: { fileEvents: workspace.createFileSystemWatcher('**/*.a0') },
    outputChannel: window.createOutputChannel('A0 Language Server', { log: true }),
  };
  return new LanguageClient('a0', 'A0 Language Server', serverOptions, clientOptions);
}

async function start(): Promise<void> {
  client = createClient();
  try {
    await client.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void window.showErrorMessage(
      `A0: could not start \`a0 lsp\` (${message}). Set "a0.server.path" to the a0 executable.`,
    );
  }
}

async function stop(): Promise<void> {
  const running = client;
  client = undefined;
  if (running?.isRunning()) await running.stop();
}

export async function activate(context: ExtensionContext): Promise<void> {
  context.subscriptions.push(
    commands.registerCommand('a0.restartServer', async () => {
      await stop();
      await start();
    }),
    workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('a0.server.path')) {
        await stop();
        await start();
      }
    }),
  );
  await start();
}

export function deactivate(): Promise<void> {
  return stop();
}
