// Probe for the Oct 22, 2026 rail study. Faux model only; no key, no spend. Writes only under data/.
//   node probe-rail.ts owner   -> opens data/probe.sqlite and holds it open for 8 s (a first owner)
//   node probe-rail.ts intruder -> opens the same file while the owner holds it, and commits
//   node probe-rail.ts single  -> requestId reuse with different content; watch() ops JSON round-trip
import { mkdirSync, writeFileSync } from 'node:fs';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const phase = process.argv[2];
const ctx = BACKGROUND_CONTEXT;
mkdirSync('data', { recursive: true });
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const file = phase === 'single' ? 'data/probe-single.sqlite' : 'data/probe.sqlite';
const out: Record<string, unknown> = { phase, at: new Date().toISOString() };
try {
  const storage = await openNodeSqliteStorage(file);
  const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { compaction: { enabled: false } } }, ctx);
  out.opened = true;
  const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
  if (phase === 'owner' || phase === 'intruder') {
    faux.setResponses([fauxAssistantMessage(`answer from ${phase}`)]);
    const s = await root.submit({ type: 'input', content: `hello from ${phase}`, requestId: `${phase}-${Date.now()}` }, ctx);
    out.submit = (await s.wait(ctx)).status;
    if (phase === 'owner') await new Promise((r) => setTimeout(r, 8000));
    faux.setResponses([fauxAssistantMessage(`second answer from ${phase}`)]);
    const t = await root.submit({ type: 'input', content: `again from ${phase}`, requestId: `${phase}-b-${Date.now()}` }, ctx);
    out.submit2 = (await t.wait(ctx)).status;
    const list = await root.entries({ order: 'ascending' }, 200, undefined, ctx);
    out.entry_ids = list.items.map((e) => `${e.id}:${e.kind}`);
  }
  if (phase === 'single') {
    const watch = await root.watch(ctx);
    const frames: string[] = [];
    watch.start(async (_v, ops) => { frames.push(JSON.stringify(ops)); });
    faux.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')]);
    const a = await root.submit({ type: 'input', content: 'first content', requestId: 'dup-1' }, ctx);
    await a.wait(ctx);
    const b = await root.submit({ type: 'input', content: 'DIFFERENT content', requestId: 'dup-1' }, ctx);
    out.same_submission_for_different_content = a.id === b.id;
    out.second_status = (await b.wait(ctx)).status;
    await new Promise((r) => setTimeout(r, 300));
    await watch.stop();
    out.watch_frames = frames.length;
    out.watch_frames_roundtrip_ok = frames.every((f) => JSON.stringify(JSON.parse(f)) === f);
    out.watch_bytes_total = frames.reduce((n, f) => n + f.length, 0);
    out.first_frame_sample = frames[0]?.slice(0, 300);
  }
  await harness.close(ctx);
  out.closed = true;
} catch (error) {
  out.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
writeFileSync(`data/probe-${phase}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
