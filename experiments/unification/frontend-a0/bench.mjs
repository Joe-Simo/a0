import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {loadavg} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {formatSource,parseAndValidate,validate} from '../../../dist/src/core.js';
import {formatDense,parseDense} from '../../../dist/src/dense.js';
import {compile} from '../../../dist/src/backends.js';
import * as reference from './reference/core.mjs';
const args=new Map(process.argv.slice(2).map(s=>s.split('=')));
assert.ok(args.get('--artifact')&&args.get('--out'),'usage: --artifact=PATH --out=PATH');
const here=dirname(fileURLToPath(import.meta.url)),out=resolve(args.get('--out')),artifact=pathToFileURL(resolve(args.get('--artifact'))+'/').href;
mkdirSync(out,{recursive:true});
const sha=x=>createHash('sha256').update(x).digest('hex');
const units=JSON.parse(readFileSync(join(here,'inputs/index.json'),'utf8'));
for(const u of units){
 const input=JSON.parse(readFileSync(join(here,'inputs',u.input),'utf8'));
 const program=parseAndValidate(input.canonical);
 input.dense=formatDense(program,{comments:true});
 assert.equal(formatSource(validate(parseDense(input.dense))),formatSource(program),u.unit+' Dense IR');
 assert.equal(formatSource(reference.parseAndValidate(input.unified)),formatSource(program),u.unit+' unified reference IR');
 assert.equal(sha(compile(program,'c').text),u.outputSHA256,u.unit+' frozen output changed');
 writeFileSync(join(out,u.input),JSON.stringify(input)+'\n');
}
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(join(dir,d.name)):[join(dir,d.name)]);
const files=[...walk(here),...walk(resolve(here,'../../../dist/src')),fileURLToPath(new URL('frontend.wasm',artifact)),...units.map(u=>join(out,u.input))];
const hashes=new Map(files.map(p=>[p,sha(readFileSync(p))]));
const samples=[],arms=['canonical','dense','unified-reference','unified-a0'];
const startedAt=new Date().toISOString();
for(let round=-1;round<7;round++){
 for(const u of units)for(let j=0;j<arms.length;j++){
  const arm=arms[(round+1+u.id+j)%arms.length],load=loadavg();assert.ok(load[0]<=10,'loaded machine: discard run');
  const start=performance.now();
  const ran=spawnSync(process.execPath,[join(here,'bench-worker.mjs'),arm,join(out,u.input),artifact],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:240000});
  assert.equal(ran.status,0,`${u.unit}/${arm}: ${ran.error??''}\n${ran.stderr}`);
  const data=JSON.parse(ran.stdout);assert.equal(data.outputSHA256,u.outputSHA256);
  samples.push({unit:u.unit,arm,round,warmup:round<0,load,wallMs:performance.now()-start,...data});
  writeFileSync(join(out,'samples.json'),JSON.stringify(samples,null,2)+'\n');
 }
 console.log('round',round,'complete');
}
for(const[p,h]of hashes)assert.equal(sha(readFileSync(p)),h,'changed input '+p);
const median=xs=>{xs.sort((a,b)=>a-b);return xs[Math.floor(xs.length/2)];};
const fields=['frontendMs','emitCMs','pipelineMs','wallMs','peakRSSBytes','rssBytes','heapUsedBytes','externalBytes','wasmLinearMemoryBytes'];
const rows=units.map(u=>({unit:u.unit,arms:Object.fromEntries(arms.map(a=>[a,Object.fromEntries(fields.map(k=>[k,median(samples.filter(s=>s.unit===u.unit&&s.arm===a&&!s.warmup).map(s=>s[k]))]))]))}));
writeFileSync(join(out,'results.json'),JSON.stringify({scope:'Frozen flattened whole-program inputs, current Canonical and Dense plus unified reference and A0 prototype. Includes parser/checker, portable instantiation/upload/typed-IR decoding, same C emission; excludes graph I/O, shipping CLI startup, formatter and model inference. Every arm equally preloads all modules and compiled Wasm; retains results/instance during C emission. All output hashes agree. Prototype fails the no-regression requirement; no official cutover.',startedAt,finishedAt:new Date().toISOString(),maxLoad1:Math.max(...samples.map(s=>s.load[0])),warmups:1,measuredRounds:7,samples:samples.length,rows},null,2)+'\n');
// Relocatable provenance, no machine-local paths in this export.
writeFileSync(join(out,'input-hashes.json'),JSON.stringify([...hashes].map(([p,h])=>({path:p.startsWith(here)?'<experiment>/'+p.slice(here.length+1):p.startsWith(resolve(here,'../../../dist/src'))?'<repo>/dist/src/'+p.slice(resolve(here,'../../../dist/src').length+1):p.startsWith(out)?'<output>/'+p.slice(out.length+1):'<artifact>/frontend.wasm',sha256:h})),null,2)+'\n');
console.log('PASS',samples.length,'matched fresh-process cells');
