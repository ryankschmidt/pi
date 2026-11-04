import type { Context } from '@earendil-works/chord';
import { AssistantEntry, defineDoc, type SubmissionId } from '@earendil-works/pi-durable';
import type { OpenAgentStore } from './store.ts';
import { canonical, recordHash, validateAdmission, validateOutcome, type AdmissionEnvelope, type AdmissionReceipt, type FinalOutcome, type OutcomeReceipt, type TowerRecordAdapter } from './record.ts';

type Reservation = {
  envelope:AdmissionEnvelope; admission:AdmissionReceipt;
  submissionId:number|null; outcome:FinalOutcome|null; outcomeReceipt:OutcomeReceipt|null;
};
const Reservations=defineDoc<{items:Record<string,Reservation>}>({
  kind:'throughline.durable-deliveries',version:1,scope:'session',checkpointWhen:()=>true,initial:()=>({items:{}}),
});
export interface DeliveryInput { operationId:string; sourceMessageId:string; content:string; whenBusy?:'steer'|'followUp' }
export function createAdmission(owner:OpenAgentStore,record:TowerRecordAdapter) {
  const target=owner.target;
  const key=(operationId:string)=>'rail:'+operationId;
  async function reservation(operationId:string,context:Context) {
    const doc=await owner.harness.snapshot(Reservations,context);
    const saved=doc?.items[key(operationId)];
    if(!saved)throw Error('DELIVERY_NOT_ADMITTED');
    if(saved.envelope.operationId!==operationId||canonical(saved.envelope.target)!==canonical(target))throw Error('DELIVERY_TARGET_MISMATCH');
    validateAdmission(saved.envelope,saved.admission);
    if(saved.submissionId!==null&&(!Number.isSafeInteger(saved.submissionId)||saved.submissionId<=0))throw Error('INVALID_SUBMISSION_BINDING');
    if(saved.outcome!==null&&(saved.outcome.operationId!==operationId||saved.outcome.taskId!==saved.admission.taskId||saved.outcome.submissionId!==saved.submissionId||canonical(saved.outcome.target)!==canonical(target)))throw Error('OUTCOME_BINDING_MISMATCH');
    if(saved.outcomeReceipt!==null){if(saved.outcome===null)throw Error('OUTCOME_MISSING');validateOutcome(saved.outcome,saved.outcomeReceipt);}
    return JSON.parse(JSON.stringify(saved)) as Reservation;
  }
  async function link(operationId:string,context:Context) {
    const saved=await reservation(operationId,context);
    if(saved.submissionId!==null)return saved.submissionId;
    const admitted=await owner.conversation.submit({type:'input',content:saved.envelope.content,whenBusy:saved.envelope.whenBusy,requestId:key(operationId)},context);
    await owner.harness.commit(async tx=>{
      const doc=await tx.doc(Reservations);const current=doc.items[key(operationId)];
      if(!current||recordHash(current.envelope)!==recordHash(saved.envelope))throw Error('RESERVATION_CHANGED');
      if(current.submissionId!==null&&current.submissionId!==admitted.id)throw Error('SUBMISSION_BINDING_CHANGED');
      current.submissionId=admitted.id;
    },context);
    return admitted.id;
  }
  async function admit(input:DeliveryInput,context:Context) {
    if(typeof input.operationId!=='string'||!/^[A-Za-z0-9:._-]{1,256}$/.test(input.operationId)||typeof input.sourceMessageId!=='string'||input.sourceMessageId.length===0||typeof input.content!=='string'||(input.whenBusy!==undefined&&input.whenBusy!=='steer'&&input.whenBusy!=='followUp'))throw Error('STABLE_OPERATION_REQUIRED');
    const envelope:AdmissionEnvelope={schema:'throughline.mac-durable.input.v1',operationId:input.operationId,sourceMessageId:input.sourceMessageId,target,content:input.content,whenBusy:input.whenBusy??'followUp'};
    const prior=(await owner.harness.snapshot(Reservations,context))?.items[key(input.operationId)];
    if(prior&&recordHash(prior.envelope)!==recordHash(envelope))throw Error('IDEMPOTENCY_CONFLICT');
    // Do not submit locally while Tower is unavailable, even on redelivery.
    const receipt=await record.admit(envelope);validateAdmission(envelope,receipt);
    await owner.harness.commit(async tx=>{
      const doc=await tx.doc(Reservations);const old=doc.items[key(input.operationId)];
      if(old) {
        if(recordHash(old.envelope)!==recordHash(envelope))throw Error('IDEMPOTENCY_CONFLICT');
        if(canonical(old.admission)!==canonical(receipt))throw Error('TOWER_RECEIPT_CHANGED');
      } else doc.items[key(input.operationId)]={envelope,admission:receipt,submissionId:null,outcome:null,outcomeReceipt:null};
    },context);
    const submissionId=await link(input.operationId,context);
    return {level:'inbox-admitted' as const,operationId:input.operationId,taskId:receipt.taskId,target,submissionId};
  }
  async function finish(operationId:string,context:Context) {
    let saved=await reservation(operationId,context);
    if(saved.outcomeReceipt!==null)return {outcome:saved.outcome,receipt:saved.outcomeReceipt};
    if(saved.outcome===null) {
      if(saved.submissionId===null)throw Error('SUBMISSION_NOT_LINKED');
      const submission=await owner.harness.submission(saved.submissionId as SubmissionId,context);
      if(!submission)throw Error('SUBMISSION_MISSING');
      const settled=await submission.wait(context);
      if(settled.conversationId!==target.conversationId||settled.requestId!==key(operationId)||settled.type!=='input')throw Error('SUBMISSION_BINDING_MISMATCH');
      let text='';let answerEntryId:number|null=null;
      if(settled.status==='done') {
        answerEntryId=settled.answer;
        const answer=await owner.conversation.commit(tx=>tx.entry(AssistantEntry,settled.answer),context);
        for(const message of answer?.model??[]) {
          if(message.role==='assistant')for(const part of message.content)if(part.type==='text')text+=part.text;
        }
      }
      const outcome:FinalOutcome={schema:'throughline.mac-durable.outcome.v1',operationId,taskId:saved.admission.taskId,target,submissionId:saved.submissionId,status:settled.status==='done'?'response-produced':'unanswered',answerEntryId,text,reason:settled.status==='unanswered'?settled.reason:null};
      await owner.harness.commit(async tx=>{
        const doc=await tx.doc(Reservations);const current=doc.items[key(operationId)];
        if(!current||current.submissionId!==outcome.submissionId)throw Error('SUBMISSION_BINDING_CHANGED');
        if(current.outcome!==null&&recordHash(current.outcome)!==recordHash(outcome))throw Error('OUTCOME_CHANGED');
        current.outcome=outcome;
      },context);
      saved=await reservation(operationId,context);
    }
    const outcome=saved.outcome;
    if(outcome===null)throw Error('OUTCOME_MISSING');
    // A local answer is pending shared publication until this acknowledgement.
    // Retrying only publication cannot re-run the model or its tools.
    const receipt=await record.complete(outcome);validateOutcome(outcome,receipt);
    await owner.harness.commit(async tx=>{
      const doc=await tx.doc(Reservations);const current=doc.items[key(operationId)];
      if(!current||recordHash(current.outcome)!==recordHash(outcome))throw Error('OUTCOME_CHANGED');
      if(current.outcomeReceipt!==null&&canonical(current.outcomeReceipt)!==canonical(receipt))throw Error('OUTCOME_RECEIPT_CHANGED');
      current.outcomeReceipt=receipt;
    },context);
    return {outcome,receipt};
  }
  async function inspect(operationId:string,context:Context) {return reservation(operationId,context);}
  async function recover(context:Context) {
    const doc=await owner.harness.snapshot(Reservations,context);
    const results=await Promise.allSettled(Object.entries(doc?.items??{}).map(async([storedKey,item])=>{
      if(storedKey!==key(item.envelope.operationId))throw Error('RESERVATION_KEY_MISMATCH');
      const saved=await reservation(item.envelope.operationId,context);
      if(saved.outcomeReceipt!==null)return;
      if(saved.outcome===null){
        const {operationId,sourceMessageId,content,whenBusy}=saved.envelope;
        await admit({operationId,sourceMessageId,content,whenBusy},context);
      }
      await finish(saved.envelope.operationId,context);
    }));
    const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
    if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'DELIVERY_RECOVERY_INCOMPLETE');
  }
  return {admit,finish,inspect,recover};
}
