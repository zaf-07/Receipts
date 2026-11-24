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
  assert.equal(snap.leads.length, 12);
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

  assert.equal(snap.metrics.claims_struck, 2);
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
  assert.equal(lead(snap, 'Quillstack').message?.status, 'sent');
  assert.equal(lead(snap, 'Cobalt Ledger').stage, 'Matched');
  assert.equal(lead(snap, 'Cobalt Ledger').message?.status, 'rejected');
  assert.equal(snap.metrics.messages_sent, 1);
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

  await api('/credits/topup', { amount: 50 });
  snap = await settled();
  assert.equal(lead(snap, 'Brightloop').enrich_status, 'resolved');
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

test('receipts expire on their own and the lead goes back to not yet', async () => {
  await api('/demo/clock', { days: 200 });
  const snap = await settled();
  for (const l of snap.leads) assert.notEqual(l.state, 'active', `${l.company.name} has no live trigger 200 days on`);
  assert.equal(lead(snap, 'Northbeam AI').reason_code, 'expired');
  assert.equal(lead(snap, 'Northbeam AI').message?.status, 'blocked');
  assert.equal(lead(snap, 'Orbitcast').state, 'not_yet', 'the hiring freeze expired too');
});
