import { defineDoc, type Harness, type Conversation, type SubmissionId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { canonical, hash, type Admission, type Authority, type Origin, type Target } from './contract.js';

type Reservation={target:Target;operationId:string;requestId:string;payloadCanonical:string;contentHash:string;origin:Origin;originalOwnerGeneration:string;submissionId:number|null};
const Reservations=defineDoc<{items:Record<string,Reservation>}>({kind:'fixture.owner-reservations',version:1,scope:'session',checkpointWhen:()=>true,initial:()=>({items:{}})});
const clone=<T>(v:T):T=>JSON.parse(canonical(v));
export class OwnerPort {
  metrics={reservationTransactions:0,submitCalls:0,linkTransactions:0,waitCalls:0};
  constructor(readonly harness:Harness,readonly targets:Target[],readonly generation:string,readonly boundary:(phase:string,data:Record<string,unknown>)=>Promise<void>=async()=>{}){}
  private authorize(target:Target,auth:Authority) {
    if(auth?.fixture!==true||auth.generation!==this.generation||auth.caller!=='fixture-delivery')throw Error('AUTHORITY_REFUSED');
    if(!this.targets.some(t=>canonical(t)===canonical(target)))throw Error('TARGET_MISMATCH');
  }
  private async record(target:Target,operationId:string,auth:Authority) {
    this.authorize(target,auth);
    const doc=await this.harness.snapshot(Reservations,ctx);
    const r=doc?.items['rail:'+operationId];
    if(r&&canonical(r.target)!==canonical(target))throw Error('TARGET_MISMATCH');
    return r?clone(r):undefined;
  }
  async inspect(target:Target,operationId:string,auth:Authority):Promise<any> {
    const r=await this.record(target,operationId,auth);
    if(!r)return {kind:'authoritative-absent',target};
    if(r.submissionId===null)return {kind:'reserved',admission:'unknown-until-reconciled',reservation:r};
    const handle=await this.harness.submission(r.submissionId as SubmissionId,ctx);
    if(!handle)throw Error('LINKED_NATIVE_RECORD_MISSING');
    const s=await handle.status(ctx);
    if(s.conversationId!==target.conversationId||s.requestId!==r.requestId)throw Error('NATIVE_BINDING_MISMATCH');
    return {kind:'admitted',status:s.status==='done'?(s.type==='input'?'answered':'written'):s.status,native:{storeUuid:target.storeUuid,conversationId:s.conversationId,submissionId:s.id},nativeRecord:s,reservation:r,...(s.status==='unanswered'?{reason:s.reason}: {})};
  }
  async ensure(input:Admission,auth:Authority):Promise<any> {
    this.authorize(input.target,auth);
    if(!/^[A-Za-z0-9:._-]{1,256}$/.test(input.operationId))throw Error('INVALID_OPERATION');
    const clean=clone(input);const key='rail:'+clean.operationId;
    const payloadCanonical=canonical(clean.payload),contentHash=hash(canonical({target:clean.target,payload:clean.payload,origin:clean.origin}));
    this.metrics.reservationTransactions++;
    await this.harness.commit(async tx=>{
      const d=await tx.doc(Reservations);const old=d.items[key];
      if(old){if(canonical(old.target)!==canonical(clean.target))throw Error('TARGET_MISMATCH');if(old.contentHash!==contentHash)throw Error('IDEMPOTENCY_CONFLICT');return;}
      d.items[key]={target:clean.target,operationId:clean.operationId,requestId:key,payloadCanonical,contentHash,origin:clean.origin,originalOwnerGeneration:this.generation,submissionId:null};
    },ctx);
    await this.boundary('after-reservation',{operationId:clean.operationId});
    return this.reconcile(clean.target,clean.operationId,auth);
  }
  async reconcile(target:Target,operationId:string,auth:Authority):Promise<any> {
    const r=await this.record(target,operationId,auth);if(!r)throw Error('NO_RESERVATION');
    if(r.submissionId!==null)return this.inspect(target,operationId,auth);
    const conv=await this.harness.conversation(target.conversationId as Conversation['id'],ctx);if(!conv)throw Error('CONVERSATION_MISSING');
    // Current fixture authority is rechecked; real supervisor fencing remains a production obligation.
    this.authorize(target,auth);this.metrics.submitCalls++;
    const s=await conv.submit({type:'input',content:r.payloadCanonical,whenBusy:'followUp',requestId:r.requestId},ctx);
    await this.boundary('after-native',{operationId,submissionId:s.id,requestId:r.requestId,linked:false});
    this.authorize(target,auth);this.metrics.linkTransactions++;
    await this.harness.commit(async tx=>{const d=await tx.doc(Reservations);const old=d.items[r.requestId];if(!old||old.contentHash!==r.contentHash)throw Error('RESERVATION_CHANGED');if(old.submissionId!==null&&old.submissionId!==s.id)throw Error('SUBMISSION_CHANGED');old.submissionId=s.id;},ctx);
    await this.boundary('after-link',{operationId,submissionId:s.id,linked:true});
    return this.inspect(target,operationId,auth);
  }
  async wait(target:Target,operationId:string,auth:Authority) {
    const r=await this.record(target,operationId,auth);if(r?.submissionId==null)throw Error('NOT_LINKED');
    const s=await this.harness.submission(r.submissionId as SubmissionId,ctx);if(!s)throw Error('LINKED_NATIVE_RECORD_MISSING');
    this.metrics.waitCalls++;await s.wait(ctx);return this.inspect(target,operationId,auth);
  }
  async cancel(target:Target,operationId:string,auth:Authority) {
    const r=await this.record(target,operationId,auth);if(r?.submissionId==null)throw Error('NOT_LINKED');
    return {result:await this.harness.abortSubmission(r.submissionId as SubmissionId,ctx,target.conversationId as Conversation['id'])};
  }
  async audit() {
    const d=await this.harness.snapshot(Reservations,ctx);const entries=Object.values(d?.items??{});
    const submissions=await this.harness.commit(async tx=>Promise.all(entries.map(r=>tx.submissionByRequest(r.target.conversationId as Conversation['id'],r.requestId))),ctx);
    return {reservations:entries,submissions:submissions.filter(Boolean),logicalSubmissionIds:[...new Set(submissions.filter(Boolean).map(s=>s!.id))]};
  }
}
