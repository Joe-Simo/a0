import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { initSourceProject } from '../src/source-init.js';

async function files(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result[path] = (await readFile(join(root, path))).toString('hex');
    }
  }
  await visit('');
  return result;
}

for (const [name, prefix, suffix] of [
  ['AGENTS.md', '# Owner ', '\n'],
  ['main.a0', '# ', '\nfn f\nret A\nend\n'],
  ['.vscode/settings.json', '{"editor.fontFamily":"', '"}\n'],
  ['.a0/init.json', '{"format":"a0-source-init-1","files":{},"owner":"', '"}\n'],
] as const) {
  test(`initialization refuses malformed UTF8 in ${name} without changing file bytes`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'a0-init-utf8-'));
    try {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        Buffer.concat([Buffer.from(prefix), Buffer.from([255]), Buffer.from(suffix)]),
      );
      const before = await files(root);
      await assert.rejects(initSourceProject(root), /encoded data|UTF-8|utf-8/);
      assert.deepEqual(await files(root), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('initialization preserves valid BOM, astral characters and replacement characters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-init-valid-utf8-'));
  try {
    const prefix = Buffer.from('\ufeff# Owner 😀 Ω �\n');
    await writeFile(join(root, 'AGENTS.md'), prefix);
    const source = Buffer.from('\ufeff# 😀 �\nfn f\nret A\nend\n');
    await writeFile(join(root, 'main.a0'), source);
    await initSourceProject(root);
    assert.ok((await readFile(join(root, 'AGENTS.md'))).subarray(0, prefix.length).equals(prefix));
    assert.deepEqual(await readFile(join(root, 'main.a0')), source);
    const first = await files(root);
    await initSourceProject(root);
    assert.deepEqual(await files(root), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const externalChange of [false, true]) {
  test(`initialization rollback uses exact bytes, external malformed edit=${externalChange}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'a0-init-byte-rollback-'));
    try {
      const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
const root=${JSON.stringify(root)};
const external=${JSON.stringify(externalChange)};
const original=Buffer.from('# Owner �\\n');
const owner=join(root,'AGENTS.md');
await fs.writeFile(owner,original);
const realWrite=fs.writeFile;
let triggered=false, changed;
fs.writeFile=async function(path,data,options){
  if(String(path)===join(root,'.a0','cli.mjs')&&!triggered){
    triggered=true;
    if(external){const current=await fs.readFile(owner);const at=current.indexOf(Buffer.from('�'));assert.ok(at>=0);changed=Buffer.concat([current.subarray(0,at),Buffer.from([255]),current.subarray(at+3)]);await realWrite(owner,changed);}
    throw Object.assign(new Error('injected write failure'),{code:'EIO'});
  }
  return realWrite(path,data,options);
};
syncBuiltinESMExports();
const {initSourceProject}=await import(${JSON.stringify(pathToFileURL(resolve('dist/src/source-init.js')).href)});
try{await assert.rejects(initSourceProject(root),e=>e.code==='EIO');}finally{fs.writeFile=realWrite;syncBuiltinESMExports();}
assert.ok(triggered);
assert.deepEqual(await fs.readFile(owner),external?changed:original);
async function names(dir,prefix=''){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=join(prefix,e.name);if(e.isDirectory())out.push(...await names(join(dir,e.name),p));else out.push(p);}return out;}
assert.deepEqual(await names(root),['AGENTS.md']);
console.log('rollback preserved exact expected bytes');
`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /rollback preserved exact expected bytes/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('initialization validates imported source bytes before generating project files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-init-dependency-utf8-'));
  try {
    await writeFile(join(root, 'main.a0'), 'use "dep.a0"\nfn main\nret 0\nend\n');
    await writeFile(
      join(root, 'dep.a0'),
      Buffer.concat([
        Buffer.from('# '),
        Buffer.from([255]),
        Buffer.from('\nfn identity\nret A\nend\n'),
      ]),
    );
    const before = await files(root);
    await assert.rejects(initSourceProject(root), /encoded data|UTF-8|utf-8/);
    assert.deepEqual(await files(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
