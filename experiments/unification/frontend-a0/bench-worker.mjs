import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {parseAndValidate,validate} from '../../../dist/src/core.js';
import {parseDense} from '../../../dist/src/dense.js';
import {compile} from '../../../dist/src/backends.js';
import * as reference from './reference/core.mjs';
import {frontend} from './host.mjs';
const [arm,inputPath,artifact] = process.argv.slice(2);
const input=JSON.parse(readFileSync(inputPath,'utf8'));
// Equal research preloads: this is not a shipping CLI-startup comparison.
const module=new WebAssembly.Module(readFileSync(new URL('frontend.wasm',artifact)));
let engine,result,program;
const start=performance.now();
if(arm==='canonical')program=parseAndValidate(input.canonical);
else if(arm==='dense')program=validate(parseDense(input.dense));
else if(arm==='unified-reference')program=validate(reference.parse(input.unified));
else if(arm==='unified-a0'){
  engine=frontend(module);result=engine.parse(input.unified);
  if(result.status!==0)throw Error('A0 frontend status '+result.status);
  program=result.typed;
}else throw Error('unknown benchmark arm');
const front=performance.now(),output=compile(program,'c').text,end=performance.now();
const m=process.memoryUsage();
console.log(JSON.stringify({frontendMs:front-start,emitCMs:end-front,pipelineMs:end-start,
 peakRSSBytes:process.resourceUsage().maxRSS*1024,rssBytes:m.rss,heapUsedBytes:m.heapUsed,
 externalBytes:m.external,wasmLinearMemoryBytes:engine?.api.memory.buffer.byteLength??0,
 outputBytes:Buffer.byteLength(output),outputSHA256:createHash('sha256').update(output).digest('hex')}));
engine?.close();
