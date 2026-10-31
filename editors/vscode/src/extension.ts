import { commands, type ExtensionContext, window, workspace } from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

function createClient(): LanguageClient {
  const config = workspace.getConfiguration('a0');
  const command = config.get<string>('server.path', 'a0');
  const args = config.get<string[]>('server.args', []);
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0'))
    throw new Error('a0.server.path must be a non-empty executable path without NUL bytes');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))
    throw new Error('a0.server.args must be an array of arguments without NUL bytes');
  const folders = workspace.workspaceFolders ?? [];
  if (args.length > 0 && (folders.length !== 1 || folders[0]?.uri.scheme !== 'file'))
    throw new Error('Configured server arguments require one local workspace folder');
  const options = args.length > 0 ? { cwd: folders[0]!.uri.fsPath } : {};
  const serverOptions: ServerOptions = {
    run: {
      command,
      args: [...args, 'lsp'],
      ...(args.length > 0 ? { options } : {}),
      transport: TransportKind.stdio,
    },
    debug: {
      command,
      args: [...args, 'lsp'],
      ...(args.length > 0 ? { options } : {}),
      transport: TransportKind.stdio,
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'a0' }],
    synchronize: { fileEvents: workspace.createFileSystemWatcher('**/*.a0') },
    outputChannel: window.createOutputChannel('A0 Language Server', { log: true }),
  };
  return new LanguageClient('a0', 'A0 Language Server', serverOptions, clientOptions);
}

async function start(): Promise<void> {
  if (!workspace.isTrusted) return;
  try {
    client = createClient();
    await client.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void window.showErrorMessage(
      `A0: could not start \`a0 lsp\` (${message}). Set "a0.server.path" and optional "a0.server.args" for the selected compiler.`,
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
    workspace.onDidGrantWorkspaceTrust(async () => {
      await start();
    }),
    commands.registerCommand('a0.restartServer', async () => {
      await stop();
      await start();
    }),
    workspace.onDidChangeConfiguration(async (event) => {
      if (
        event.affectsConfiguration('a0.server.path') ||
        event.affectsConfiguration('a0.server.args')
      ) {
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
