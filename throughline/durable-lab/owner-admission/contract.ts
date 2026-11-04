// Isolated conformance contract, not a production provider/rail schema.
import { createHash } from 'node:crypto';
// Local experiment profile: restrictive intersection agreed for codec-r2 only.
// Root value depth is zero; each object/array member increments depth by one.
// The raw byte limit includes whitespace/escape spelling, not canonical output size.
export const OWNER_FIXTURE_CODEC_LIMITS=Object.freeze({maxDepth:64,maxRawUtf8Bytes:65536});
export type Target = {deviceId:string;publicAgentId:string;agentStateId:string;storeUuid:string;conversationId:number};
export type Authority = {fixture:true;generation:string;caller:string};
export type Origin = {sender:string;generation:string;envelopeHash:string;proofRef:string};
export type Admission = {target:Target;operationId:string;payload:unknown;origin:Origin};
export const hash=(bytes:string)=>createHash('sha256').update(bytes,'utf8').digest('hex');
function validString(s:string) {
  for(let i=0;i<s.length;i++) {
    const c=s.charCodeAt(i);
    if(c>=0xd800&&c<=0xdbff){const n=s.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))throw Error('LONE_SURROGATE');}
    else if(c>=0xdc00&&c<=0xdfff)throw Error('LONE_SURROGATE');
  }
}
export function canonical(value:unknown):string {
  const seen=new Set<object>();
  function encode(x:unknown,depth:number):string {
    if(depth>OWNER_FIXTURE_CODEC_LIMITS.maxDepth)throw Error('JSON_DEPTH');
    if(x===null)return 'null';
    if(typeof x==='string'){validString(x);return JSON.stringify(x);}
    if(typeof x==='boolean')return JSON.stringify(x);
    if(typeof x==='number') {if(!Number.isFinite(x)||(Number.isInteger(x)&&!Number.isSafeInteger(x)))throw Error('INVALID_NUMBER');return JSON.stringify(x);}
    if(typeof x!=='object')throw Error('UNSUPPORTED_VALUE');
    if(seen.has(x))throw Error('JSON_CYCLE');seen.add(x);
    try {
      if(Object.getOwnPropertySymbols(x).length)throw Error('UNSUPPORTED_KEYS');
      if(Array.isArray(x)) {
        if(Object.getOwnPropertyNames(x).length!==x.length+1||Object.keys(x).length!==x.length)throw Error('SPARSE_OR_EXTENDED_ARRAY');
        const parts=[];for(let i=0;i<x.length;i++){const d=Object.getOwnPropertyDescriptor(x,String(i));if(!d||!('value'in d)||!d.enumerable)throw Error('ARRAY_ACCESSOR_OR_HIDDEN_INDEX');parts.push(encode(d.value,depth+1));}return '['+parts.join(',')+']';
      }
      if(Object.getPrototypeOf(x)!==Object.prototype&&Object.getPrototypeOf(x)!==null)throw Error('NON_JSON_OBJECT');
      if(Object.getOwnPropertyNames(x).length!==Object.keys(x).length)throw Error('NONENUMERABLE_PROPERTY');
      return '{'+Object.keys(x).sort().map(k=>{validString(k);const d=Object.getOwnPropertyDescriptor(x,k)!;if(!('value'in d))throw Error('OBJECT_ACCESSOR');return JSON.stringify(k)+':'+encode(d.value,depth+1);}).join(',')+'}';
    } finally {seen.delete(x);}
  }
  return encode(value,0);
}
// Reject duplicate raw keys before JSON.parse can discard them. JSON.parse alone is not this boundary.
export function canonicalRaw(raw:string):string {
  if(Buffer.byteLength(raw,'utf8')>OWNER_FIXTURE_CODEC_LIMITS.maxRawUtf8Bytes)throw Error('JSON_SIZE');let i=0;
  const ws=()=>{while(/[\x20\t\n\r]/.test(raw[i]??'!'))i++;};
  function str():string {const start=i++;while(i<raw.length){const c=raw[i++];if(c==='\\'){i++;continue;}if(c==='"')return JSON.parse(raw.slice(start,i));}throw Error('INVALID_JSON');}
  function val(depth:number):unknown {
    if(depth>OWNER_FIXTURE_CODEC_LIMITS.maxDepth)throw Error('JSON_DEPTH');ws();const c=raw[i];
    if(c==='"')return str();
    if(c==='{'){i++;ws();const o:Record<string,unknown>=Object.create(null);const keys=new Set<string>();if(raw[i]==='}'){i++;return o;}for(;;){ws();if(raw[i]!=='"')throw Error('INVALID_JSON');const k=str();if(keys.has(k))throw Error('DUPLICATE_KEY');keys.add(k);ws();if(raw[i++]!==':')throw Error('INVALID_JSON');o[k]=val(depth+1);ws();const end=raw[i++];if(end==='}')return o;if(end!==',')throw Error('INVALID_JSON');}}
    if(c==='['){i++;ws();const a:unknown[]=[];if(raw[i]===']'){i++;return a;}for(;;){a.push(val(depth+1));ws();const end=raw[i++];if(end===']')return a;if(end!==',')throw Error('INVALID_JSON');}}
    const m=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(i));if(!m)throw Error('INVALID_JSON');i+=m[0].length;return JSON.parse(m[0]);
  }
  const result=val(0);ws();if(i!==raw.length)throw Error('INVALID_JSON');return canonical(result);
}
