import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAndValidate, run } from '../src/core.js';
import { assertNoPlaintextWriters } from '../src/plaintext-write.js';

const source = 'fn f u32 -> u32\nr add p0 1\nret r\nend\n';
const moduleUrl = (path: string) => new URL(path, import.meta.url).href;

// The child-only preload introduces a synthetic transition exactly when a public writer
// reaches filesystem persistence. No production hook or real key is involved.
const preload = `const fs=require('node:fs');
const original=fs.promises.writeFile;
let fired=false;
fs.promises.writeFile=async function(path,...args){
 const target=String(path);
 const match=process.env.A0_TEST_MODE==='migration'?target.endsWith('/main.a0d'):target===process.env.A0_TEST_OUTPUT;
 if(!fired&&match){
  fired=true;
  fs.mkdirSync(process.env.A0_TEST_ROOT+'/.a0-seal');
  fs.writeFileSync(process.env.A0_TEST_ROOT+'/.a0-seal/head.json',JSON.stringify({format:'a0-vault-1',phase:'sealing'}));
  const {assertNoPlaintextWriters}=await import(process.env.A0_TEST_GUARD);
  let blocked=false;
  try{await assertNoPlaintextWriters(process.env.A0_TEST_ROOT);}catch(e){if(e.code!=='PLAINTEXT_WRITERS_ACTIVE')throw e;blocked=true;}
  fs.writeFileSync(process.env.A0_TEST_RECORD,JSON.stringify({blocked}));
  if(!blocked)throw Error('public writer reached persistence without a lease');
 }
 return original.call(this,path,...args);
};
require('node:module').syncBuiltinESMExports();
`;

for (const mode of ['cli', 'mcp-full', 'mcp-compact', 'migration'] as const) {
  test(`managed ${mode} persistence holds a source lease across an introduced transition`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'a0-public-writer-'));
    try {
      const project = join(root, 'project');
      await mkdir(project);
      const file = join(project, 'main.a0');
      await writeFile(file, source);
      const guardRoot = mode === 'cli' ? join(project, 'lib') : project;
      if (mode === 'cli') {
        await mkdir(guardRoot);
        await writeFile(
          join(guardRoot, 'helper.a0'),
          'fn inc u32 -> u32\nr add p0 1\nret r\nend\n',
        );
        await writeFile(file, 'use "lib/helper.a0"\nfn f u32 -> u32\nr call inc p0\nret r\nend\n');
      }
      const output = mode === 'cli' ? join(project, 'out.c') : file;
      const record = join(root, 'record.json'),
        hook = join(root, 'preload.cjs');
      await writeFile(hook, preload);
      let args: string[];
      if (mode === 'cli')
        args = [
          fileURLToPath(new URL('../src/cli.js', import.meta.url)),
          'emit',
          'c',
          file,
          output,
        ];
      else {
        const runner = join(root, 'runner.mjs');
        const code =
          mode === 'migration'
            ? `import {migrateProject} from ${JSON.stringify(moduleUrl('../src/migrate.js'))}; await migrateProject(${JSON.stringify(file)},${JSON.stringify(join(root, 'out'))},${JSON.stringify(project)});`
            : `import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import {InMemoryTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/inMemory.js'))};
import {createServer} from ${JSON.stringify(moduleUrl('../src/mcp.js'))};
const server=await createServer(${JSON.stringify(file)},{surface:${JSON.stringify(mode === 'mcp-full' ? 'full' : 'compact')}});
const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);
const client=new Client({name:'owned-test',version:'1'});await client.connect(a);
const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(JSON.stringify(r));return r.content[0].text;};
const view=await call('a0_open',{function:'f',dense:false});
await call('a0_apply',{edit:${mode === 'mcp-full' ? "view.split('\\n')[0]+'\\nr add p0 2'" : JSON.stringify('fn f add A 2')}});
await call('a0_save',{});await client.close();await server.close();`;
        await writeFile(runner, code);
        args = [runner];
      }
      const result = spawnSync(process.execPath, ['--require', hook, ...args], {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          A0_NO_CACHE: '1',
          A0_TEST_MODE: mode,
          A0_TEST_ROOT: guardRoot,
          A0_TEST_OUTPUT: output,
          A0_TEST_RECORD: record,
          A0_TEST_GUARD: moduleUrl('../src/plaintext-write.js'),
        },
      });
      assert.deepEqual(
        JSON.parse(await readFile(record, 'utf8')),
        { blocked: true },
        result.stderr,
      );
      if (mode === 'migration') {
        assert.notEqual(result.status, 0);
        await assert.rejects(access(join(root, 'out')));
      } else {
        assert.equal(result.status, 0, result.stderr);
        if (mode === 'cli') assert.match(await readFile(output, 'utf8'), /a0_f/);
        else {
          const fn = parseAndValidate(await readFile(file, 'utf8')).byName.get('f');
          assert.ok(fn);
          assert.equal(run(fn, [3]), 5);
        }
      }
      await assertNoPlaintextWriters(project);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
