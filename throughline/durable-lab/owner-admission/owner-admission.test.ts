import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { canonical, canonicalRaw } from './contract.js';

test('canonical content preserves business distinctions and rejects lossy input', () => {
  assert.equal(canonicalRaw('{"b":2,"a":1.0}'), '{"a":1,"b":2}');
  assert.equal(canonicalRaw('{"z":-0}'), '{"z":0}');
  assert.equal(canonicalRaw('{"s":"\\u0061"}'), '{"s":"a"}');
  for (const [a,b] of [['[1,2]','[2,1]'], ['{}','{"x":null}'], ['"x"','"x "'], ['"é"','"é"'], ['"10.00"','"10.0"']]) assert.notEqual(canonicalRaw(a!),canonicalRaw(b!));
  for (const raw of ['{"x":1,"x":2}','{"x":9007199254740992}','{"x":1e400}','{"x":"\\ud800"}']) assert.throws(()=>canonicalRaw(raw));
  for (const value of [{x:undefined},NaN,Infinity,1n,new Date(),[,1],{x:()=>1}]) assert.throws(()=>canonical(value));
});

// Experiment-only restrictive-intersection profile; not a production schema decision.
test('fixture codec depth is root-zero and accepts 64 but refuses 65', () => {
  const nest=(n:number,object=false,leaf:unknown=0)=>{let v=leaf;for(let i=0;i<n;i++)v=object?{x:v}:[v];return v;};
  for(const object of [false,true])for(const leaf of [0,{},[]]){
    const good=nest(64,object,leaf),bad=nest(65,object,leaf);
    assert.equal(canonical(good),canonicalRaw(JSON.stringify(good)));
    assert.throws(()=>canonical(bad));assert.throws(()=>canonicalRaw(JSON.stringify(bad)));
  }
});

test('fixture codec raw UTF-8 limit includes quotes whitespace and escape spelling', () => {
  const cases=[
    ['"'+'x'.repeat(65534)+'"','"'+'x'.repeat(65535)+'"'],
    ['"'+'é'.repeat(32767)+'"','"'+'é'.repeat(32767)+'x"'],
    [' '.repeat(65532)+'null',' '.repeat(65533)+'null'],
    [' '.repeat(2)+'"'+'\\u0061'.repeat(10922)+'"',' '.repeat(3)+'"'+'\\u0061'.repeat(10922)+'"']
  ];
  for(const [good,bad] of cases){assert.equal(Buffer.byteLength(good!),65536);assert.equal(Buffer.byteLength(bad!),65537);assert.equal(canonicalRaw(good!),canonical(JSON.parse(good!)));assert.throws(()=>canonicalRaw(bad!));}
  assert.throws(()=>canonicalRaw('"'+'x'.repeat(70000)+'"'));
  // The value entry has no raw spelling to measure; do not quietly substitute an output-size limit.
  assert.equal(canonical('x'.repeat(70000)).length,70002);
});

test('fixture codec rejects nonenumerable object properties without invoking accessors', () => {
  const hidden=Object.defineProperty({},'x',{value:1,enumerable:false});assert.throws(()=>canonical(hidden));
  let calls=0;
  for(const enumerable of [false,true]){const getter=Object.defineProperty({},'x',{enumerable,get(){calls++;return 1;}});assert.throws(()=>canonical(getter));}
  assert.equal(calls,0);
});

test('fixture codec arrays allow only length and dense enumerable data indices', () => {
  assert.equal(canonical([]),'[]');assert.equal(canonical([1]),'[1]');
  for(const enumerable of [false,true]){const extended=Object.defineProperty([1],'extra',{value:2,enumerable});assert.throws(()=>canonical(extended));}
  assert.throws(()=>canonical(Object.defineProperty([1],'0',{value:1,enumerable:false})));
  let calls=0;const getter=Object.defineProperty([1],'0',{enumerable:true,get(){calls++;return 1;}});assert.throws(()=>canonical(getter));assert.equal(calls,0);
  const symbol=[1];Object.defineProperty(symbol,Symbol('hidden'),{value:1});assert.throws(()=>canonical(symbol));
  assert.throws(()=>canonical(new Array(1)));
});

