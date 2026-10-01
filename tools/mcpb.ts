// Packs one MCP Bundle (.mcpb) per release binary and rewrites server.json with their
// URLs and SHA-256 hashes. Input: release/a0-<target> (tools/release.sh). Output:
// release/a0-mcp-<target>.mcpb. Usage: node dist/tools/mcpb.js <version>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  throw new Error('usage: mcpb.js <version, e.g. 0.8.15>');

const targets = [
  { id: 'darwin-arm64', platform: 'darwin' },
  { id: 'darwin-x64', platform: 'darwin' },
  { id: 'linux-x64', platform: 'linux' },
  { id: 'linux-arm64', platform: 'linux' },
  { id: 'windows-x64', platform: 'win32' },
] as const;

const root = process.cwd();
const template = JSON.parse(readFileSync(join(root, 'mcpb/manifest.json'), 'utf8')) as {
  version: string;
  server: { entry_point: string; mcp_config: { command: string } };
  compatibility: { platforms: string[] };
};
const mcpb = join(root, 'node_modules/.bin/mcpb');
const packages = targets.map(({ id, platform }) => {
  const exe = platform === 'win32' ? 'a0.exe' : 'a0';
  const binary = join(root, 'release', platform === 'win32' ? `a0-${id}.exe` : `a0-${id}`);
  const stage = join(root, 'release/mcpb', id);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'server'), { recursive: true });
  copyFileSync(binary, join(stage, 'server', exe));
  chmodSync(join(stage, 'server', exe), 0o755);
  copyFileSync(join(root, 'mcpb/icon.png'), join(stage, 'icon.png'));
  copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  const manifest = {
    ...template,
    version,
    server: {
      ...template.server,
      entry_point: `server/${exe}`,
      mcp_config: { ...template.server.mcp_config, command: `\${__dirname}/server/${exe}` },
    },
    compatibility: { ...template.compatibility, platforms: [platform] },
  };
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const file = `a0-mcp-${id}.mcpb`;
  const out = join(root, 'release', file);
  execFileSync(mcpb, ['validate', join(stage, 'manifest.json')], { stdio: 'inherit' });
  execFileSync(mcpb, ['pack', stage, out], { stdio: 'inherit' });
  return {
    registryType: 'mcpb',
    identifier: `https://github.com/Joe-Simo/a0/releases/download/v${version}/${file}`,
    fileSha256: createHash('sha256').update(readFileSync(out)).digest('hex'),
    transport: { type: 'stdio' },
  };
});

const serverPath = join(root, 'server.json');
const server = JSON.parse(readFileSync(serverPath, 'utf8')) as Record<string, unknown>;
writeFileSync(serverPath, `${JSON.stringify({ ...server, version, packages }, null, 2)}\n`);
console.log(`server.json -> ${version}, ${packages.length} bundles`);
