// Packs one MCP Bundle (.mcpb) per release binary and writes release/server.json: the repository's
// server.json with the version and the bundles' release URLs and SHA-256 hashes filled in (the
// repository file is a template and is not modified). Input: release/a0-<target>
// (tools/release.sh). Output: release/a0-mcp-<target>.mcpb. Usage: node dist/tools/mcpb.js <version>
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { packExtension, validateManifest } from '@anthropic-ai/mcpb';

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
if (template.version !== version)
  throw new Error(
    `mcpb/manifest.json is at ${template.version}, not ${version}: run tools/set-version.ts`,
  );
const packages: {
  registryType: 'mcpb';
  identifier: string;
  fileSha256: string;
  transport: { type: 'stdio' };
}[] = [];
for (const { id, platform } of targets) {
  const exe = platform === 'win32' ? 'a0.exe' : 'a0';
  const binary = join(root, 'release', platform === 'win32' ? `a0-${id}.exe` : `a0-${id}`);
  const stage = join(root, 'release/mcpb', id);
  if (!existsSync(binary) || statSync(binary).size === 0)
    throw new Error(`missing or empty release binary ${binary}: run tools/release.sh`);
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
  // The library, not the mcpb command line: the command was seen to stay alive after packing.
  if (!validateManifest(join(stage, 'manifest.json')))
    throw new Error(`invalid manifest for ${id}`);
  rmSync(out, { force: true });
  if (!(await packExtension({ extensionPath: stage, outputPath: out, silent: true })))
    throw new Error(`mcpb pack failed for ${id}`);
  if (!existsSync(out) || statSync(out).size === 0) throw new Error(`mcpb pack produced no ${out}`);
  packages.push({
    registryType: 'mcpb' as const,
    identifier: `https://github.com/Joe-Simo/a0/releases/download/v${version}/${file}`,
    fileSha256: createHash('sha256').update(readFileSync(out)).digest('hex'),
    transport: { type: 'stdio' as const },
  });
}

const server = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8')) as Record<
  string,
  unknown
>;
const outPath = join(root, 'release/server.json');
writeFileSync(outPath, `${JSON.stringify({ ...server, version, packages }, null, 2)}\n`);
console.log(`release/server.json -> ${version}, ${packages.length} bundles`);
