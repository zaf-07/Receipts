import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Graph, Snapshot, WhyStep } from '../shared/types';

// One end-to-end run over the seeded world, through the real HTTP API, with the deterministic agents.
// It walks the demo script: discovery, the Skeptic's catches, restraint, approval, the credit gate, learning.

process.env.RECEIPTS_LLM = 'off';
process.env.RECEIPTS_SOURCE = 'world';
delete process.env.PUBLIC_URL;

let base = '';
let stop: () => Promise<void>;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

async function settled(): Promise<Snapshot> {
  for (let i = 0; i < 200; i++) {
    const snap = await api<Snapshot>('/snapshot');
    if (!snap.running) return snap;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('The pipeline did not settle.');
}

const lead = (snap: Snapshot, name: string) => {
  const found = snap.leads.find((l) => l.company.name === name);
  assert.ok(found, `${name} should be a lead`);
  return found;
};

before(async () => {
  const { start } = await import('../server/app');
  const started = await start({ port: 0, dbPath: ':memory:' });
  base = `http://localhost:${started.port}`;
  stop = started.stop;
});

after(async () => {
  await stop();
});

test('intake produces an ICP with a confidence on every field and two adjacent segments', async () => {
  const example = await api<Record<string, unknown>>('/example');
  await api('/intake', example);
  const snap = await settled();
  assert.ok(snap.icp);
  assert.equal(snap.icp.version, 1);
  for (const field of ['industries', 'headcount_bands', 'regions', 'personas', 'trigger_events'] as const) {
    assert.ok(snap.icp.fields[field].length > 0, `${field} is populated`);
    for (const item of snap.icp.fields[field]) assert.ok(item.confidence > 0 && item.confidence <= 1);
  }
  assert.equal(snap.icp.expansions.length, 2);
  assert.equal(snap.credits.balance, 38);
});

test('discovery writes receipts, and every lead ends active or held back with a reason', async () => {
  await api('/run', {});
  const snap = await settled();
  assert.equal(snap.leads.length, 28);
  assert.equal(snap.competitors.length, 2);

  for (const l of snap.leads) {
    if (l.state === 'active') assert.ok(l.receipts.some((r) => r.field === 'signal' && r.sign === 'positive' && r.live), `${l.company.name} is active on a live receipt`);
    else assert.ok(l.dormant_reason, `${l.company.name} carries its reason`);
    for (const field of ['industry', 'headcount', 'region'] as const) {
      assert.ok(l.receipts.some((r) => r.field === field), `${l.company.name}.${field} has a receipt`);
    }
  }

  assert.equal(lead(snap, 'Northbeam AI').tier, 'A');
  assert.equal(lead(snap, 'Northbeam AI').warm_intro, 'Lumen Cloud');
  assert.equal(lead(snap, 'Kestrel Systems').state, 'disqualified');
  assert.match(lead(snap, 'Kestrel Systems').dormant_reason!, /reducing its workforce by 18%/);
  assert.equal(lead(snap, 'Mosaic Commerce').state, 'disqualified');
  assert.match(lead(snap, 'Mosaic Commerce').dormant_reason!, /Chargeline/);
  assert.equal(lead(snap, 'Orbitcast').state, 'disqualified');
  assert.equal(lead(snap, 'Sundial Labs').state, 'disqualified');
  assert.match(lead(snap, 'Sundial Labs').dormant_reason!, /outside the regions we serve/);
  assert.equal(lead(snap, 'Brightloop').reason_code, 'expired');
  assert.equal(lead(snap, 'Parallax Data').reason_code, 'no_trigger');

  for (const c of snap.competitors) assert.ok(c.pricing && c.receipts.some((r) => r.field === 'pricing'), `${c.company.name} pricing has a receipt`);
});

test('the Skeptic strikes a claim whose source was taken down, and blocks a draft with nothing left', async () => {
  const snap = await settled();

  const vectorly = lead(snap, 'Vectorly');
  assert.equal(vectorly.message?.status, 'pending_review');
  const struck = vectorly.message!.sentences.filter((s) => s.status === 'struck');
  assert.equal(struck.length, 1);
  assert.match(struck[0].strike_reason!, /HTTP 410/);
  assert.ok(vectorly.message!.sentences.some((s) => s.kind === 'claim' && s.status === 'ok'));

  const fathom = lead(snap, 'Fathom Works');
  assert.equal(fathom.message?.status, 'blocked');
  assert.equal(fathom.state, 'not_yet');
  assert.equal(fathom.reason_code, 'failed_verification');

  assert.equal(snap.metrics.claims_struck, 4);
  assert.ok(snap.metrics.catch_rate! > 0.15 && snap.metrics.catch_rate! < 0.35);

  // Every claim a human will see rests on receipts the Skeptic verified against the live page.
  for (const l of snap.leads) {
    if (l.message?.status !== 'pending_review') continue;
    for (const s of l.message.sentences) {
      if (s.kind !== 'claim' || s.status !== 'ok') continue;
      assert.ok(s.receipt_ids.length > 0);
      for (const id of s.receipt_ids) assert.equal(l.receipts.find((r) => r.id === id)?.status, 'verified');
    }
  }
});

test('enrichment is honest about what it could not resolve', async () => {
  const snap = await settled();
  assert.equal(lead(snap, 'Northbeam AI').person?.email_status, 'verified');
  const cobalt = lead(snap, 'Cobalt Ledger');
  assert.equal(cobalt.person?.email_status, 'guessed');
  assert.equal(cobalt.enrich_status, 'low_confidence');
  assert.ok(cobalt.person!.confidence < 0.5);
  const tessera = lead(snap, 'Tessera Health');
  assert.equal(tessera.enrich_status, 'unresolved');
  assert.equal(tessera.person, null);
  assert.equal(tessera.message, null);
});

test('the pipeline ran as scoped tasks in parallel, one per account, lead and draft', async () => {
  const snap = await settled();
  const of = (kind: string) => snap.tasks.filter((t) => t.kind === kind);

  assert.equal(of('plan').length, 1, 'one ICP run');
  assert.equal(of('search').length, 1);
  assert.equal(of('read').length, snap.leads.length, 'one read task per account');
  assert.ok(of('read').every((t) => t.status === 'done' && t.attempt === 1));

  // Parallel for real: some read tasks were in flight at the same moment.
  const reads = of('read');
  const overlapped = reads.some((a) => reads.some((b) => a.id !== b.id && a.started_at! < b.finished_at! && b.started_at! < a.finished_at!));
  assert.ok(overlapped, 'read tasks overlapped in time');
  assert.ok(snap.team.concurrency > 1);

  // One enrichment task per active lead, one writing task per enriched lead, one Skeptic task per draft.
  const northbeam = lead(snap, 'Northbeam AI');
  const mine = (kind: string) => of(kind).filter((t) => t.lead_id === northbeam.id);
  assert.equal(mine('enrich').length, 1);
  assert.equal(mine('write').length, 1);
  assert.equal(mine('verify').length, northbeam.messages.length);
  assert.deepEqual(mine('write')[0].depends_on, [mine('enrich')[0].id], 'writing waits for the contact');
  assert.deepEqual(mine('verify')[0].depends_on, [mine('write')[0].id], 'verification waits for the draft');
  assert.deepEqual([...mine('write')[0].output_message_ids].sort(), northbeam.messages.map((m) => m.id).sort(), 'the task records the drafts it produced');
  assert.ok(mine('verify')[0].input_receipt_ids.length > 0, 'and the receipts it was given to check');

  // Every draft waiting for a person has exactly one open review task, and nothing else is in review.
  const waiting = snap.leads.flatMap((l) => l.messages).filter((m) => m.status === 'pending_review');
  const gates = of('approve').filter((t) => t.status === 'review');
  assert.deepEqual(gates.map((t) => t.input.message_id).sort(), waiting.map((m) => m.id).sort());
  assert.ok(gates.every((t) => t.agent === 'human'));

  assert.ok(snap.tasks.every((t) => t.status !== 'running' && t.status !== 'queued'), 'nothing is left in flight');
  assert.ok(snap.runs.every((r) => r.status === 'done'), 'a run waiting only on people is settled');

  // Each activity line written by a task is linked back to it.
  const linked = snap.activity.filter((a) => a.task_id);
  assert.ok(linked.length > 10);
  assert.ok(linked.every((a) => snap.tasks.some((t) => t.id === a.task_id)));
});

test("agents append: the Skeptic adds a verdict and a draft version, and the Writer keeps its own", async () => {
  const snap = await settled();
  const vectorly = lead(snap, 'Vectorly');
  const email = vectorly.messages.find((m) => m.channel === 'email')!;
  const history = snap.draft_versions.filter((v) => v.message_id === email.id);

  assert.deepEqual(history.map((v) => [v.version, v.author]), [[1, 'writer'], [2, 'skeptic']]);
  assert.equal(history[0].struck, 0, 'version 1 is what the Writer wrote, untouched');
  assert.equal(history[1].struck, 1, "version 2 is the verdict the Skeptic added");
  assert.equal(history[0].claims, history[1].claims);
  const verify = snap.tasks.find((t) => t.kind === 'verify' && t.input.message_id === email.id)!;
  assert.equal(history[1].task_id, verify.id, 'the version records the task that made it');

  // A struck receipt keeps its claim, snippet and source. Only a verdict was added.
  const gone = vectorly.receipts.find((r) => r.status === 'failed')!;
  assert.ok(gone.claim && gone.snippet && gone.source_url);
  assert.equal(gone.verified_by, 'skeptic');
});

test('the graph answers why this person, why now, why us, with the warm intro', async () => {
  const snap = await settled();
  const why = await api<WhyStep[]>(`/leads/${lead(snap, 'Northbeam AI').id}/why`);
  assert.deepEqual([...new Set(why.map((s) => s.question))], ['Why now', 'Why this company', 'Why this person', 'Warm intro', 'Why us']);
  const graph = await api<Graph>('/graph');
  assert.ok(graph.edges.some((e) => e.type === 'previously_employed_at'));
  assert.ok(graph.edges.some((e) => e.type === 'competes_with'));
});

test('nothing sends without approval; approving moves the card to Contacted with an AI badge', async () => {
  let snap = await settled();
  assert.equal(snap.metrics.messages_sent, 0);
  const quill = lead(snap, 'Quillstack');
  await api(`/messages/${quill.message!.id}/approve`, { reviewer: 'Tester' });
  await api(`/messages/${lead(snap, 'Cobalt Ledger').message!.id}/reject`, { reviewer: 'Tester', note: 'Email is only a guess.' });
  snap = await settled();
  assert.equal(lead(snap, 'Quillstack').stage, 'Contacted');
  assert.equal(lead(snap, 'Quillstack').stage_actor, 'agent');
  assert.equal(lead(snap, 'Quillstack').messages.filter((m) => m.status === 'sent').length, 1);
  assert.deepEqual(
    lead(snap, 'Quillstack').messages.map((m) => [m.variant, m.channel]),
    [
      ['A', 'email'],
      ['B', 'linkedin'],
    ],
  );
  assert.equal(lead(snap, 'Cobalt Ledger').stage, 'Matched');
  assert.equal(lead(snap, 'Cobalt Ledger').messages.filter((m) => m.status === 'rejected').length, 1);
  assert.equal(snap.metrics.messages_sent, 1);
  assert.equal(snap.metrics.proof_rate, 1);
  await assert.rejects(api(`/messages/${quill.message!.id}/approve`, { reviewer: 'Tester' }), /cannot be approved/);
});

test('ingest wakes a dormant lead, and the credit gate holds its enrichment', async () => {
  await api('/ingest', {});
  let snap = await settled();
  const bright = lead(snap, 'Brightloop');
  assert.equal(bright.state, 'active');
  assert.equal(bright.enrich_status, 'blocked_credits');
  assert.equal(bright.person, null);
  assert.ok(snap.credits.gated);
  assert.ok(snap.credits.balance < snap.credits.costs.enrich);

  // Blocked is a real task state with its reason, and the held task was never started.
  const held = snap.tasks.find((t) => t.kind === 'enrich' && t.lead_id === bright.id)!;
  assert.equal(held.status, 'blocked');
  assert.equal(held.blocker_code, 'credits');
  assert.match(held.blocker!, /Needs 7 credits/);
  assert.equal(held.attempt, 0);
  assert.ok(snap.activity.some((a) => a.kind === 'block' && a.task_id === held.id), 'the block is in the event stream, linked to its task');

  await api('/credits/topup', { amount: 50 });
  snap = await settled();
  assert.equal(lead(snap, 'Brightloop').enrich_status, 'resolved');
  assert.equal(snap.tasks.find((t) => t.id === held.id)!.status, 'done', 'the same task resumed once credits arrived');
  assert.equal(snap.tasks.filter((t) => t.kind === 'enrich' && t.lead_id === bright.id).length, 1, 'no duplicate was created');
  assert.equal(lead(snap, 'Brightloop').message?.status, 'pending_review');
  assert.equal(snap.credits.gated, false);
});

test('a reply raises the weight of the cited signal type and saves ICP v2', async () => {
  let snap = await settled();
  const before = lead(snap, 'Quillstack').score;
  await api(`/leads/${lead(snap, 'Quillstack').id}/stage`, { to_stage: 'Replied', actor: 'Tester' });
  snap = await settled();
  assert.equal(snap.icp?.version, 2);
  assert.equal(snap.icp?.weights.tech_change, 56.25);
  assert.equal(snap.icp_versions[0].weights.tech_change, 45);
  assert.ok(lead(snap, 'Quillstack').score > before);
  assert.equal(lead(snap, 'Quillstack').stage_actor, 'rep');
  assert.equal(snap.metrics.replies, 1);
  assert.equal(snap.metrics.reply_rate, 1);
});

test('an inbound reply advances a sent message and detects booking intent', async () => {
  // Approve another checked draft, then exercise the provider-neutral inbound path.
  let snap = await settled();
  const vectorly = lead(snap, 'Vectorly');
  await api(`/messages/${vectorly.message!.id}/approve`, { reviewer: 'Tester' });
  await api('/inbound', { message_id: vectorly.message!.id, text: 'Happy to schedule a demo next week.', source: 'test provider' });
  snap = await settled();
  assert.equal(lead(snap, 'Vectorly').stage, 'Meeting Booked');
  assert.equal(lead(snap, 'Vectorly').stage_actor, 'agent');
  assert.ok(lead(snap, 'Vectorly').transitions.some((t) => t.to_stage === 'Replied' && t.actor === 'Inbound webhook'));
  assert.ok(lead(snap, 'Vectorly').transitions.some((t) => t.to_stage === 'Meeting Booked' && t.actor === 'Inbound webhook'));
});

test('receipts expire on their own and the lead goes back to not yet', async () => {
  await api('/demo/clock', { days: 200 });
  const snap = await settled();
  for (const l of snap.leads) assert.notEqual(l.state, 'active', `${l.company.name} has no live trigger 200 days on`);
  assert.equal(lead(snap, 'Northbeam AI').reason_code, 'expired');
  assert.equal(lead(snap, 'Northbeam AI').message?.status, 'blocked');
  assert.equal(lead(snap, 'Orbitcast').state, 'not_yet', 'the hiring freeze expired too');
});
