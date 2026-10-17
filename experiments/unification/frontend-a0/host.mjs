import{decodeData}from'./decode.mjs';
const offsets=[32,35,38,41,44,47,50,53,56,59,62,68,71,74,97,100,103,106,115,118,121,124];
export function frontend(module){
 const instance=new WebAssembly.Instance(module),api=instance.exports;
 const view=(h,n)=>{const p=api.frontend_view(h),length=api.frontend_view_length(h);if(n>length||(!p&&n))throw Error('invalid generic storage view');return new Uint32Array(api.memory.buffer,p,n??length);};
 function parse(text,budget=16000000){const bytes=new TextEncoder().encode(text),ptr=api.malloc(bytes.length||1);if(!ptr)throw Error('host allocation failed');new Uint8Array(api.memory.buffer,ptr,bytes.length).set(bytes);const status=api.frontend_parse(ptr,bytes.length,budget);api.free(ptr);const state=Array.from(new Uint32Array(api.memory.buffer,api.frontend_state(),128));
 const specState=Array.from(new Uint32Array(api.memory.buffer,api.frontend_specs(),128));if(status!==0)return{status,state,specState};const tables=new Map(offsets.map(o=>[o,view(state[o],state[o+1])]));const sym=tables.get(62),symbols=[];for(let id=0;id<state[67];id++){const at=id*5;const words=view(sym[at],sym[at+1]+sym[at+2]).subarray(sym[at+1]);let name='';for(const byte of words)name+=String.fromCharCode(byte);symbols.push(name);}
 const specTables=new Map([32,35,38,41,44,47,50,62].map(o=>[o,view(specState[o],specState[o+1])]));const result=decodeData(status,state,tables,symbols,text,specTables);result.specState=specState;
 const byName=new Map(),functionRows=tables.get(41),nodeTypes=tables.get(97),metrics=tables.get(103),float=new DataView(new ArrayBuffer(8));
 result.typed={...result.program,functions:result.program.functions.map((fn,fi)=>{const types=new Map(fn.nodes.map((n,i)=>[n.id,result.type(nodeTypes[functionRows[fi*14+4]+i])])),calls=new Map();for(const n of fn.nodes)for(const c of[n.callee,n.pred])if(c!==undefined){if(!byName.has(c))throw Error('invalid typed IR callee');calls.set(c,byName.get(c));}
 float.setUint32(0,metrics[fi*3+1],true);float.setUint32(4,metrics[fi*3+2],true);const typed={...fn,...(state[8]?{profile:'strict'}:{}),types,calls,literalIterations:metrics[fi*3],staticIterations:float.getFloat64(0,true)};byName.set(fn.name,typed);return typed;}),byName};
 return result;
 }
 return{parse,api,view,close:()=>api.frontend_close()};
}