type Reply = Record<string, any>;
class Client {
  child: ChildProcess;
  next = 0;
  pending = new Map<number,{resolve:(x:any)=>void;reject:(e:Error)=>void}>();
  events: Reply[] = [];
  ready: Promise<Reply>;
  constructor(readonly dir:string, readonly generation:string) {
    this.child=fork(new URL('./fixture-owner.js',import.meta.url),[dir,generation],{stdio:['ignore','inherit','inherit','ipc'],env:{PATH:process.env.PATH,HOME:dir,LANG:'C.UTF-8'}});
    this.ready=new Promise((resolve,reject)=>{
      this.child.on('message',(m:Reply)=>{
        this.events.push(m);
        if(m.event==='ready')resolve(m);
        if(m.event==='fatal')reject(new Error(m.error));
        const p=this.pending.get(m.id); if(p){this.pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result);}
      });
      this.child.on('exit',()=>{reject(new Error('OWNER_EXIT'));for(const p of this.pending.values())p.reject(new Error('OWNER_EXIT'));this.pending.clear();});
    });
  }
  async rpc(method:string,args:Reply={},authority:Reply={fixture:true,generation:this.generation,caller:'fixture-delivery'}):Promise<Reply> {
    const id=++this.next;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child.send({id,method,args:{...args,authority}});});
  }
  async event(name:string,operationId?:string) { for(let i=0;i<150;i++){const e=this.events.find(x=>x.event===name&&(!operationId||x.operationId===operationId));if(e)return e;await new Promise(r=>setTimeout(r,20));}throw Error('MISSING_EVENT:'+name); }
  async kill(){const ended=once(this.child,'exit');this.child.kill('SIGKILL');await ended;}
  async close(){if(this.child.exitCode!==null||this.child.signalCode!==null)return;const ended=once(this.child,'exit');await this.rpc('close');await ended;}
}

