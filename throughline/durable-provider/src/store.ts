import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai/models';
import { createRegistry, defineDoc, Harness, type Conversation, type ModelRef, type Registry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { ConversationTarget } from './record.ts';

export interface StoreManifest {
  schema: 'throughline.durable-store.v1';
  stateDirectory: string;
  storeUuid: string;
  publicAgentId: string;
  agentStateId: string;
  appThreadId: string;
  cwd: string;
}
export interface OwnerProof { pid: number; nonce: string; storeUuid: string }
type StoredBinding = {
  identity: Pick<StoreManifest, 'storeUuid'|'publicAgentId'|'agentStateId'|'appThreadId'> | null;
  conversationId: number | null;
};
const Binding = defineDoc<StoredBinding>({
  kind:'throughline.durable-binding', version:1, scope:'session',
  checkpointWhen:()=>true, initial:()=>({identity:null,conversationId:null}),
});
function identity(manifest: StoreManifest) {
  return {storeUuid:manifest.storeUuid,publicAgentId:manifest.publicAgentId,agentStateId:manifest.agentStateId,appThreadId:manifest.appThreadId};
}
function assertManifest(manifest: StoreManifest) {
  if(typeof manifest!=='object'||manifest===null||manifest.schema!=='throughline.durable-store.v1'||typeof manifest.stateDirectory!=='string'||typeof manifest.cwd!=='string'||!isAbsolute(manifest.stateDirectory)||!isAbsolute(manifest.cwd))throw Error('INVALID_STORE_MANIFEST');
  for(const value of Object.values(identity(manifest)))if(typeof value!=='string'||!/^[A-Za-z0-9:._-]{1,256}$/.test(value))throw Error('INVALID_STORE_IDENTITY');
}
function isErrorCode(error:unknown,code:string) {return typeof error==='object'&&error!==null&&'code'in error&&error.code===code;}
async function assertPrivateDirectory(directory:string) {
  const absolute=resolve(directory);const root=parse(absolute).root;
  let current=root;
  for(const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current=join(current,segment);
    try {await lstat(current);}
    catch(error) {
      if(!isErrorCode(error,'ENOENT'))throw error;
      try {await mkdir(current,{mode:0o700});}
      catch(createError){if(!isErrorCode(createError,'EEXIST'))throw createError;}
    }
    const component=await lstat(current);
    if(component.isSymbolicLink()||!component.isDirectory())throw Error('PRIVATE_STORE_DIRECTORY_REQUIRED');
  }
  const stat=await lstat(absolute);
  if(stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||(await realpath(absolute))!==absolute)throw Error('PRIVATE_STORE_DIRECTORY_REQUIRED');
}
function lockPath(manifest:StoreManifest) {return join(manifest.stateDirectory,'owner.lock');}
async function readOwner(manifest:StoreManifest):Promise<OwnerProof> {
  const stat=await lstat(lockPath(manifest));
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('INVALID_OWNER_PROOF');
  const value:unknown=JSON.parse(await readFile(lockPath(manifest),'utf8'));
  if(typeof value!=='object'||value===null||!('pid'in value)||!Number.isSafeInteger(value.pid)||Number(value.pid)<=0||!('nonce'in value)||typeof value.nonce!=='string'||!('storeUuid'in value)||typeof value.storeUuid!=='string')throw Error('INVALID_OWNER_PROOF');
  return {pid:Number(value.pid),nonce:value.nonce,storeUuid:value.storeUuid};
}

// The launcher serializes replacement and supplies proof from its captured
// process and launch nonce. A child never guesses stale ownership or kills it.
export async function reclaimDeadOwner(manifest:StoreManifest,expected:OwnerProof) {
  assertManifest(manifest);
  await assertPrivateDirectory(manifest.stateDirectory);
  const owner=await readOwner(manifest);
  if(owner.pid!==expected.pid||owner.nonce!==expected.nonce||owner.storeUuid!==expected.storeUuid||owner.storeUuid!==manifest.storeUuid)throw Error('OWNER_PROOF_MISMATCH');
  try {process.kill(owner.pid,0);throw Error('OWNER_STILL_ALIVE');}
  catch(error){if(!isErrorCode(error,'ESRCH'))throw error;}
  const rechecked=await readOwner(manifest);
  if(JSON.stringify(rechecked)!==JSON.stringify(owner))throw Error('OWNER_PROOF_CHANGED');
  await unlink(lockPath(manifest));
}

export class OwnerCleanupRequired extends AggregateError {
  readonly proof:Readonly<OwnerProof>;
  readonly retryCleanup:()=>Promise<void>;
  constructor(errors:unknown[],proof:OwnerProof,retryCleanup:()=>Promise<void>) {
    super(errors,'STORE_CLEANUP_REQUIRED: ownership remains held until shutdown is proved');
    this.proof=Object.freeze({...proof});this.retryCleanup=retryCleanup;
  }
}
export interface OpenStoreOptions {
  models:Models;
  model:ModelRef;
  // Created and retained by the launcher before spawning this worker. Not an auth secret.
  ownerNonce:string;
  registry?:Registry|undefined;
  instructions?:string;
  thinkingLevel?:'off'|'minimal'|'low'|'medium'|'high'|'xhigh';
}
export async function openAgentStore(manifest:StoreManifest,options:OpenStoreOptions,context:Context) {
  assertManifest(manifest);
  if(typeof options.ownerNonce!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(options.ownerNonce))throw Error('LAUNCHER_OWNER_NONCE_REQUIRED');
  await assertPrivateDirectory(manifest.stateDirectory);
  const proof:OwnerProof={pid:process.pid,nonce:options.ownerNonce,storeUuid:manifest.storeUuid};
  const pending=join(manifest.stateDirectory,`.owner-${proof.nonce}.pending`);
  const file=await open(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  let published=false;
  try {
    try {await file.writeFile(JSON.stringify(proof));await file.sync();}
    finally {await file.close();}
    // Hard-link publication is atomic and no-replace: no partial owner.lock is
    // visible, and a competing live worker's lock can never be overwritten.
    try {await link(pending,lockPath(manifest));published=true;}
    catch(error){if(isErrorCode(error,'EEXIST'))throw Error('STORE_ALREADY_OWNED');throw error;}
  } finally {await unlink(pending);}
  if(!published)throw Error('OWNER_PUBLICATION_FAILED');
  let harness:Harness|undefined;
  let storage:Awaited<ReturnType<typeof openNodeSqliteStorage>>|undefined;
  let released=false;
  async function release() {
    if(released)return;
    const actual=await readOwner(manifest);
    if(JSON.stringify(actual)!==JSON.stringify(proof))throw Error('OWNER_PROOF_CHANGED');
    await unlink(lockPath(manifest));released=true;
  }
  async function shutdown() {
    if(harness)await harness.close(BACKGROUND_CONTEXT);
    else if(storage)await storage.close(BACKGROUND_CONTEXT);
    await release();
  }
  try {
    const database=join(manifest.stateDirectory,'execution.sqlite');
    try {const stat=await lstat(database);if(stat.isSymbolicLink()||!stat.isFile()||stat.uid!==process.getuid?.())throw Error('INVALID_STORE_FILE');}
    catch(error){if(!isErrorCode(error,'ENOENT'))throw error;}
    storage=await openNodeSqliteStorage(database);
    harness=await Harness.open(storage,{models:options.models,registry:options.registry??createRegistry(),settings:{compaction:{enabled:false}}},context);
    await chmod(database,0o600);
    const expected=identity(manifest);
    await harness.commit(async tx=>{
      const stored=await tx.doc(Binding);
      if(stored.identity!==null&&JSON.stringify(stored.identity)!==JSON.stringify(expected))throw Error('STORE_BINDING_MISMATCH');
      if(stored.identity===null)stored.identity=expected;
    },context);
    const binding=await harness.snapshot(Binding,context);
    let conversation:Conversation;
    if(binding?.conversationId!=null) {
      const found=await harness.conversation(binding.conversationId as Conversation['id'],context);
      if(found===undefined||found===null)throw Error('BOUND_CONVERSATION_MISSING');
      conversation=found;
    } else {
      conversation=await harness.root(context,{agent:{model:options.model,cwd:manifest.cwd,...(options.instructions===undefined?{}:{instructions:options.instructions}),...(options.thinkingLevel===undefined?{}:{thinkingLevel:options.thinkingLevel})}});
      await harness.commit(async tx=>{
        const stored=await tx.doc(Binding);
        if(stored.conversationId!==null&&stored.conversationId!==conversation.id)throw Error('CONVERSATION_BINDING_CHANGED');
        stored.conversationId=conversation.id;
      },context);
    }
    const target:Readonly<ConversationTarget>=Object.freeze({...expected,conversationId:conversation.id});
    let closing:Promise<void>|undefined;
    return Object.freeze({
      harness,conversation,proof:Object.freeze({...proof}),target,
      close(_context:Context):Promise<void> {
        if(!closing)closing=shutdown().catch(error=>{closing=undefined;throw error;});
        return closing;
      },
    });
  } catch(error) {
    try {await shutdown();}
    catch(cleanupError){throw new OwnerCleanupRequired([error,cleanupError],proof,shutdown);}
    throw error;
  }
}
export type OpenAgentStore=Awaited<ReturnType<typeof openAgentStore>>;
