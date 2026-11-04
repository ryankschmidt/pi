// Disposable, unprivileged IPC owner. This is not the production supervisor or kernel authentication.
import { open, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createRegistry, defineDoc, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { OwnerPort } from './owner-port.js';
import type { Target } from './contract.js';

const [dir,generation]=process.argv.slice(2);
const send=(value:unknown)=>process.send?.(value as any);
const Meta=defineDoc<{storeUuid:string;conversations:number[]}>({kind:'fixture.owner-meta',version:1,scope:'session',checkpointWhen:()=>true,initial:()=>({storeUuid:'',conversations:[]})});
async function main() {
  if(!dir||!generation)throw Error('FIXTURE_ARGUMENTS');
  if((await lstat(dir)).isSymbolicLink())throw Error('UNSAFE_FIXTURE_DIRECTORY');
  const lockPath=join(dir,'owner.lock');
  const lock=await open(lockPath,'wx',0o600).catch(()=>{throw Error('OWNER_EXISTS');});
  await lock.writeFile(JSON.stringify({pid:process.pid,generation,fixture:true}));await lock.sync();
  const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();
  let released=false,modelCalls=0,commits=0,crashPhase:string|null=null,viewer:number|null=null;
  const gates=new Set<()=>void>();
  const response=async (_context:any,options:any)=>{
    modelCalls++;send({event:'model-attempt',generation,attempt:modelCalls});
    if(!released)await new Promise<void>((resolve,reject)=>{
      const release=()=>{gates.delete(release);options?.signal?.removeEventListener('abort',abort);resolve();};
      const abort=()=>{gates.delete(release);reject(Error('FIXTURE_MODEL_ABORTED'));};
      gates.add(release);if(options?.signal?.aborted)abort();else options?.signal?.addEventListener('abort',abort,{once:true});
    });
    return fauxAssistantMessage('fixture answer: harmless retained input');
  };
  faux.setResponses(Array.from({length:32},()=>response));
  const harness=await Harness.open(await openNodeSqliteStorage(join(dir,'private.sqlite')),{models,registry:createRegistry(),settings:{compaction:{enabled:false}}},ctx);
  harness.observeCommits({advance:()=>{commits++;},end:()=>{}});
  let meta=await harness.snapshot(Meta,ctx);
  if(!meta){
    const agent={model:{provider:model.provider,modelId:model.id}};
    const root=await harness.root(ctx,{agent});const other=await harness.createConversation({ownership:{kind:'ownerless'},agent},ctx);
    await harness.commit(async tx=>{const d=await tx.doc(Meta);d.storeUuid=randomUUID();d.conversations=[root.id,other.id];},ctx);
    meta=await harness.snapshot(Meta,ctx);
  }
  if(!meta?.storeUuid||meta.conversations.length!==2)throw Error('INVALID_FIXTURE_METADATA');
  const targets:Target[]=meta.conversations.map(conversationId=>({deviceId:'fixture-tower',publicAgentId:'fixture-agent',agentStateId:'fixture-state',storeUuid:meta!.storeUuid,conversationId}));
  const port=new OwnerPort(harness,targets,generation,async(phase,data)=>{
    send({event:phase,generation,...data});
    if(crashPhase===phase)await new Promise<void>(()=>{}); // parent kills only this recorded disposable PID
  });
  send({event:'ready',generation,target:targets[0],otherTarget:targets[1],profile:{fixture:true,compaction:false,networkTools:false,realModels:false}});
  process.on('message',async(message:any)=>{
    const {id,method,args:a}=message;
    try {
      let result:unknown;
      switch(method){
        case 'inspect':result=await port.inspect(a.target,a.operationId,a.authority);break;
        case 'ensure':result=await port.ensure(a,a.authority);break;
        case 'reconcile':result=await port.reconcile(a.target,a.operationId,a.authority);break;
        case 'wait':result=await port.wait(a.target,a.operationId,a.authority);break;
        case 'cancel':result=await port.cancel(a.target,a.operationId,a.authority);break;
        // Fixture-only control: withdraw the known queued submission while its admission call is paused.
        case 'cancelNativeFixture':if(a.authority?.generation!==generation||a.authority?.caller!=='fixture-delivery'||a.authority?.fixture!==true)throw Error('AUTHORITY_REFUSED');if(!targets.some(t=>JSON.stringify(t)===JSON.stringify(a.target)))throw Error('TARGET_MISMATCH');result={result:await harness.abortSubmission(a.submissionId,ctx,a.target.conversationId)};break;
        case 'audit':result=await port.audit();break;
        case 'metrics':result={...port.metrics,commits,modelCalls};break;
        case 'setCrash':if(!['after-reservation','after-native','after-link'].includes(a.phase))throw Error('INVALID_PHASE');crashPhase=a.phase;result={phase:crashPhase};break;
        case 'releaseModel':released=true;for(const g of [...gates])g();result={released:true};break;
        case 'holdModel':released=false;result={released:false};break;
        case 'selectViewer':viewer=a.conversationId;result={viewer};break;
        case 'close':await harness.close(ctx);await lock.close();await unlink(lockPath);process.send?.({id,result:{closed:true}},()=>process.exit(0));return;
        default:throw Error('UNKNOWN_FIXTURE_METHOD');
      }
      send({id,result});
    } catch(e){send({id,error:e instanceof Error?e.message:String(e)});}
  });
}
main().catch(e=>process.send?.({event:'fatal',error:e instanceof Error?e.message:String(e)},()=>process.exit(1)));