test('real Durable owner retains admission through native-commit/pre-linkage crash', {timeout:60000}, async () => {
  const root=process.env.PROOF_OUTPUT;
  assert.ok(root,'PROOF_OUTPUT must name an isolated evidence directory');
  const dir=await mkdtemp(join(root,'owner-'));
  const evidence:Reply={fixtureOnly:true,dir,states:[],limits:['No production supervisor/kernel authentication','No installed ThroughLine provider acceptance','No real model, credentials or external effects']};
  const clients:Client[]=[];
  let c=new Client(dir,'owner-g1');clients.push(c);
  try {
    const ready=await c.ready;const target=ready.target;
    const origin={sender:'fixture-sender',generation:'sender-g1',envelopeHash:'original-fixture-hash',proofRef:'fixture-proof-1'};
    const command={target,operationId:'lost-ack',payload:{text:'harmless crash input'},origin};
    const rival=new Client(dir,'intruder');clients.push(rival);await assert.rejects(rival.ready,/OWNER_EXISTS/);
    await c.rpc('setCrash',{phase:'after-native'});
    const interrupted=c.rpc('ensure',command).catch(e=>({error:e.message}));
    const boundary=await c.event('after-native');evidence.boundary=boundary;
    assert.equal(boundary.operationId,command.operationId);
    assert.equal(boundary.linked,false);
    await c.kill();await interrupted;
    // The test controller has witnessed this exact child's exit. No PID guessing or lock stealing.
    const lock=JSON.parse(await readFile(join(dir,'owner.lock'),'utf8'));
    assert.equal(lock.pid,c.child.pid);assert.equal(lock.generation,'owner-g1');
    await unlink(join(dir,'owner.lock'));
    c=new Client(dir,'owner-g2');clients.push(c);const recovered=await c.ready;
    assert.deepEqual(recovered.target,target);
    const before=await c.rpc('metrics');
    const reserved=await c.rpc('inspect',{target,operationId:command.operationId});
    const absent=await c.rpc('inspect',{target,operationId:'never-reserved'});
    const after=await c.rpc('metrics');
    assert.equal(reserved.kind,'reserved');assert.equal(absent.kind,'authoritative-absent');
    assert.deepEqual(after,before,'inspect must not commit, submit, resume, wait, create docs or call model');
    evidence.inspection={before,after,reserved,absent};
    await assert.rejects(c.rpc('inspect',{target,operationId:command.operationId},{fixture:true,generation:'owner-g1',caller:'fixture-delivery'}),/AUTHORITY_REFUSED/);
    const linked=await c.rpc('reconcile',{target,operationId:command.operationId});
    assert.equal(linked.native.submissionId,boundary.submissionId);
    assert.equal(linked.reservation.originalOwnerGeneration,'owner-g1');assert.deepEqual(linked.reservation.origin,origin);
    await c.rpc('releaseModel');const done=await c.rpc('wait',{target,operationId:command.operationId});
    assert.equal(done.status,'answered');evidence.states.push(reserved,linked,done);
    const duplicate=await c.rpc('ensure',command);assert.equal(duplicate.native.submissionId,done.native.submissionId);
    await assert.rejects(c.rpc('ensure',{...command,payload:{text:'changed'}}),/IDEMPOTENCY_CONFLICT/);
    await assert.rejects(c.rpc('inspect',{...command,target:{...target,storeUuid:'wrong'}}),/TARGET_MISMATCH/);
    await c.rpc('selectViewer',{conversationId:ready.otherTarget.conversationId});
    assert.equal((await c.rpc('inspect',{target,operationId:command.operationId})).native.conversationId,target.conversationId);
    await assert.rejects(c.rpc('inspect',{target:ready.otherTarget,operationId:command.operationId}),/TARGET_MISMATCH/);

    await c.rpc('holdModel');
    const busy=await c.rpc('ensure',{target,operationId:'busy',payload:{text:'hold'},origin});
    assert.equal(busy.status,'placed');
    const queued=await c.rpc('ensure',{target,operationId:'queued',payload:{text:'queued'},origin});
    assert.equal(queued.status,'queued');
    assert.equal((await c.rpc('cancel',{target,operationId:'queued'})).result,'aborted');
    const unanswered=await c.rpc('ensure',{target,operationId:'queued',payload:{text:'queued'},origin});
    assert.equal(unanswered.status,'unanswered');assert.equal(unanswered.reason,'aborted');
    evidence.states.push(busy,queued,unanswered);
    const race=await Promise.allSettled([c.rpc('ensure',{target,operationId:'race',payload:{text:'A'},origin}),c.rpc('ensure',{target,operationId:'race',payload:{text:'B'},origin})]);
    assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.match(String((race.find(x=>x.status==='rejected') as PromiseRejectedResult).reason),/IDEMPOTENCY_CONFLICT/);
    evidence.race=race.map(x=>x.status);
    const doubled=await Promise.all([c.rpc('ensure',{target,operationId:'double',payload:{text:'same'},origin}),c.rpc('ensure',{target,operationId:'double',payload:{text:'same'},origin})]);
    assert.equal(doubled[0]!.native.submissionId,doubled[1]!.native.submissionId);evidence.samePayloadRace=doubled.map(x=>x.native);
    await c.rpc('releaseModel');await c.rpc('wait',{target,operationId:'busy'});await c.rpc('wait',{target,operationId:'race'});
    await c.rpc('wait',{target,operationId:'double'});

    // Actual native unanswered replay: crash with an unlinked submission which was withdrawn while queued.
    await c.rpc('holdModel');await c.rpc('ensure',{target,operationId:'busy-again',payload:{text:'hold again'},origin});
    await c.rpc('setCrash',{phase:'after-native'});
    const unlinked=c.rpc('ensure',{target,operationId:'unanswered-ack',payload:{text:'withdraw before linkage'},origin}).catch(e=>({error:e.message}));
    const queuedBoundary=await c.event('after-native','unanswered-ack');
    assert.equal((await c.rpc('cancelNativeFixture',{target,submissionId:queuedBoundary.submissionId})).result,'aborted');
    await c.kill();await unlinked;
    const secondLock=JSON.parse(await readFile(join(dir,'owner.lock'),'utf8'));assert.equal(secondLock.pid,c.child.pid);assert.equal(secondLock.generation,'owner-g2');await unlink(join(dir,'owner.lock'));
    c=new Client(dir,'owner-g3');clients.push(c);await c.ready;
    assert.equal((await c.rpc('inspect',{target,operationId:'unanswered-ack'})).kind,'reserved');
    const restoredUnanswered=await c.rpc('reconcile',{target,operationId:'unanswered-ack'});
    assert.equal(restoredUnanswered.native.submissionId,queuedBoundary.submissionId);
    assert.equal(restoredUnanswered.status,'unanswered');assert.equal(restoredUnanswered.reason,'aborted');
    evidence.nativeUnansweredReplay={queuedBoundary,restoredUnanswered};
    await c.rpc('releaseModel');await c.rpc('wait',{target,operationId:'busy-again'});
    const audit=await c.rpc('audit');evidence.audit=audit;
    assert.equal(audit.submissions.filter((s:Reply)=>s.requestId==='rail:lost-ack').length,1);
    assert.equal(audit.submissions.filter((s:Reply)=>s.requestId==='rail:race').length,1);
    evidence.metrics=await c.rpc('metrics');evidence.outcome='author-run-pass';
  } finally {
    for(const child of clients)await child.close().catch(()=>undefined);
    evidence.processEvents=clients.map(x=>({generation:x.generation,pid:x.child.pid,events:x.events}));
    evidence.modelAttempts=clients.reduce((n,x)=>n+x.events.filter(e=>e.event==='model-attempt').length,0);
    await writeFile(join(root,'owner-proof.json'),JSON.stringify(evidence,null,2));
  }
});
