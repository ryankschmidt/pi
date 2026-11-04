import { readFile, open, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { once } from 'node:events';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { obj } from '@earendil-works/pi-schema';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openAgentStore, type StoreManifest } from '../../src/store.ts';
import { createAdmission } from '../../src/admission.ts';
import type { AdmissionReceipt, OutcomeReceipt, TowerRecordAdapter } from '../../src/record.ts';

const [manifestPath,phase,ownerNonce]=process.argv.slice(2);
const manifest:StoreManifest=JSON.parse(await readFile(manifestPath,'utf8'));
const faux=fauxProvider({provider:'throughline-recovery-fixture',api:'throughline-recovery-fixture'});
const models=createModels();models.setProvider(faux.provider);const m=faux.getModel();
const registry=createRegistry();
registry.install(defineExtension({name:'throughline-recovery-fixture',tools:[defineTool({
  name:'create_effect_receipt',description:'Create the test external effect once under its durable tool task identity.',parameters:obj({}),replay:'safe',
  execute:async(_args,api)=>{
    const path=join(manifest.cwd,`effect-${api.taskId}.json`);
    const pending=join(manifest.cwd,`.effect-${api.taskId}-${randomUUID()}.pending`);
    const file=await open(pending,'wx',0o600);
    try {
      try {await file.writeFile(JSON.stringify({taskId:api.taskId,effect:'created-once'}));await file.sync();}
      finally {await file.close();}
      try {await link(pending,path);}
      catch(error){if(!(typeof error==='object'&&error!==null&&'code'in error&&error.code==='EEXIST'))throw error;}
    } finally {await unlink(pending);}
    const saved=JSON.parse(await readFile(path,'utf8'));
    if(saved?.taskId!==api.taskId||saved.effect!=='created-once')throw Error('INVALID_EFFECT_RECEIPT');
    process.send?.({kind:'effect-committed',taskId:api.taskId});
    if(phase==='first')await once(process,'message');
    return {output:[{type:'text' as const,text:await readFile(path,'utf8')}]};
  },
})]}));
faux.setResponses(phase==='first'?[fauxAssistantMessage(fauxToolCall('create_effect_receipt',{}),{stopReason:'toolUse'}),fauxAssistantMessage('The effect receipt is preserved.')]:[fauxAssistantMessage('The effect receipt is preserved.')]);
let serial=0;
const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(reason:Error)=>void}>();
process.on('message',(message:unknown)=>{
  if(typeof message!=='object'||message===null||!('id'in message)||typeof message.id!=='number')return;
  const p=pending.get(message.id);if(!p)return;pending.delete(message.id);
  if('error'in message&&typeof message.error==='string')p.reject(Error(message.error));
  else p.resolve('receipt'in message?message.receipt:undefined);
});
function request(operation:'admit'|'complete',value:unknown):Promise<unknown> {
  const id=++serial;
  return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});process.send?.({kind:'record-request',id,operation,value});});
}
const record:TowerRecordAdapter={admit:async envelope=>await request('admit',envelope) as AdmissionReceipt,complete:async outcome=>await request('complete',outcome) as OutcomeReceipt};
const owner=await openAgentStore(manifest,{models,model:{provider:m.provider,modelId:m.id},registry,ownerNonce},context);
process.send?.({kind:'owner',proof:owner.proof,conversationId:owner.conversation.id});
try {
  const delivery=createAdmission(owner,record);
  const admitted=await delivery.admit({operationId:'recovery:one',sourceMessageId:'message:one',content:'Create the effect receipt and explain the result.'},context);
  const result=await delivery.finish('recovery:one',context);
  const entries=await owner.conversation.entries({order:'ascending'},100,undefined,context);
  process.send?.({kind:'finished',admitted,result,entries:entries.items.map(e=>({id:e.id,kind:e.kind})),modelCalls:faux.state.callCount});
} finally {
  await owner.close(context);
  process.disconnect?.();
}
