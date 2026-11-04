import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { SubmissionId } from '@earendil-works/pi-durable';
import { openAgentStore, type StoreManifest } from '../src/store.ts';
import { createAdmission } from '../src/admission.ts';
import { recordHash, type AdmissionEnvelope, type AdmissionReceipt, type FinalOutcome, type OutcomeReceipt, type TowerRecordAdapter } from '../src/record.ts';

// This is explicitly an injected test double, never an installed Tower adapter.
class FakeRecord implements TowerRecordAdapter {
  unavailable=false; completeUnavailable=false; loseCompletionAcknowledgement=false; admissions=new Map<string,AdmissionReceipt>(); outcomes=new Map<string,OutcomeReceipt>();
  async admit(input:AdmissionEnvelope):Promise<AdmissionReceipt> {
    if(this.unavailable)throw Error('TOWER_UNAVAILABLE');
    const existing=this.admissions.get(input.operationId);
    if(existing) {if(existing.payloadHash!==recordHash(input))throw Error('IDEMPOTENCY_CONFLICT');return existing;}
    const receipt:AdmissionReceipt={recordHost:'tower',level:'rail-recorded',operationId:input.operationId,payloadHash:recordHash(input),taskId:'task:'+input.operationId,target:input.target};
    this.admissions.set(input.operationId,receipt);return receipt;
  }
  async complete(outcome:FinalOutcome):Promise<OutcomeReceipt> {
    if(this.completeUnavailable)throw Error('TOWER_UNAVAILABLE');
    const existing=this.outcomes.get(outcome.operationId);
    if(existing){if(existing.outcomeHash!==recordHash(outcome))throw Error('IDEMPOTENCY_CONFLICT');return existing;}
    const receipt:OutcomeReceipt={recordHost:'tower',level:'outcome-recorded',operationId:outcome.operationId,taskId:outcome.taskId,outcomeHash:recordHash(outcome),eventId:'terminal:'+outcome.taskId};
    this.outcomes.set(outcome.operationId,receipt);
    if(this.loseCompletionAcknowledgement){this.loseCompletionAcknowledgement=false;throw Error('ACKNOWLEDGEMENT_LOST');}
    return receipt;
  }
}
async function fixture() {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'throughline-durable-admission-')));
  const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);const m=faux.getModel();
  const manifest:StoreManifest={schema:'throughline.durable-store.v1',stateDirectory:join(directory,'state'),storeUuid:'store',publicAgentId:'agent',agentStateId:'state',appThreadId:'thread',cwd:directory};
  const options={models,model:{provider:m.provider,modelId:m.id},ownerNonce:randomUUID()};
  const owner=await openAgentStore(manifest,options,context);const record=new FakeRecord();
  return {directory,faux,manifest,owner,record,options,delivery:createAdmission(owner,record)};
}
const input={operationId:'message:one',sourceMessageId:'source:one',content:'Produce a useful result'};

test('Tower unavailability refuses before private input admission or model execution',async()=>{
  const f=await fixture();
  try {
    f.record.unavailable=true;
    await assert.rejects(f.delivery.admit(input,context),/TOWER_UNAVAILABLE/);
    const history=await f.owner.conversation.entries({order:'ascending'},100,undefined,context);
    assert.equal(history.items.filter(e=>e.kind==='pi.user').length,0);
    assert.equal(f.faux.state.callCount,0);
    await assert.rejects(f.delivery.inspect(input.operationId,context),/DELIVERY_NOT_ADMITTED/);
  } finally {await f.owner.close(context);await rm(f.directory,{recursive:true,force:true});}
});

test('redelivery binds one native submission; changed content with the same identity refuses',async()=>{
  const f=await fixture();
  try {
    f.faux.setResponses([fauxAssistantMessage('The useful result.')]);
    const first=await f.delivery.admit(input,context);
    const duplicate=await f.delivery.admit(input,context);
    assert.equal(duplicate.submissionId,first.submissionId);
    await assert.rejects(f.delivery.admit({...input,content:'different task'},context),/IDEMPOTENCY_CONFLICT/);
    const result=await f.delivery.finish(input.operationId,context);
    assert.equal(result.outcome?.status,'response-produced');
    assert.equal(result.outcome?.text,'The useful result.');
    assert.equal(f.faux.state.callCount,1);
    assert.equal(f.record.admissions.size,1);assert.equal(f.record.outcomes.size,1);
    const again=await f.delivery.finish(input.operationId,context);
    assert.deepEqual(again,result);assert.equal(f.faux.state.callCount,1);
  } finally {await f.owner.close(context);await rm(f.directory,{recursive:true,force:true});}
});

