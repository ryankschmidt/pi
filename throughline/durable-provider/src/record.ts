import { createHash } from 'node:crypto';

export type ConversationTarget={storeUuid:string;conversationId:number;appThreadId:string;publicAgentId:string;agentStateId:string};
export type AdmissionEnvelope={
  schema:'throughline.mac-durable.input.v1';operationId:string;sourceMessageId:string;
  target:ConversationTarget;content:string;whenBusy:'steer'|'followUp';
};
export type AdmissionReceipt={
  recordHost:'tower';level:'rail-recorded';operationId:string;payloadHash:string;taskId:string;target:ConversationTarget;
};
export type FinalOutcome={
  schema:'throughline.mac-durable.outcome.v1';operationId:string;taskId:string;target:ConversationTarget;submissionId:number;
  status:'response-produced'|'unanswered';answerEntryId:number|null;text:string;reason:string|null;
};
export type OutcomeReceipt={
  recordHost:'tower';level:'outcome-recorded';operationId:string;taskId:string;outcomeHash:string;eventId:string;
};
// Implemented by a server-owned authenticated adapter. No caller DB options,
// credentials, arbitrary SQL, or fallback storage are part of this boundary.
export interface TowerRecordAdapter {
  admit(envelope:AdmissionEnvelope):Promise<AdmissionReceipt>;
  complete(outcome:FinalOutcome):Promise<OutcomeReceipt>;
}
export function canonical(value:unknown):string {
  const parents=new Set<object>();
  function encode(item:unknown):string {
    if(item===null||typeof item==='string'||typeof item==='boolean')return JSON.stringify(item);
    if(typeof item==='number'&&Number.isFinite(item)&&(!Number.isInteger(item)||Number.isSafeInteger(item)))return JSON.stringify(item);
    if(typeof item!=='object'||item===null||parents.has(item))throw Error('NON_JSON_RECORD');
    parents.add(item);
    try {
      if(Object.getOwnPropertySymbols(item).length)throw Error('NON_JSON_RECORD');
      if(Array.isArray(item)) {
        if(Object.keys(item).length!==item.length||Object.getOwnPropertyNames(item).length!==item.length+1)throw Error('NON_JSON_RECORD');
        return '['+Array.from({length:item.length},(_,index)=>{
          const field=Object.getOwnPropertyDescriptor(item,String(index));
          if(!field||!('value'in field)||!field.enumerable)throw Error('NON_JSON_RECORD');
          return encode(field.value);
        }).join(',')+']';
      }
      if(Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)throw Error('NON_JSON_RECORD');
      if(Object.getOwnPropertyNames(item).length!==Object.keys(item).length)throw Error('NON_JSON_RECORD');
      return '{'+Object.keys(item).sort().map(key=>{
        const field=Object.getOwnPropertyDescriptor(item,key);
        if(!field||!('value'in field))throw Error('NON_JSON_RECORD');
        return JSON.stringify(key)+':'+encode(field.value);
      }).join(',')+'}';
    } finally {parents.delete(item);}
  }
  return encode(value);
}
export function recordHash(value:unknown) {return createHash('sha256').update(canonical(value)).digest('hex');}
function text(value:unknown):value is string {return typeof value==='string'&&value.length>0;}
function positiveId(value:unknown):value is number {return typeof value==='number'&&Number.isSafeInteger(value)&&value>0;}
function targetValid(target:ConversationTarget) {
  return typeof target==='object'&&target!==null&&positiveId(target.conversationId)&&[target.storeUuid,target.appThreadId,target.publicAgentId,target.agentStateId].every(text);
}
export function validateAdmission(envelope:AdmissionEnvelope,receipt:AdmissionReceipt) {
  if(!envelope||envelope.schema!=='throughline.mac-durable.input.v1'||!text(envelope.operationId)||!text(envelope.sourceMessageId)||typeof envelope.content!=='string'||!['steer','followUp'].includes(envelope.whenBusy)||!targetValid(envelope.target)||!receipt||receipt.recordHost!=='tower'||receipt.level!=='rail-recorded'||receipt.operationId!==envelope.operationId||receipt.payloadHash!==recordHash(envelope)||!targetValid(receipt.target)||canonical(receipt.target)!==canonical(envelope.target)||!text(receipt.taskId))throw Error('TOWER_ADMISSION_BINDING_MISMATCH');
}
export function validateOutcome(outcome:FinalOutcome,receipt:OutcomeReceipt) {
  if(!outcome||outcome.schema!=='throughline.mac-durable.outcome.v1'||!text(outcome.operationId)||!text(outcome.taskId)||!targetValid(outcome.target)||!positiveId(outcome.submissionId)||typeof outcome.text!=='string'||!['response-produced','unanswered'].includes(outcome.status)||(outcome.status==='response-produced'&&(!positiveId(outcome.answerEntryId)||outcome.reason!==null))||(outcome.status==='unanswered'&&(!text(outcome.reason)||outcome.answerEntryId!==null))||!receipt||receipt.recordHost!=='tower'||receipt.level!=='outcome-recorded'||receipt.operationId!==outcome.operationId||receipt.taskId!==outcome.taskId||receipt.outcomeHash!==recordHash(outcome)||!text(receipt.eventId))throw Error('TOWER_OUTCOME_BINDING_MISMATCH');
}
