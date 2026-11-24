import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IcpVersion, Receipt, SignalType } from '../shared/types';
import { SIGNALS } from '../shared/constants';
import { deriveState } from '../server/domain/state';
import { freshness, scoreLead, tierFor } from '../server/domain/scoring';
import { containsSnippet, htmlToText } from '../server/domain/text';
import { ruleFacts, rulePeople, ruleSignals } from '../server/agents/extractor';
import { unsupportedFigures, validateDraft } from '../server/agents/writer';
import { ownDomainFrom, sharesCategory } from '../server/agents/researcher';
import { scanDraft } from '../server/agents/security';
import { costOf } from '../server/services/usage';
import type { Company, Message, Person } from '../shared/types';

const DAY = 86_400_000;
const NOW = new Date('2026-11-24T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let n = 0;
function receipt(type: SignalType, daysAgo: number, over: Partial<Receipt> = {}): Receipt {
  const window = SIGNALS[type].window;
  return {
    id: `r_${++n}`,
    entity_type: 'company',
    entity_id: 'c_1',
    field: 'signal',
    claim: `Acme ${type}`,
    source_url: 'http://example.test/page',
    snippet: 'Acme did a thing worth quoting.',
    signal_type: type,
    sign: SIGNALS[type].sign,
    seen_at: ago(daysAgo),
    event_at: ago(daysAgo),
    expires_at: window == null ? null : new Date(NOW.getTime() - daysAgo * DAY + window * DAY).toISOString(),
    status: 'unverified',
    verified_by: null,
    verified_at: null,
    fail_reason: null,
    confidence: 0.8,
    data: {},
    ...over,
  };
}

const icp: IcpVersion = {
  id: 'icp_1',
  version: 1,
  parent_id: null,
  fields: {
    industries: [{ value: 'AI / ML', confidence: 0.8 }],
    headcount_bands: [{ value: '51-200', confidence: 0.8 }],
    regions: [{ value: 'North America', confidence: 0.5 }],
    personas: [{ value: 'VP Engineering', confidence: 0.8 }],
    trigger_events: [{ value: 'job_posting', confidence: 0.8 }],
    excluded_regions: [],
    keywords: ['billing'],
  },
  weights: { job_posting: 40, funding: 30, exec_hire: 30, tech_change: 45 },
  windows: { job_posting: 60, funding: 120 },
  expansions: [{ id: 'x_1', name: 'Fintech', reasoning: '', industries: ['Fintech'], headcount_bands: [], status: 'proposed' }],
  search_plan: [],
  rationale: '',
  planned_by: 'heuristic',
  created_at: ago(1),
};

// ---------- state rules ----------

test('a live positive trigger makes a lead active', () => {
  const d = deriveState([receipt('job_posting', 5)], NOW);
  assert.equal(d.state, 'active');
});

test('any live negative receipt disqualifies, even beside a live positive', () => {
  const d = deriveState([receipt('job_posting', 5), receipt('layoffs', 40)], NOW);
  assert.equal(d.state, 'disqualified');
  assert.equal(d.reason, 'Acme layoffs');
});

test('no trigger at all is not yet, and names what it is waiting for', () => {
  const d = deriveState([receipt('firmographic', 5)], NOW, ['job posting', 'funding']);
  assert.equal(d.state, 'not_yet');
  assert.equal(d.reason_code, 'no_trigger');
  assert.match(d.reason, /job posting, funding/);
});

test('an expired trigger sends the lead back to not yet with the age of the expiry', () => {
  const d = deriveState([receipt('funding', 425)], NOW);
  assert.equal(d.reason_code, 'expired');
  assert.match(d.reason, /expired 305 days ago/);
});

test('a trigger that failed re-verification no longer counts', () => {
  const d = deriveState([receipt('job_posting', 5, { status: 'failed', fail_reason: 'page is gone (HTTP 410)' })], NOW);
  assert.equal(d.state, 'not_yet');
  assert.equal(d.reason_code, 'failed_verification');
  assert.match(d.reason, /HTTP 410/);
});

test('an expired negative stops suppressing the lead', () => {
  const d = deriveState([receipt('job_posting', 5), receipt('hiring_freeze', 130)], NOW);
  assert.equal(d.state, 'active');
});

test('a disproved negative stops suppressing the lead', () => {
  const d = deriveState([receipt('job_posting', 5), receipt('layoffs', 10, { status: 'failed' })], NOW);
  assert.equal(d.state, 'active');
});

// ---------- scoring ----------

test('freshness falls from 1 to 0.15 across the window', () => {
  assert.equal(freshness(receipt('job_posting', 0), NOW, 60), 1);
  assert.ok(Math.abs(freshness(receipt('job_posting', 30), NOW, 60) - 0.575) < 1e-9);
  assert.ok(Math.abs(freshness(receipt('job_posting', 60), NOW, 60) - 0.15) < 1e-9);
});

test('score is half fit and half intent, with every input kept', () => {
  const s = scoreLead({ industry: 'AI / ML', headcount: 140, region: 'North America' }, [receipt('job_posting', 0)], icp, NOW);
  assert.equal(s.fit_score, 100);
  assert.equal(s.intent_score, 40);
  assert.equal(s.score, 70);
  assert.equal(s.tier, 'A');
  assert.equal(s.intent.length, 1);
});

test('an accepted expansion segment widens fit', () => {
  const company = { industry: 'Fintech', headcount: 140, region: 'North America' };
  assert.equal(scoreLead(company, [], icp, NOW).fit.industry.points, 0);
  const widened = { ...icp, expansions: [{ ...icp.expansions[0], status: 'accepted' as const }] };
  const part = scoreLead(company, [], widened, NOW).fit.industry;
  assert.equal(part.points, 45);
  assert.equal(part.via, 'expansion');
});

test('expired and failed triggers add no intent', () => {
  const s = scoreLead({ industry: null, headcount: null, region: null }, [receipt('job_posting', 90), receipt('funding', 5, { status: 'failed' })], icp, NOW);
  assert.equal(s.intent_score, 0);
});

test('tiers: A at 65, B at 45, C below', () => {
  assert.deepEqual([tierFor(65), tierFor(64.9), tierFor(45), tierFor(44.9)], ['A', 'B', 'B', 'C']);
});

// ---------- snippets ----------

test('a snippet matches despite case, whitespace and curly quotes', () => {
  const page = htmlToText('<main><p>Acme  raises\n $42 million Series&nbsp;B led by “Halcyon”.</p></main>');
  assert.ok(containsSnippet(page, 'acme raises $42 million series b led by "Halcyon".'));
});

test('a snippet that is not on the page does not match', () => {
  const page = htmlToText('<p>Acme has postponed its planned pricing changes.</p>');
  assert.equal(containsSnippet(page, 'Acme is introducing usage-based pricing tiers'), false);
  assert.equal(containsSnippet(page, 'Acme'), false, 'too short to count as evidence');
});

// ---------- extraction ----------

test('rule extractor reads positive and negative signals with their sentences', () => {
  const text = [
    'Acme is hiring a Senior Billing Engineer to own metering.',
    'Acme raises $42 million Series B led by Halcyon Ventures.',
    'Acme appoints Dana Whitfield as Chief Revenue Officer to lead its move upmarket.',
    'Acme is moving to usage-based pricing for all API plans.',
    'Acme is reducing its workforce by 18% as part of a restructuring.',
    'Acme has paused all hiring through the end of the year.',
    'Acme signs a three-year agreement with Chargeline for billing.',
    'Unrelated Corp is hiring a Chef to cook.',
  ].join('\n');
  const hits = ruleSignals(text, 'Acme', ['Chargeline']);
  assert.deepEqual(
    hits.map((h) => h.signal_type),
    ['job_posting', 'funding', 'exec_hire', 'tech_change', 'layoffs', 'hiring_freeze', 'competitor_signed'],
  );
  assert.equal(hits[0].data.role, 'Senior Billing Engineer');
  assert.deepEqual([hits[1].data.amount, hits[1].data.round], ['$42 million', 'Series B']);
  assert.deepEqual([hits[2].data.person, hits[2].data.title], ['Dana Whitfield', 'Chief Revenue Officer']);
  assert.equal(hits[4].sign, 'negative');
  for (const h of hits) assert.ok(containsSnippet(text, h.snippet), 'every hit quotes the page');
});

test('rule extractor reads firmographics and people', () => {
  const facts = ruleFacts('Acme builds inference infrastructure for language model teams.\nWe are a team of 140 people headquartered in San Francisco, California.', 'Acme');
  const by = Object.fromEntries(facts.map((f) => [f.field, f.value]));
  assert.deepEqual(by, { headcount: '140', hq: 'San Francisco, California', region: 'North America', industry: 'AI / ML' });

  const people = rulePeople('Priya Raman, VP Engineering. Previously at Lumen Cloud and Hexaform. Email: priya@acme.example\nAnnelies de Vries, Head of Finance.');
  assert.equal(people.length, 2);
  assert.deepEqual(people[0].previous, ['Lumen Cloud', 'Hexaform']);
  assert.equal(people[0].email, 'priya@acme.example');
  assert.equal(people[1].name, 'Annelies de Vries');
  assert.equal(people[1].email, null);
});

// ---------- the sentence format ----------

test('a claim with no receipt, or with an invented figure, fails the format check', () => {
  const funding = receipt('funding', 5, { snippet: 'Acme raises $42 million Series B.', claim: 'Acme raised $42 million (Series B).' });
  const allowed = new Map([[funding.id, funding]]);
  const ok = { subject: 'A thought', sentences: [{ text: 'Congratulations on the $42 million Series B.', kind: 'claim' as const, receipt_ids: [funding.id], status: 'ok' as const }] };
  assert.deepEqual(validateDraft(ok, allowed), []);

  const uncited = { ...ok, sentences: [{ ...ok.sentences[0], receipt_ids: [] }] };
  assert.match(validateDraft(uncited, allowed)[0], /no receipt id/);

  const invented = { ...ok, sentences: [{ ...ok.sentences[0], text: 'Congratulations on the $50 million Series C.' }] };
  assert.match(validateDraft(invented, allowed)[0], /figures its receipts do not contain: 50/);
  assert.deepEqual(unsupportedFigures('the $50 million round', [funding]), ['50']);

  const smuggled = { ...ok, sentences: [...ok.sentences, { text: 'You also raised a $10 million bridge.', kind: 'connective' as const, receipt_ids: [], status: 'ok' as const }] };
  assert.match(validateDraft(smuggled, allowed)[0], /marked connective but states a fact/);
});

// ---------- competitors ----------

test('a rival is recognised from single-word and from phrase keywords alike', () => {
  const chargeline = 'Chargeline is a usage-based billing platform for SaaS companies.';
  const tallybird = 'Tallybird is a metering and usage-based billing API for developer platforms.';
  const prospect = 'Northbeam AI builds inference infrastructure that lets product teams ship language model features.';
  const words = ['usage-based', 'billing', 'metering', 'infrastructure'];
  const phrases = ['usage-based billing', 'metering', 'api monetization', 'credit limits', 'invoicing', 'pricing infrastructure'];
  for (const keywords of [words, phrases]) {
    assert.equal(sharesCategory(chargeline, keywords), true);
    assert.equal(sharesCategory(tallybird, keywords), true);
    assert.equal(sharesCategory(prospect, keywords), false, 'one shared word is not enough');
  }
});

// ---------- the security scan ----------

test('the security scan clears a clean draft and blocks links, leaks and a wrong recipient', () => {
  const company = { id: 'c_1', name: 'Acme', domain: 'acme.example', site_url: 'https://acme.example/', industry: null, headcount: null, region: null, hq: null, kind: 'prospect', differentiator: null } as Company;
  const person = { id: 'p_1', company_id: 'c_1', name: 'Dana Whitfield', title: 'CRO', email: 'dana@acme.example', email_status: 'verified', previous_companies: [], confidence: 0.9 } as Person;
  const cited = [receipt('funding', 5, { source_url: 'https://news.acme.example/series-b' })];
  const draft = (...lines: string[]): Message =>
    ({
      id: 'm_1',
      lead_id: 'l_1',
      channel: 'email',
      variant: 'A',
      subject: 'A thought',
      sentences: lines.map((text) => ({ text, kind: 'connective', receipt_ids: [], status: 'ok' })),
      status: 'pending_review',
    }) as unknown as Message;
  const ctx = { company, person, cited, otherAccounts: ['Acme', 'Northbeam AI', 'Quillstack'] };
  const codes = (m: Message, over = {}) => scanDraft(m, { ...ctx, ...over }).map((f) => `${f.severity}:${f.code}`);

  assert.deepEqual(codes(draft('Hi Dana,', 'Worth a 15-minute look next week?')), []);
  assert.deepEqual(codes(draft('The announcement is at https://news.acme.example/series-b.')), [], 'a link to a cited source is fine');

  assert.deepEqual(codes(draft('Book a slot at https://bit.ly/3xyz')), ['block:shortened_link']);
  assert.deepEqual(codes(draft('See https://totally-unrelated.example/offer')), ['block:unverified_link']);
  assert.deepEqual(codes(draft('Our dashboard is at http://localhost:8787/accounts')), ['block:internal_link']);
  assert.deepEqual(codes(draft('This rests on receipt r_3fa9c1.')), ['block:internal_id']);
  assert.deepEqual(codes(draft('Use key sk-live-abcdefghijklmnopqrstuv to try it.')), ['block:secret']);
  assert.deepEqual(codes(draft('Northbeam AI is also looking at this.')), ['block:other_prospect']);
  assert.deepEqual(codes(draft('You can also reach tom@elsewhere.example.')), ['block:third_party_email']);

  assert.deepEqual(codes(draft('Hi Dana,'), { person: { ...person, email: 'dana@gmail.example' } }), ['block:recipient_domain']);
  assert.deepEqual(codes(draft('Hi Dana,'), { person: { ...person, email_status: 'guessed' } }), ['warn:guessed_recipient'], 'a guessed address is a warning, not a block');
  assert.deepEqual(codes(draft('Hi Dana,'), { person: null }), ['block:no_recipient']);

  // A struck sentence is not part of what would be sent, so it is not scanned.
  const struck = draft('See https://bit.ly/3xyz');
  struck.sentences[0].status = 'struck';
  assert.deepEqual(codes(struck), []);
});

// ---------- telemetry ----------

test('model cost is computed from list prices, and an unknown model has no price', () => {
  assert.equal(costOf('claude-opus-5-5', 1_000_000, 1_000_000), 24);
  assert.equal(costOf('claude-opus-5-5', 2000, 500), (2000 * 4 + 500 * 20) / 1_000_000);
  assert.equal(costOf('some-other-model', 1000, 1000), null);
});

test('a company domain is taken from a link on the page only when the host is named after the company', () => {
  const page = (html: string) => ({ html, url: 'https://job-boards.greenhouse.io/mithril' });
  assert.equal(ownDomainFrom(page('<a href="https://www.mithril.ai/about">About</a> <a href="https://twitter.com/mithril">X</a>'), 'Mithril'), 'mithril.ai');
  assert.equal(ownDomainFrom(page('<a href="https://blog.cloudflare.com/post">Blog</a>'), 'Cloudflare, Inc.'), 'cloudflare.com');
  assert.equal(ownDomainFrom(page('<a href="https://job-boards.greenhouse.io/other">Other</a> <a href="https://example.org/x">x</a>'), 'Mithril'), '', 'no matching link, so the domain stays unknown');
  assert.equal(ownDomainFrom(page('<a href="https://ai.example/x">x</a>'), 'AI'), '', 'a name too short to match safely');
});
