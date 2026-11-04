import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Reply = Record<string, any>;
const driver = fileURLToPath(new URL('./lab-driver.js', import.meta.url));

// Same environment shape the supervisor's drop-in passes: env -i, PATH, HOME, LANG, THROUGHLINE_*.
async function run(home: string, generation: string) {
  const child = spawn(process.execPath, [driver, '--state-from-home'], {
    env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C', THROUGHLINE_AGENT_ID: 'lab-agent', THROUGHLINE_TASK_ID: 'lab-task', THROUGHLINE_RUN_ID: 'lab-run', THROUGHLINE_GENERATION: generation },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  let out = '';
  // Wait for the journal copy too, so a stop never races the second line.
  const done = () => /^LAB_RECEIPT_JSON .*\n/m.test(out);
  await new Promise<void>(resolve => {
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); if (done()) resolve(); });
    void exited.then(() => resolve());
  });
  const line = /^LAB_RECEIPT (\S+) (\S+)$/m.exec(out);
  assert.ok(line, 'driver printed no receipt line: ' + out);
  const [, path, outcome] = line;
  // Supervisor stop: SIGTERM to an idle generation must exit 0.
  if (outcome === 'pass') child.kill('SIGTERM');
  const code = await exited;
  const journalLine = /^LAB_RECEIPT_JSON (.*)$/m.exec(out)?.[1] ?? null;
  return { code, outcome, receipt: JSON.parse(await readFile(path!, 'utf8')) as Reply, journalLine };
}

// The receipt file is root-only under DynamicUser; the journal line must carry the same receipt.
test('every receipt is also printed as one LAB_RECEIPT_JSON line equal to the file', { timeout: 120000 }, async () => {
  const root = process.env.PROOF_OUTPUT ?? await mkdtemp(join(tmpdir(), 'lab-driver-'));
  const home = await mkdtemp(join(root, 'agent-home-journal-'));
  const lockHome = await mkdtemp(join(root, 'agent-home-journal-lock-'));
  await mkdir(join(lockHome, 'owner-lab'), { recursive: true });
  await writeFile(join(lockHome, 'owner-lab', 'owner.lock'), JSON.stringify({ pid: 999999, generation: 'run-1-a', fixture: true }));
  const runs = [await run(home, '1'.repeat(32) + ':1'), await run(home, '2'.repeat(32) + ':2'), await run(lockHome, '3'.repeat(32) + ':1')];
  assert.deepEqual(runs.map(r => [r.receipt.mode, r.outcome]), [['seed', 'pass'], ['recover', 'pass'], ['refused', 'refused']]);
  for (const r of runs) {
    assert.ok(r.journalLine, 'missing LAB_RECEIPT_JSON line for ' + r.receipt.mode);
    assert.ok(Buffer.byteLength(r.journalLine) < 48 * 1024, 'line would be split at journald LineMax=48K');
    assert.deepEqual(JSON.parse(r.journalLine), r.receipt);
  }
  const [seed, recover] = runs.map(r => JSON.parse(r.journalLine!));
  assert.equal(recover.storeUuid, seed.storeUuid); assert.equal(recover.firstRecovery, true);
  for (const op of ['answered', 'busy', 'queued', 'unanswered-ack', 'lost-ack']) assert.equal(recover.final[op].native.submissionId, seed.ops[op].submissionId, op);
  assert.deepEqual(recover.inspection.before, recover.inspection.after);
});

test('one state directory: seed, then two recoveries keep the same submission ids and truthful states', { timeout: 120000 }, async () => {
  const root = process.env.PROOF_OUTPUT ?? await mkdtemp(join(tmpdir(), 'lab-driver-'));
  const home = await mkdtemp(join(root, 'agent-home-'));
  const g1 = await run(home, 'a'.repeat(32) + ':1');
  assert.equal(g1.code, 0); assert.equal(g1.receipt.mode, 'seed'); assert.equal(g1.outcome, 'pass');
  const ids = Object.fromEntries(Object.entries(g1.receipt.ops as Reply).map(([k, v]) => [k, v.submissionId]));
  for (const [n, generation, first] of [[2, 'b'.repeat(32) + ':2', true], [3, 'c'.repeat(32) + ':3', false]] as const) {
    const g = await run(home, generation);
    assert.equal(g.code, 0); assert.equal(g.receipt.mode, 'recover'); assert.equal(g.receipt.run, n);
    assert.equal(g.receipt.storeUuid, g1.receipt.storeUuid); assert.equal(g.receipt.firstRecovery, first);
    for (const [name, ok] of Object.entries(g.receipt.checks as Record<string, boolean>)) assert.equal(ok, true, name);
    for (const op of Object.keys(ids)) assert.equal(g.receipt.final[op].native.submissionId, ids[op], op);
  }
  await writeFile(join(root, 'lab-driver-test-ids.json'), JSON.stringify({ home, storeUuid: g1.receipt.storeUuid, ids }, null, 2));
});

test('a lock the driver did not witness refuses the run and stays in place', { timeout: 60000 }, async () => {
  const root = process.env.PROOF_OUTPUT ?? await mkdtemp(join(tmpdir(), 'lab-driver-'));
  const home = await mkdtemp(join(root, 'agent-home-lock-'));
  await mkdir(join(home, 'owner-lab'), { recursive: true });
  const stale = JSON.stringify({ pid: 999999, generation: 'run-1-a', fixture: true });
  await writeFile(join(home, 'owner-lab', 'owner.lock'), stale);
  const g = await run(home, 'd'.repeat(32) + ':1');
  assert.equal(g.code, 3); assert.equal(g.outcome, 'refused'); assert.equal(g.receipt.reason, 'OWNER_LOCK_PRESENT');
  assert.equal(await readFile(join(home, 'owner-lab', 'owner.lock'), 'utf8'), stale);
});

// DynamicUser exposes StateDirectory as a symlink into /var/lib/private; the driver must work through it.
test('a symlinked state root, as DynamicUser presents it, seeds and recovers', { timeout: 120000 }, async () => {
  const root = process.env.PROOF_OUTPUT ?? await mkdtemp(join(tmpdir(), 'lab-driver-'));
  const real = await mkdtemp(join(root, 'private-'));
  const home = join(root, 'agent-home-symlinked');
  await symlink(real, home);
  const g1 = await run(home, 'e'.repeat(32) + ':1');
  assert.equal(g1.code, 0); assert.equal(g1.outcome, 'pass'); assert.equal(g1.receipt.stateRootReal, real);
  const g2 = await run(home, 'f'.repeat(32) + ':2');
  assert.equal(g2.code, 0); assert.equal(g2.outcome, 'pass'); assert.equal(g2.receipt.storeUuid, g1.receipt.storeUuid);
});
