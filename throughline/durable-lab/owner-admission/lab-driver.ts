// Disk-state-decided driver: the IPC parent for the accepted fixture owner inside one supervised unit.
// Lab only: fixture model and fixture authority. Not a production launcher, provider or rail.
// No store -> seed path (generation 1). Store present -> recovery path (generation 2 and later).
// Lock rule: owner.lock is removed only by the driver that witnessed the exit of the exact pid it
// records. A lock found at startup refuses the run and is left untouched: from inside a DynamicUser
// unit a lock from an earlier generation cannot be proven dead (shared pid namespace, pid reuse), and
// removing a live lock would put two writers on one SQLite store.
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { canonical, hash } from './contract.js';

type Reply = Record<string, any>;
const OPS = ['answered', 'busy', 'queued', 'unanswered-ack', 'lost-ack'] as const;
const LOCK_READ_LIMIT = 4096;

class Owner {
  readonly child: ChildProcess;
  readonly events: Reply[] = [];
  readonly ready: Promise<Reply>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private next = 0;
  private readonly pending = new Map<number, { resolve: (x: Reply) => void; reject: (e: Error) => void }>();
  private waiters: Array<() => void> = [];
  constructor(readonly dir: string, readonly generation: string, home: string) {
    this.child = fork(new URL('./fixture-owner.js', import.meta.url), [dir, generation], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C' } });
    this.exited = new Promise(resolve => this.child.once('exit', (code, signal) => resolve({ code, signal })));
    this.ready = new Promise((resolve, reject) => {
      this.child.on('message', (m: Reply) => {
        this.events.push(m);
        if (m.event === 'ready') resolve(m);
        if (m.event === 'fatal') reject(new Error(m.error));
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result); }
        this.wake();
      });
      this.child.once('exit', () => {
        reject(new Error('OWNER_EXIT'));
        for (const p of this.pending.values()) p.reject(new Error('OWNER_EXIT'));
        this.pending.clear(); this.wake();
      });
    });
    this.ready.catch(() => undefined);
  }
  private wake() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  get alive() { return this.child.exitCode === null && this.child.signalCode === null; }
  rpc(method: string, args: Reply = {}, authority: Reply = { fixture: true, generation: this.generation, caller: 'fixture-delivery' }): Promise<Reply> {
    const id = ++this.next;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.child.send({ id, method, args: { ...args, authority } }); });
  }
  async event(name: string, operationId: string): Promise<Reply> {
    const deadline = Date.now() + 15000;
    for (;;) {
      const e = this.events.find(x => x.event === name && x.operationId === operationId);
      if (e) return e;
      if (!this.alive) throw Error('OWNER_EXIT');
      if (Date.now() > deadline) throw Error('MISSING_EVENT:' + name);
      await new Promise<void>(r => { this.waiters.push(r); setTimeout(r, 200).unref(); });
    }
  }
  async kill() { if (this.alive) this.child.kill('SIGKILL'); return this.exited; }
  async close() { if (!this.alive) return this.exited; await this.rpc('close'); return this.exited; }
}

