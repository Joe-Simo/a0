import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseAndValidate} from '../../../dist/src/core.js';
import {DiskCache,compileCached} from '../../../dist/src/cache.js';
import {protectionPolicy} from '../../../dist/src/protection-policy.js';
import {createIdentity,unlockIdentity} from '../../../dist/src/protection/crypto.js';
import {SealedProject} from '../../../dist/src/protection/vault.js';
import {DiskVaultStore,inventory,resumeMigration} from '../../../dist/src/protection/disk.js';
import {writeReport} from '../../../dist/tools/scrub-results.js';
const root=await mkdtemp(join(tmpdir(),'a0-owned-transition-'));
let project;
try {
 const source='fn f -> u32\nret 987654321\nend\n';
 const entry=join(root,'private.a0');await writeFile(entry,source);
 protectionPolicy(entry);
 const program=parseAndValidate(source);
 const cache=new DiskCache(join(root,'.a0-cache'));
 let release,entered;
 const barrier=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const original=cache.get.bind(cache);
 cache.get=async key=>{entered();await barrier;return original(key);};
 const build=compileCached(program,'c',cache);await started;
 const password=new TextEncoder().encode('synthetic owned fixture passphrase');
 const owner=await unlockIdentity(await createIdentity(password),password);password.fill(0);
 const plan=await inventory(root);const store=new DiskVaultStore(root);await store.initialize();
 project=await SealedProject.create(store,owner,{direction:'on',stage:'copy',items:plan.items});
 await resumeMigration(project,root);
 assert.equal((await inventory(root)).items.length,0);
 assert.throws(()=>protectionPolicy(entry),/SEALED/);
 release();await build;
 let plaintext=false;
 for(const bucket of await readdir(join(root,'.a0-cache')))
  for(const file of await readdir(join(root,'.a0-cache',bucket)))
   plaintext||=(await readFile(join(root,'.a0-cache',bucket,file),'utf8')).includes('987654321');
 assert.equal(plaintext,true,'Controlled schedule did not reproduce the proposed leak');
 await writeReport('results/protection-transition-race.json',{schema:'a0-protection-transition-race-1',sourceCommit:'e585205',fixture:'Owned synthetic source; all files removed after the test',scheduler:'An already-authorized unsealed compilation pauses at its asynchronous cache lookup; sealing completes; the lookup resumes.',sealedSourceRemoved:true,newReadGuardRejects:true,inflightBuildWritesPlaintextManagedCache:true,status:'confirmed gap in experimental checkpoint; no production confidentiality claim',required:'Coordinate source-mode transitions with managed writers across processes and cache locations before promoting sealing.'});
 console.log('Confirmed managed-cache race during source-mode transition on owned fixture');
} finally {project?.lock();await rm(root,{recursive:true,force:true});}
