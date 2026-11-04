import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openAgentStore, reclaimDeadOwner, type OwnerProof, type StoreManifest } from '../src/store.ts';
import { recordHash, type AdmissionEnvelope, type AdmissionReceipt, type FinalOutcome, type OutcomeReceipt } from '../src/record.ts';

test('captured-worker kill resumes the same conversation and does not duplicate a committed external file effect',async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'throughline-durable-recovery-')));
  const manifest:StoreManifest={schema:'throughline.durable-store.v1',stateDirectory:join(directory,'state'),storeUuid:'recovery-store',publicAgentId:'recovery-agent',agentStateId:'recovery-state',appThreadId:'recovery-thread',cwd:directory};
  const manifestPath=join(directory,'manifest.json');await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
  const admissions=new Map<string,AdmissionReceipt>();const outcomes=new Map<string,OutcomeReceipt>();
  const children:Array<ReturnType<typeof spawn>>=[];
  function start(phase:string) {
    const ownerNonce=randomUUID();
    const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/crash-worker.ts',import.meta.url)),manifestPath,phase,ownerNonce],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH??'/usr/bin:/bin'}});
    children.push(child);let errors='';child.stderr?.on('data',chunk=>{errors+=chunk.toString();});
    const exited=once(child,'exit');
    const seen=new Map<string,Record<string,unknown>>();
    const waiting=new Map<string,(message:Record<string,unknown>)=>void>();
    child.on('message',(raw:unknown)=>{
      if(typeof raw!=='object'||raw===null||!('kind'in raw)||typeof raw.kind!=='string')return;
      const message=raw as Record<string,unknown>;
      if(message.kind==='record-request') {
        try {
          let receipt:AdmissionReceipt|OutcomeReceipt;
          if(message.operation==='admit') {
            const input=message.value as AdmissionEnvelope;const old=admissions.get(input.operationId);
            if(old&&old.payloadHash!==recordHash(input))throw Error('IDEMPOTENCY_CONFLICT');
            receipt=old??{recordHost:'tower',level:'rail-recorded',operationId:input.operationId,payloadHash:recordHash(input),taskId:'task:'+input.operationId,target:input.target};
            admissions.set(input.operationId,receipt);
          } else {
            const outcome=message.value as FinalOutcome;const old=outcomes.get(outcome.operationId);
            if(old&&old.outcomeHash!==recordHash(outcome))throw Error('IDEMPOTENCY_CONFLICT');
            receipt=old??{recordHost:'tower',level:'outcome-recorded',operationId:outcome.operationId,taskId:outcome.taskId,outcomeHash:recordHash(outcome),eventId:'terminal:'+outcome.taskId};
            outcomes.set(outcome.operationId,receipt);
          }
          if(child.connected)child.send({id:message.id,receipt});
        } catch(error) {if(child.connected)child.send({id:message.id,error:error instanceof Error?error.message:'RECORD_REFUSED'});}
        return;
      }
      seen.set(message.kind as string,message);waiting.get(message.kind as string)?.(message);
    });
    function wait(kind:string):Promise<Record<string,unknown>> {
      const found=seen.get(kind);if(found)return Promise.resolve(found);
      return new Promise((resolve,reject)=>{
        waiting.set(kind,resolve);
        exited.then(()=>{if(!seen.has(kind))reject(Error(`Worker exited before ${kind}: ${errors}`));},reject);
      });
    }
    return {child,exited,wait,ownerNonce};
  }
  try {
    const first=start('first');
    const ownerMessage=await first.wait('owner');const proof=ownerMessage.proof as OwnerProof;
    const effect=await first.wait('effect-committed');
    assert.equal(proof.pid,first.child.pid);assert.equal(proof.nonce,first.ownerNonce);
    first.child.kill('SIGKILL');await first.exited;
    await reclaimDeadOwner(manifest,proof);
    const faux=fauxProvider({provider:'throughline-recovery-fixture',api:'throughline-recovery-fixture'});
    const models=createModels();models.setProvider(faux.provider);const m=faux.getModel();
    const inspection=await openAgentStore(manifest,{models,model:{provider:m.provider,modelId:m.id},ownerNonce:randomUUID()},context);
    const historyBefore=await inspection.conversation.entries({order:'ascending'},100,undefined,context);
    const conversationBefore=inspection.conversation.id;
    await inspection.close(context);
    const second=start('resume');
    const secondOwner=await second.wait('owner');assert.equal(secondOwner.conversationId,conversationBefore);
    const replayedEffect=await second.wait('effect-committed');assert.equal(replayedEffect.taskId,effect.taskId);
    const finished=await second.wait('finished');const exit=await second.exited;assert.equal(exit[0],0);
    const historyAfter=finished.entries as Array<{id:number;kind:string}>;
    for(const entry of historyBefore.items)assert.ok(historyAfter.some(e=>e.id===entry.id&&e.kind===entry.kind));
    assert.equal(admissions.size,1);assert.equal(outcomes.size,1);
    const effects=(await readdir(directory)).filter(p=>p.startsWith('effect-'));
    assert.equal(effects.length,1);
    assert.equal(JSON.parse(await readFile(join(directory,effects[0]),'utf8')).taskId,effect.taskId);
    assert.equal(finished.modelCalls,1);
  } finally {
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await rm(directory,{recursive:true,force:true});
  }
});