async function exists(path: string) {
  try { await stat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
async function writeJson(path: string, value: unknown) {
  const pending = path + '.pending';
  await writeFile(pending, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(pending, path);
}
async function procStatus(pid: number | undefined) {
  if (process.platform !== 'linux' || pid === undefined) return null;
  try {
    const text = await readFile(`/proc/${pid}/status`, 'utf8');
    const field = (k: string) => /^\s*(\S+)/.exec(text.split('\n').find(l => l.startsWith(k + ':'))?.slice(k.length + 1) ?? '')?.[1] ?? null;
    return { pid, vmHWMkB: Number(field('VmHWM')), threads: Number(field('Threads')) };
  } catch { return null; }
}
function must(ok: boolean, what: string, detail?: unknown): asserts ok {
  if (!ok) throw Object.assign(Error('CHECK_FAILED:' + what), { detail });
}

function stateRoot(argv: string[]): string {
  const given = argv.length === 1 && argv[0] === '--state-from-home' ? process.env.HOME : argv.length === 2 && argv[0] === '--state' ? argv[1] : undefined;
  if (given === undefined) throw Error('USAGE: lab-driver.js --state-from-home | --state <absolute directory>');
  if (!isAbsolute(given) || normalize(given) !== given) throw Error('STATE_ROOT_NOT_ABSOLUTE');
  return given;
}

async function main() {
  const startedAt = new Date().toISOString();
  const given = stateRoot(process.argv.slice(2));
  // Under DynamicUser the StateDirectory path is a systemd symlink into /var/lib/private; use it as given.
  const root = given, rootReal = await realpath(given).catch(() => null);
  const storeDir = join(root, 'owner-lab'), receiptsDir = join(root, 'lab-receipts'), lockPath = join(storeDir, 'owner.lock');
  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  await mkdir(receiptsDir, { recursive: true, mode: 0o700 });
  const prior = (await readdir(receiptsDir)).filter(n => /^run-\d+-[a-z]+\.json$/.test(n)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
  const n = prior.length + 1;
  const supervisor = {
    agentId: process.env.THROUGHLINE_AGENT_ID ?? null, taskId: process.env.THROUGHLINE_TASK_ID ?? null,
    runId: process.env.THROUGHLINE_RUN_ID ?? null, generation: process.env.THROUGHLINE_GENERATION ?? null,
  };
  const base: Reply = { schema: 'pi-durable-owner-lab-receipt.v1', run: n, startedAt, stateRoot: root, stateRootReal: rootReal, storeDir, supervisor, pid: process.pid, node: process.version, fixtureOnly: true };
  const finish = async (mode: string, body: Reply) => {
    const path = join(receiptsDir, `run-${n}-${mode}.json`);
    const receipt = { ...base, mode, ...body, finishedAt: new Date().toISOString(), driverPeak: { maxRSSkB: process.resourceUsage().maxRSS, status: await procStatus(process.pid) } };
    await writeJson(path, receipt);
    process.stdout.write(`LAB_RECEIPT ${path} ${body.outcome}\n`);
    // Under DynamicUser the file sits in root-only /var/lib/private; the journal copy is the readable one.
    process.stdout.write(`LAB_RECEIPT_JSON ${JSON.stringify(receipt)}\n`);
    return path;
  };

  if (await exists(lockPath)) {
    const raw = (await readFile(lockPath)).subarray(0, LOCK_READ_LIMIT).toString('utf8');
    await finish('refused', { outcome: 'refused', reason: 'OWNER_LOCK_PRESENT', lockPath, lockContents: raw, rule: 'a lock this driver did not witness is never removed; the store was not opened' });
    process.exit(3);
  }
  const mode = (await exists(join(storeDir, 'private.sqlite'))) ? 'recover' : 'seed';
  let seedReceipt: Reply | undefined;
  if (mode === 'recover') {
    const seedName = prior.find(x => x.endsWith('-seed.json'));
    seedReceipt = seedName ? JSON.parse(await readFile(join(receiptsDir, seedName), 'utf8')) : undefined;
    if (seedReceipt?.outcome !== 'pass') {
      await finish('refused', { outcome: 'refused', reason: 'GENERATION_1_INCOMPLETE', detail: 'store present without a passing seed receipt; the store was not opened' });
      process.exit(3);
    }
  }

  const owners = new Set<Owner>();
  const locks: Reply[] = [], peaks: Reply[] = [];
  const body: Reply = { outcome: 'running', locks, peaks };
  let idle = false, stopping = false;
  const start = (letter: string) => { const o = new Owner(storeDir, `run-${n}-${letter}`, root); owners.add(o); return o; };
  const witness = async (o: Owner) => {
    const exit = await o.exited; owners.delete(o);
    let lock: Reply;
    try { lock = JSON.parse(await readFile(lockPath, 'utf8')); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { locks.push({ generation: o.generation, pid: o.child.pid, exit, lock: 'absent-after-exit' }); return; }
      throw e;
    }
    must(lock.pid === o.child.pid && lock.generation === o.generation, 'OWNER_LOCK_NOT_WITNESSED', lock);
    await unlink(lockPath);
    locks.push({ generation: o.generation, pid: o.child.pid, exit, lock: 'released-after-witnessed-exit' });
  };
  const onStop = (signal: string) => {
    if (idle) process.exit(0);
    if (stopping) return; stopping = true;
    void (async () => {
      for (const o of [...owners]) { await o.kill(); await witness(o).catch(e => locks.push({ generation: o.generation, error: String(e) })); }
      await finish(mode, { ...body, outcome: 'interrupted-by-stop', signal });
      process.exit(143);
    })();
  };
  process.on('SIGTERM', () => onStop('SIGTERM'));
  process.on('SIGINT', () => onStop('SIGINT'));

  try {
    if (mode === 'seed') await seed(); else await recover(seedReceipt!);
  } catch (e) {
    if (stopping) return;
    for (const o of [...owners]) { await o.kill(); await witness(o).catch(err => locks.push({ generation: o.generation, error: String(err) })); }
    body.outcome = 'error'; body.error = e instanceof Error ? e.message : String(e); body.errorDetail = (e as Reply)?.detail ?? null;
    await finish(mode, body);
    process.exit(1);
  }
  if (stopping) return;
  await finish(mode, body);
  if (body.outcome !== 'pass') process.exit(1);
  // Stay up, holding no lock and no open store, so a supervisor stop meets a live, idle generation.
  idle = true;
  setInterval(() => undefined, 1 << 30);

  async function seed() {
    const a = start('a');
    const ready = await a.ready;
    const target = ready.target;
    body.storeUuid = target.storeUuid; body.target = target; body.otherTarget = ready.otherTarget;
    const origin = { sender: 'lab-driver', generation: supervisor.generation ?? 'unsupervised', envelopeHash: hash('lab-payload:' + target.storeUuid), proofRef: 'fork1-lab-profile-payload' };
    const commands: Reply = {};
    const cmd = (operationId: string, text: string) => (commands[operationId] = { target, operationId, payload: { text }, origin });
    await a.rpc('releaseModel');
    await a.rpc('ensure', cmd('answered', 'harmless answered input'));
    const answered = await a.rpc('wait', { target, operationId: 'answered' });
    must(answered.status === 'answered', 'SEED_ANSWERED', answered);
    await a.rpc('holdModel');
    const busy = await a.rpc('ensure', cmd('busy', 'hold the model'));
    must(busy.status === 'placed', 'SEED_BUSY_PLACED', busy);
    const queued = await a.rpc('ensure', cmd('queued', 'withdrawn while queued'));
    must(queued.status === 'queued', 'SEED_QUEUED', queued);
    must((await a.rpc('cancel', { target, operationId: 'queued' })).result === 'aborted', 'SEED_CANCEL_ABORTED');
    const queuedState = await a.rpc('inspect', { target, operationId: 'queued' });
    must(queuedState.status === 'unanswered' && queuedState.reason === 'aborted', 'SEED_QUEUED_UNANSWERED', queuedState);
    // Interruption 1: native submission committed, withdrawn while queued, owner killed before linkage.
    await a.rpc('setCrash', { phase: 'after-native' });
    const pendingA = a.rpc('ensure', cmd('unanswered-ack', 'withdrawn before linkage')).catch(e => ({ error: e.message }));
    const ua = await a.event('after-native', 'unanswered-ack');
    must(ua.linked === false, 'SEED_UA_UNLINKED', ua);
    must((await a.rpc('cancelNativeFixture', { target, submissionId: ua.submissionId })).result === 'aborted', 'SEED_UA_ABORTED');
    peaks.push({ generation: a.generation, status: await procStatus(a.child.pid) });
    await a.kill(); await pendingA; await witness(a);
    // Interruption 2: native submission committed behind the held busy turn, owner killed before linkage.
    const b = start('b');
    const readyB = await b.ready;
    must(canonical(readyB.target) === canonical(target), 'SEED_REOPEN_SAME_TARGET', readyB.target);
    await b.rpc('setCrash', { phase: 'after-native' });
    const pendingB = b.rpc('ensure', cmd('lost-ack', 'interrupted after native commit')).catch(e => ({ error: e.message }));
    const la = await b.event('after-native', 'lost-ack');
    must(la.linked === false, 'SEED_LA_UNLINKED', la);
    peaks.push({ generation: b.generation, status: await procStatus(b.child.pid) });
    await b.kill(); await pendingB; await witness(b);
    must(!(await exists(lockPath)), 'SEED_LOCK_RELEASED');
    body.commands = commands;
    body.ops = {
      answered: { submissionId: answered.native.submissionId, status: answered.status },
      busy: { submissionId: busy.native.submissionId, status: busy.status, note: 'model held; interrupted in flight by the owner kills' },
      queued: { submissionId: queuedState.native.submissionId, status: queuedState.status, reason: queuedState.reason, linked: true },
      'unanswered-ack': { submissionId: ua.submissionId, linked: false, nativeAction: 'aborted while queued before linkage' },
      'lost-ack': { submissionId: la.submissionId, linked: false, nativeAction: 'committed, owner killed before linkage' },
    };
    body.ownerGenerations = [a.generation, b.generation];
    body.outcome = 'pass';
  }

  async function recover(seedR: Reply) {
    const o = start('r');
    const ready = await o.ready;
    const target = ready.target;
    const s = seedR.ops;
    const checks: Record<string, boolean> = {};
    checks.sameStoreUuid = target.storeUuid === seedR.storeUuid;
    checks.sameTarget = canonical(target) === canonical(seedR.target);
    const before = await o.rpc('metrics');
    const inspected: Reply = {};
    for (const op of OPS) inspected[op] = await o.rpc('inspect', { target, operationId: op });
    inspected['never-reserved'] = await o.rpc('inspect', { target, operationId: 'never-reserved' });
    const after = await o.rpc('metrics');
    checks.inspectCountersUnchanged = canonical(before) === canonical(after);
    const linkedAs = (r: Reply, op: string) => r.kind === 'admitted' && r.native.submissionId === s[op].submissionId && r.native.storeUuid === seedR.storeUuid;
    checks.answeredStaysAnswered = linkedAs(inspected.answered, 'answered') && inspected.answered.status === 'answered';
    checks.queuedStaysUnanswered = linkedAs(inspected.queued, 'queued') && inspected.queued.status === 'unanswered' && inspected.queued.reason === 'aborted';
    checks.busySameSubmission = linkedAs(inspected.busy, 'busy');
    const unlinked = ['unanswered-ack', 'lost-ack'];
    const firstRecovery = unlinked.every(op => inspected[op].kind === 'reserved');
    checks.unlinkedTruthful = unlinked.every(op => inspected[op].kind === 'reserved' ? inspected[op].admission === 'unknown-until-reconciled' : linkedAs(inspected[op], op));
    checks.absentIsAbsent = inspected['never-reserved'].kind === 'authoritative-absent';
    const priorAuthority = { fixture: true, generation: seedR.ownerGenerations[0], caller: 'fixture-delivery' };
    checks.priorGenerationAuthorityRefused = await o.rpc('inspect', { target, operationId: 'answered' }, priorAuthority).then(() => false, e => /AUTHORITY_REFUSED/.test(e.message));
    const reconciled: Reply = {};
    for (const op of unlinked) reconciled[op] = await o.rpc('reconcile', { target, operationId: op });
    checks.unansweredAckSameIdStaysUnanswered = linkedAs(reconciled['unanswered-ack'], 'unanswered-ack') && reconciled['unanswered-ack'].status === 'unanswered' && reconciled['unanswered-ack'].reason === 'aborted';
    checks.lostAckSameId = linkedAs(reconciled['lost-ack'], 'lost-ack');
    checks.originalOwnerPreserved = unlinked.every(op => reconciled[op].reservation.originalOwnerGeneration === seedR.ownerGenerations[op === 'unanswered-ack' ? 0 : 1]);
    await o.rpc('releaseModel');
    const waited: Reply = { busy: await o.rpc('wait', { target, operationId: 'busy' }), 'lost-ack': await o.rpc('wait', { target, operationId: 'lost-ack' }) };
    checks.busyAnswered = linkedAs(waited.busy, 'busy') && waited.busy.status === 'answered';
    checks.lostAckAnswered = linkedAs(waited['lost-ack'], 'lost-ack') && waited['lost-ack'].status === 'answered';
    const duplicate = await o.rpc('ensure', seedR.commands.answered);
    checks.duplicateAdmissionSameId = linkedAs(duplicate, 'answered') && duplicate.status === 'answered';
    const final: Reply = {};
    for (const op of OPS) final[op] = await o.rpc('inspect', { target, operationId: op });
    checks.finalAnsweredUnchanged = final.answered.status === 'answered' && final.queued.status === 'unanswered' && final['unanswered-ack'].status === 'unanswered';
    const audit = await o.rpc('audit');
    checks.oneNativeSubmissionPerOperation = OPS.every(op => audit.submissions.filter((x: Reply) => x.requestId === 'rail:' + op).length === 1) && audit.logicalSubmissionIds.length === OPS.length;
    const metrics = await o.rpc('metrics');
    peaks.push({ generation: o.generation, status: await procStatus(o.child.pid) });
    await o.close(); await witness(o);
    checks.lockReleased = !(await exists(lockPath));
    Object.assign(body, { storeUuid: target.storeUuid, target, firstRecovery, seedReceiptRun: seedR.run, inspection: { before, after, inspected }, reconciled, waited, duplicate, final, audit: { logicalSubmissionIds: audit.logicalSubmissionIds, requestIds: audit.submissions.map((x: Reply) => ({ requestId: x.requestId, id: x.id })) }, metrics, checks });
    body.outcome = Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  }
}

main().catch(e => { process.stderr.write(`LAB_DRIVER_FATAL ${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); });
