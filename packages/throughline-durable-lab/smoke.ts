// Smoke test for the Pi Durable 1.4.0 lab install, run as two separate processes against one SQLite file.
// The free in-memory "faux" model answers, so no key and no spend. Automatic compaction is off.
//   node smoke.ts first   -> answer one input, reset with a handoff note, submit a second input, exit before it runs
//   node smoke.ts second  -> reopen, resume the unfinished input, resubmit its request id, check it was not doubled
import { mkdirSync, writeFileSync } from 'node:fs';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { AssistantEntry, createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const phase = process.argv[2];
const ctx = BACKGROUND_CONTEXT;
mkdirSync('data', { recursive: true });
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const storage = await openNodeSqliteStorage('data/smoke.sqlite');
const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { compaction: { enabled: false } } }, ctx);
const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
const out: Record<string, unknown> = { phase, at: new Date().toISOString(), conversation: root.id, model: `${model.provider}/${model.id}` };

if (phase === 'first') {
  faux.setResponses([fauxAssistantMessage('Paris.')]);
  const first = await root.submit({ type: 'input', content: 'What is the capital of France?', requestId: 'smoke-1' }, ctx);
  const settled = await first.wait(ctx);
  out.first = settled.status;
  if (settled.status === 'done' && settled.type === 'input') {
    const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
    out.answer = answer?.model?.[0];
  }
  await root.reset('We answered a geography question. Continue from here.', ctx);
  const pending = await root.submit({ type: 'input', content: 'And of Italy?', requestId: 'smoke-2' }, ctx);
  out.pending_submission = pending.id;
  writeFileSync('data/first.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
  process.exit(0); // leave smoke-2 unanswered, as a crash would
}

if (phase === 'second') {
  faux.setResponses([fauxAssistantMessage('Rome.')]);
  harness.resume();
  const again = await root.submit({ type: 'input', content: 'And of Italy?', requestId: 'smoke-2' }, ctx);
  out.resubmitted_submission = again.id;
  const settled = await again.wait(ctx);
  out.second = settled.status;
  const history = await root.entries({ order: 'ascending' }, 100, undefined, ctx);
  out.stored_entries = history.items.map((e) => e.kind);
  const active = await root.context(ctx);
  out.active_context_messages = active.messages?.length;
  writeFileSync('data/second.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
  await harness.close(ctx);
}