test('Tower outage after local work is recovered by publication only, never by rerunning work',async()=>{
  const f=await fixture();
  try {
    f.faux.setResponses([fauxAssistantMessage('Kept result.')]);
    await f.delivery.admit(input,context);f.record.completeUnavailable=true;
    await assert.rejects(f.delivery.finish(input.operationId,context),/TOWER_UNAVAILABLE/);
    const pending=await f.delivery.inspect(input.operationId,context);
    assert.equal(pending.outcome?.text,'Kept result.');assert.equal(pending.outcomeReceipt,null);
    assert.equal(f.faux.state.callCount,1);
    await f.owner.close(context);
    const reopened=await openAgentStore(f.manifest,f.options,context);
    try {
      f.record.completeUnavailable=false;
      const delivery=createAdmission(reopened,f.record);
      await delivery.recover(context);
      assert.equal((await delivery.inspect(input.operationId,context)).outcomeReceipt?.level,'outcome-recorded');
      assert.equal(f.faux.state.callCount,1);
      assert.equal(f.record.outcomes.size,1);
    } finally {await reopened.close(context);}
  } finally {await f.owner.close(context);await rm(f.directory,{recursive:true,force:true});}
});

test('recovery publishes native work that completed before an outcome was saved',async()=>{
  const f=await fixture();
  try {
    f.faux.setResponses([fauxAssistantMessage('Completed before publication.')]);
    const admitted=await f.delivery.admit(input,context);
    const native=await f.owner.harness.submission(admitted.submissionId as SubmissionId,context);assert.ok(native);
    await native.wait(context);assert.equal(f.record.outcomes.size,0);
    await f.owner.close(context);
    const reopened=await openAgentStore(f.manifest,{...f.options,ownerNonce:randomUUID()},context);
    try {
      const delivery=createAdmission(reopened,f.record);await delivery.recover(context);
      assert.equal((await delivery.inspect(input.operationId,context)).outcome?.text,'Completed before publication.');
      assert.equal(f.record.outcomes.size,1);assert.equal(f.faux.state.callCount,1);
      assert.ok(Object.isFrozen(reopened.target));
    } finally {await reopened.close(context);}
  } finally {await f.owner.close(context);await rm(f.directory,{recursive:true,force:true});}
});

test('a committed shared outcome with a lost acknowledgement returns its original receipt',async()=>{
  const f=await fixture();
  try {
    f.faux.setResponses([fauxAssistantMessage('Durable candidate.')]);
    await f.delivery.admit(input,context);f.record.loseCompletionAcknowledgement=true;
    await assert.rejects(f.delivery.finish(input.operationId,context),/ACKNOWLEDGEMENT_LOST/);
    const committed=f.record.outcomes.get(input.operationId);assert.ok(committed);
    const recovered=await f.delivery.finish(input.operationId,context);
    assert.deepEqual(recovered.receipt,committed);assert.equal(f.faux.state.callCount,1);
  } finally {await f.owner.close(context);await rm(f.directory,{recursive:true,force:true});}
});

test('runtime-invalid input and receipt fields refuse rather than create a completed state',async()=>{
  const f=await fixture();
  try {
    await assert.rejects(f.delivery.admit({...input,sourceMessageId:123} as unknown as typeof input,context),/STABLE_OPERATION_REQUIRED/);
    assert.equal(f.record.admissions.size,0);
    const malformed:TowerRecordAdapter={admit:async envelope=>({...await f.record.admit(envelope),taskId:true} as unknown as AdmissionReceipt),complete:outcome=>f.record.complete(outcome)};
    await assert.rejects(createAdmission(f.owner,malformed).admit(input,context),/TOWER_ADMISSION_BINDING_MISMATCH/);
    assert.equal(f.faux.state.callCount,0);
  } finally {await f.owner.close(context);await rm(f.directory,{recursive:true,force:true});}
});

test('a receipt for a different conversation cannot authorize execution',async()=>{
  const f=await fixture();
  try {
    const wrong:TowerRecordAdapter={...f.record,complete:o=>f.record.complete(o),admit:async e=>({...await f.record.admit(e),target:{...e.target,conversationId:999}})};
    const delivery=createAdmission(f.owner,wrong);
    await assert.rejects(delivery.admit(input,context),/TOWER_ADMISSION_BINDING_MISMATCH/);
    assert.equal(f.faux.state.callCount,0);
  } finally {await f.owner.close(context);await rm(f.directory,{recursive:true,force:true});}
});
