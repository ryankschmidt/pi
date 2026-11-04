import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openAgentStore, reclaimDeadOwner, type StoreManifest } from '../src/store.ts';

async function fixture() {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'throughline-durable-owner-')));
  const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);const m=faux.getModel();
  const manifest:StoreManifest={schema:'throughline.durable-store.v1',stateDirectory:join(directory,'agent'),storeUuid:'store-one',publicAgentId:'agent-one',agentStateId:'agent-state-one',appThreadId:'thread-one',cwd:directory};
  const options={models,model:{provider:m.provider,modelId:m.id},ownerNonce:randomUUID()};
  return {directory,faux,manifest,options};
}
test('an exclusive owner holds a stable conversation and rejects a second owner',async()=>{
  const f=await fixture();
  try {
    const owner=await openAgentStore(f.manifest,f.options,context);
    try {
      await assert.rejects(openAgentStore(f.manifest,{...f.options,ownerNonce:randomUUID()},context),/STORE_ALREADY_OWNED/);
      assert.ok(Object.isFrozen(owner.target));assert.equal(owner.target.appThreadId,f.manifest.appThreadId);
      f.faux.setResponses([fauxAssistantMessage('persisted answer')]);
      const submission=await owner.conversation.submit({type:'input',content:'useful input',requestId:'operation-one'},context);
      assert.equal((await submission.wait(context)).status,'done');
      const before=owner.conversation.id;await owner.close(context);
      const reopened=await openAgentStore(f.manifest,{...f.options,ownerNonce:randomUUID()},context);
      try {
        assert.equal(reopened.conversation.id,before);
        const same=await reopened.conversation.submit({type:'input',content:'useful input',requestId:'operation-one'},context);
        assert.equal(same.id,submission.id);assert.equal((await same.status(context)).status,'done');
        const entries=await reopened.conversation.entries({order:'ascending'},50,undefined,context);
        assert.ok(entries.items.some(e=>e.kind==='pi.assistant'));
      } finally {await reopened.close(context);}
    } finally {await owner.close(context);}
  } finally {await rm(f.directory,{recursive:true,force:true});}
});
test('a different thread or agent cannot borrow an existing private store',async()=>{
  const f=await fixture();
  try {
    const owner=await openAgentStore(f.manifest,f.options,context);await owner.close(context);
    for(const changed of [{appThreadId:'other-thread'},{publicAgentId:'other-agent'},{storeUuid:'other-store'}])await assert.rejects(openAgentStore({...f.manifest,...changed},{...f.options,ownerNonce:randomUUID()},context),/STORE_BINDING_MISMATCH/);
    const owner2=await openAgentStore(f.manifest,{...f.options,ownerNonce:randomUUID()},context);await owner2.close(context);
  } finally {await rm(f.directory,{recursive:true,force:true});}
});
test('malformed identity or missing launcher proof is refused before creating a store',async()=>{
  const f=await fixture();
  try {
    await assert.rejects(openAgentStore({...f.manifest,storeUuid:123} as unknown as StoreManifest,f.options,context),/INVALID_STORE_IDENTITY/);
    await assert.rejects(openAgentStore(f.manifest,{...f.options,ownerNonce:''},context),/LAUNCHER_OWNER_NONCE_REQUIRED/);
    await assert.rejects(lstat(f.manifest.stateDirectory),{code:'ENOENT'});
  } finally {await rm(f.directory,{recursive:true,force:true});}
});
test('a symlinked state directory or ancestor is refused without writing through it',async()=>{
  const f=await fixture();
  try {
    const real=join(f.directory,'real');await mkdir(real,{mode:0o700});const alias=join(f.directory,'alias');await symlink(real,alias);
    for(const stateDirectory of [alias,join(alias,'nested')])await assert.rejects(openAgentStore({...f.manifest,stateDirectory},f.options,context),/PRIVATE_STORE_DIRECTORY_REQUIRED/);
    await assert.rejects(lstat(join(real,'nested')),{code:'ENOENT'});
  } finally {await rm(f.directory,{recursive:true,force:true});}
});
test('only a captured dead owner can be reclaimed; a live or ambiguous owner is refused',async()=>{
  const f=await fixture();
  try {
    await mkdir(f.manifest.stateDirectory,{mode:0o700});
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore']});assert.ok(child.pid);
    const lock={pid:child.pid,nonce:'captured-child-token',storeUuid:f.manifest.storeUuid};
    await writeFile(join(f.manifest.stateDirectory,'owner.lock'),JSON.stringify(lock),{mode:0o600});
    try {
      await assert.rejects(reclaimDeadOwner(f.manifest,lock),/OWNER_STILL_ALIVE/);
      const exited=once(child,'exit');child.kill('SIGKILL');await exited;
      await assert.rejects(reclaimDeadOwner(f.manifest,{...lock,nonce:'different-token'}),/OWNER_PROOF_MISMATCH/);
      await reclaimDeadOwner(f.manifest,lock);await assert.rejects(readFile(join(f.manifest.stateDirectory,'owner.lock')),{code:'ENOENT'});
    } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  } finally {await rm(f.directory,{recursive:true,force:true});}
});
