import type {
  CompetitorView,
  ContrastSentence,
  Graph,
  GraphAnswer,
  GraphEdge,
  GraphNode,
  LeadView,
  Metrics,
  Receipt,
  ReceiptView,
  SegmentRow,
  Snapshot,
  VariantMetric,
  WhyStep,
} from '../../shared/types';
import { SIGNALS, bandFor } from '../../shared/constants';
import { clockOffsetDays, now } from '../clock';
import { config, llmEnabled } from '../config';
import { getSetting, setSetting } from '../db';
import { isExpired, isLive, isTrigger } from '../domain/state';
import { firstName, normalize } from '../domain/text';
import { flexpriceEnabled, meterEvent } from '../integrations/flexprice';
import { bandEnabled, bandStatus } from '../integrations/band';
import { unsupportedFigures, warmIntro } from '../agents/writer';
import { recentActivity } from './activity';
import { balance, countOps, recentLedger } from './ledger';
import { listRuns, listTaskMessages, listTasks } from './tasks';
import { usageSummary } from './usage';
import {
  allReceipts,
  currentIcp,
  listDraftVersions,
  getCompany,
  getLead,
  getPerson,
  getProfile,
  leadReceipts,
  listCompanies,
  listIcpVersions,
  listLeads,
  listMessages,
  listTransitions,
} from './store';
import { listWorldPages, pendingBatches } from '../world/world';

const view = (r: Receipt, at: Date): ReceiptView => ({ ...r, live: isLive(r, at), expired: isExpired(r, at) });

export function buildLeads(): LeadView[] {
  const at = now();
  const profile = getProfile();
  const transitions = listTransitions();
  const messages = listMessages();
  return listLeads().map((lead) => {
    const company = getCompany(lead.company_id)!;
    const person = getPerson(lead.person_id);
    const receipts = leadReceipts(lead);
    const own = transitions.filter((t) => t.lead_id === lead.id);
    const into = [...own].reverse().find((t) => t.to_stage === lead.stage);
    const warm = profile ? warmIntro(receipts, profile) : null;
    const ownMessages = messages.filter((m) => m.lead_id === lead.id);
    return {
      ...lead,
      company,
      person,
      receipts: receipts.map((r) => view(r, at)),
      transitions: own,
      message: ownMessages.find((m) => m.status === 'pending_review') ?? ownMessages[0] ?? null,
      messages: ownMessages,
      stage_actor: into?.actor_type ?? null,
      warm_intro: warm?.data.company ?? null,
    };
  });
}

function buildCompetitors(): CompetitorView[] {
  const at = now();
  const receipts = allReceipts();
  return listCompanies('competitor').map((company) => {
    const own = receipts.filter((r) => r.entity_id === company.id).map((r) => view(r, at));
    const snippet = (field: string) => own.filter((r) => r.field === field).pop()?.snippet ?? null;
    return { company, receipts: own, positioning: snippet('positioning'), pricing: snippet('pricing') };
  });
}

/** The dashboard numbers. Proof rate measures approved sends; catch rate shows the Skeptic's intervention. */
export function buildMetrics(leads: LeadView[]): Metrics {
  const messages = listMessages();
  const claims = messages.flatMap((m) => m.sentences.filter((s) => s.kind === 'claim'));
  const struck = claims.filter((s) => s.status === 'struck').length;
  const sentMessages = messages.filter((m) => m.status === 'sent');
  const sent = sentMessages.length;
  const proved = sentMessages.filter((message) => {
    const factualClaims = message.sentences.filter((sentence) => sentence.kind === 'claim');
    return factualClaims.length > 0 && factualClaims.every((sentence) => sentence.status === 'ok' && sentence.receipt_ids.length > 0);
  }).length;
  const reached = (lead: LeadView, stage: string) => lead.transitions.some((t) => t.to_stage === stage);
  const replies = leads.filter((l) => reached(l, 'Replied')).length;

  const segment = (key: (l: LeadView) => string): SegmentRow[] => {
    const rows = new Map<string, SegmentRow>();
    for (const l of leads) {
      const name = key(l);
      const row = rows.get(name) ?? { segment: name, matched: 0, contacted: 0, replied: 0 };
      row.matched++;
      if (reached(l, 'Contacted')) row.contacted++;
      if (reached(l, 'Replied')) row.replied++;
      rows.set(name, row);
    }
    return [...rows.values()].sort((a, b) => b.matched - a.matched || a.segment.localeCompare(b.segment));
  };
  const variants: VariantMetric[] = (['A', 'B'] as const).map((variant) => {
    const rows = messages.filter((m) => m.variant === variant);
    const sentRows = rows.filter((m) => m.status === 'sent');
    const outcome = (message: (typeof sentRows)[number], stage: 'Replied' | 'Meeting Booked') =>
      leads.find((lead) => lead.id === message.lead_id)?.transitions.some((transition) => transition.to_stage === stage) ?? false;
    const replied = sentRows.filter((m) => outcome(m, 'Replied')).length;
    const meetings = sentRows.filter((m) => outcome(m, 'Meeting Booked')).length;
    return {
      variant,
      channel: variant === 'A' ? 'email' : 'linkedin',
      drafted: rows.length,
      sent: sentRows.length,
      replied,
      meetings,
      reply_rate: sentRows.length ? replied / sentRows.length : null,
    };
  });

  return {
    claims_drafted: claims.length,
    claims_struck: struck,
    catch_rate: claims.length ? struck / claims.length : null,
    proof_rate: sent ? proved / sent : null,
    declined: {
      not_yet: leads.filter((l) => l.state === 'not_yet').length,
      disqualified: leads.filter((l) => l.state === 'disqualified').length,
    },
    messages_sent: sent,
    replies,
    reply_rate: sent ? replies / sent : null,
    meetings: leads.filter((l) => l.stage === 'Meeting Booked' || l.stage === 'Closed').length,
    by_industry: segment((l) => l.company.industry ?? 'Unknown'),
    by_tier: segment((l) => `Tier ${l.tier}`).sort((a, b) => a.segment.localeCompare(b.segment)),
    variants,
    usage: {
      leads_enriched: countOps('enrich'),
      drafts_generated: countOps('draft'),
      outreach_sent: countOps('send'),
      graph_queries: getSetting<number>('graph_queries', 0),
    },
  };
}

export function buildSnapshot(running: string | null): Snapshot {
  const leads = buildLeads();
  const bal = balance();
  const tasks = listTasks();
  // The gate is closed when a task is blocked for credits. Before task runs existed the lead carried this itself.
  const waiting =
    tasks.some((t) => t.status === 'blocked' && t.blocker_code === 'credits') ||
    leads.some(
      (l) =>
        l.state === 'active' &&
        l.stage === 'Matched' &&
        (l.enrich_status === 'blocked_credits' || (l.person !== null && l.message === null && bal < config.costs.draft)),
    );
  return {
    now: now().toISOString(),
    clock_offset_days: clockOffsetDays(),
    mode: { llm: llmEnabled(), model: config.model, source: config.source, flexprice: flexpriceEnabled(), webhook: Boolean(config.agentWebhook), band: bandEnabled() },
    running,
    profile: getProfile(),
    icp: currentIcp(),
    icp_versions: listIcpVersions(),
    credits: { balance: bal, costs: config.costs, ledger: recentLedger(), gated: waiting },
    leads,
    competitors: buildCompetitors(),
    metrics: buildMetrics(leads),
    activity: recentActivity(),
    tasks,
    runs: listRuns().filter((r) => tasks.some((t) => t.run_id === r.id)),
    task_messages: listTaskMessages(),
    draft_versions: listDraftVersions(),
    team: { concurrency: config.concurrency, lease_seconds: Math.round(config.leaseMs / 1000), usage: usageSummary(), band: bandStatus() },
    world: { pages: config.source === 'world' ? listWorldPages() : [], pending_batches: pendingBatches() },
  };
}

// ---------- knowledge graph: a projection of the receipts, not a second database ----------

/** Every graph traversal is counted, and metered to Flexprice when it is connected. */
function countGraphQuery(name = 'graph'): void {
  setSetting('graph_queries', getSetting<number>('graph_queries', 0) + 1);
  meterEvent('receipts.graph_query', 0, name);
}

export function buildGraph(): Graph {
  countGraphQuery();
  const profile = getProfile();
  const leads = buildLeads();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const product = 'product';
  nodes.push({ id: product, type: 'Product', label: profile?.product_name ?? 'Our product' });

  const customers = new Map<string, string>();
  for (const name of profile?.customers ?? []) {
    const id = `customer:${normalize(name)}`;
    customers.set(normalize(name), id);
    nodes.push({ id, type: 'Customer', label: name, sub: 'existing customer' });
    edges.push({ from: id, to: product, type: 'customer_of' });
  }
  for (const rival of listCompanies('competitor')) {
    nodes.push({ id: rival.id, type: 'Competitor', label: rival.name });
    edges.push({ from: rival.id, to: product, type: 'competes_with' });
  }

  for (const lead of leads) {
    const c = lead.company;
    nodes.push({ id: c.id, type: 'Company', label: c.name, sub: [c.industry, bandFor(c.headcount)].filter(Boolean).join(' · '), state: lead.state });
    if (lead.state === 'active') edges.push({ from: c.id, to: product, type: 'matched_to' });

    for (const r of lead.receipts.filter((x) => x.field === 'signal' && isTrigger(x))) {
      nodes.push({
        id: r.id,
        type: 'Signal',
        label: SIGNALS[r.signal_type].label,
        sub: r.status === 'failed' ? 'failed' : r.expired ? 'expired' : r.sign,
        state: r.live ? r.sign : 'dead',
      });
      edges.push({ from: r.id, to: c.id, type: 'has_signal', receipt_id: r.id });
    }

    if (lead.person) {
      const p = lead.person;
      const contact = lead.receipts.find((r) => r.entity_id === p.id && r.field === 'contact');
      nodes.push({ id: p.id, type: 'Person', label: p.name, sub: p.title });
      edges.push({ from: p.id, to: c.id, type: 'works_at', receipt_id: contact?.id });
      for (const r of lead.receipts.filter((x) => x.entity_id === p.id && x.field === 'previous_company')) {
        const target = customers.get(normalize(r.data.company ?? ''));
        if (target) edges.push({ from: p.id, to: target, type: 'previously_employed_at', receipt_id: r.id });
      }
      if (lead.transitions.some((t) => t.to_stage === 'Contacted')) edges.push({ from: product, to: p.id, type: 'contacted_via' });
      if (lead.transitions.some((t) => t.to_stage === 'Replied')) edges.push({ from: p.id, to: product, type: 'replied_to' });
    }
  }
  return { nodes, edges };
}

/** The one question the graph answers per lead: why this person, why now, why us. */
export function whyNow(leadId: string): WhyStep[] {
  countGraphQuery();
  const lead = buildLeads().find((l) => l.id === leadId);
  const profile = getProfile();
  if (!lead) return [];
  const steps: WhyStep[] = [];
  const c = lead.company;

  const live = lead.receipts.filter((r) => r.field === 'signal' && r.sign === 'positive' && r.live);
  const ranked = lead.score_inputs?.intent.map((i) => live.find((r) => r.id === i.receipt_id)).filter((r): r is ReceiptView => Boolean(r)) ?? live;
  for (const r of ranked.slice(0, 2)) {
    steps.push({ question: 'Why now', node: { id: r.id, type: 'Signal', label: SIGNALS[r.signal_type].label }, answer: r.claim, receipt_ids: [r.id] });
  }
  if (steps.length === 0) {
    steps.push({
      question: 'Why now',
      node: { id: 'none', type: 'Signal', label: 'No live signal' },
      answer: lead.dormant_reason ?? 'There is no live reason to contact this account.',
      receipt_ids: lead.reason_receipt_id ? [lead.reason_receipt_id] : [],
    });
  }

  const facts = lead.receipts.filter((r) => r.entity_id === c.id && ['industry', 'headcount', 'region'].includes(r.field) && r.sign === 'positive');
  steps.push({
    question: 'Why this company',
    node: { id: c.id, type: 'Company', label: c.name },
    answer: `${[c.industry, c.headcount ? `${c.headcount} people` : null, c.region].filter(Boolean).join(', ')}. Fit ${lead.fit_score} of 100.`,
    receipt_ids: facts.map((r) => r.id),
  });

  if (lead.person) {
    const p = lead.person;
    const contact = lead.receipts.filter((r) => r.entity_id === p.id && r.field === 'contact');
    steps.push({
      question: 'Why this person',
      node: { id: p.id, type: 'Person', label: p.name, sub: p.title },
      answer: `${p.title}. The closest match to the ICP personas among the people the company names publicly.`,
      receipt_ids: contact.map((r) => r.id),
    });
    const warm = profile ? warmIntro(lead.receipts, profile) : null;
    if (warm) {
      steps.push({
        question: 'Warm intro',
        node: { id: `customer:${normalize(warm.data.company)}`, type: 'Customer', label: warm.data.company },
        answer: `${firstName(p.name)} used to work at ${warm.data.company}, which is already a customer.`,
        receipt_ids: [warm.id],
      });
    }
  }

  steps.push({
    question: 'Why us',
    node: { id: 'product', type: 'Product', label: profile?.product_name ?? 'Our product' },
    answer: profile?.description.split(/(?<=[.!?])\s+/)[0] ?? '',
    receipt_ids: [],
  });
  return steps;
}

/**
 * The failure this product exists to prevent: a typical unverified AI email for the same lead.
 * The text is a fixed illustration. The verdicts are real: each sentence is checked against the lead's receipts.
 */
export function contrastEmail(leadId: string): ContrastSentence[] {
  const lead = getLead(leadId);
  if (!lead) return [];
  const company = getCompany(lead.company_id)!;
  const person = getPerson(lead.person_id);
  const receipts = leadReceipts(lead);
  const lines: [string, boolean][] = [
    [`Hi ${person ? firstName(person.name) : 'there'},`, false],
    [`Congrats on ${company.name}'s recent $50M Series C, what a milestone!`, true],
    ['I saw you are doubling the engineering team this year.', true],
    ['Loved your recent post about scaling AI infrastructure.', true],
    ['Companies like yours cut costs by 40% with us.', true],
    ['Do you have 15 minutes this week?', false],
  ];
  return lines.map(([text, factual]) => {
    if (!factual) return { text, factual, verdict: 'Not a factual claim.' };
    const loose = unsupportedFigures(text, receipts);
    return {
      text,
      factual,
      verdict: loose.length ? `No source. No receipt for this lead contains ${loose.join(' or ')}.` : 'No source. No receipt for this lead says this.',
    };
  });
}

// ---------- multi-hop questions ----------
//
// Each of these walks more than one edge, which is what a flat table of leads cannot answer
// in one step. Every row keeps the receipts that justify its edges.

export const GRAPH_QUESTIONS: { name: string; question: string; pattern: string }[] = [
  { name: 'warm_intros', question: 'Who can we reach through a company that already buys from us?', pattern: '(Person)-[previously_employed_at]->(Customer)-[customer_of]->(Product)' },
  { name: 'hiring_to_evaluation', question: 'Which open roles point at a buyer we can already name?', pattern: '(Signal: job posting)-[has_signal]->(Company)<-[works_at]-(Person)-[matched_to]->(Product)' },
  { name: 'displacement', question: 'Which accounts are locked in with a competitor, and when does that stop counting?', pattern: '(Company)-[has_signal: signed]->(Competitor)-[competes_with]->(Product)' },
  { name: 'lookalikes', question: 'Which untouched accounts show the same signal that earned a reply?', pattern: '(Company)-[replied_to]->(Product), (Company)-[has_signal]->(Signal type)<-[has_signal]-(Other company)' },
];

export function graphQuery(name: string): GraphAnswer | null {
  const spec = GRAPH_QUESTIONS.find((q) => q.name === name);
  if (!spec) return null;
  countGraphQuery(name);
  const at = now();
  const profile = getProfile();
  const product = profile?.product_name ?? 'our product';
  const leads = buildLeads();
  const rows: GraphAnswer['rows'] = [];
  const days = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - at.getTime()) / 86_400_000));

  if (name === 'warm_intros') {
    const customers = new Set((profile?.customers ?? []).map((c) => normalize(c)));
    for (const lead of leads) {
      if (!lead.person) continue;
      for (const r of lead.receipts.filter((x) => x.field === 'previous_company' && customers.has(normalize(x.data.company ?? '')))) {
        rows.push({
          path: [`${lead.person.name} (${lead.company.name})`, r.data.company, product],
          note: `${firstName(lead.person.name)} used to work at ${r.data.company}, which already runs on ${product}.`,
          receipt_ids: [r.id],
          lead_id: lead.id,
        });
      }
    }
  }

  if (name === 'hiring_to_evaluation') {
    for (const lead of leads) {
      const jobs = lead.receipts.filter((r) => r.field === 'signal' && r.signal_type === 'job_posting' && r.live);
      if (jobs.length === 0) continue;
      const contact = lead.person ? lead.receipts.find((r) => r.entity_id === lead.person!.id && r.field === 'contact') : undefined;
      for (const job of jobs) {
        rows.push({
          path: [job.data.role ?? 'Open role', lead.company.name, lead.person ? `${lead.person.name}, ${lead.person.title}` : 'no contact resolved yet', product],
          note: lead.person
            ? `The posting is ${days(job.expires_at ?? at.toISOString())} days from expiring, and the buyer is named. Stage: ${lead.stage}.`
            : `The role is open, but nobody is resolved to send to${lead.state === 'active' ? '' : ` (lead is ${lead.state.replace('_', ' ')})`}.`,
          receipt_ids: [job.id, ...(contact ? [contact.id] : [])],
          lead_id: lead.id,
        });
      }
    }
  }

  if (name === 'displacement') {
    for (const lead of leads) {
      for (const r of lead.receipts.filter((x) => x.signal_type === 'competitor_signed')) {
        const left = r.expires_at ? days(r.expires_at) : null;
        rows.push({
          path: [lead.company.name, r.data.competitor ?? 'a competitor', product],
          note: r.live
            ? `Signed with ${r.data.competitor ?? 'a competitor'}. Suppressed for ${left} more days, then reconsidered${left !== null && left <= 120 ? ': the window is closing, so this is a displacement lead to prepare' : ''}.`
            : `The signing no longer counts (${r.status === 'failed' ? 'the source could not be confirmed' : 'it expired'}). Open for a displacement approach.`,
          receipt_ids: [r.id],
          lead_id: lead.id,
        });
      }
    }
    rows.sort((a, b) => a.note.length - b.note.length);
  }

  if (name === 'lookalikes') {
    const replied = leads.filter((l) => l.transitions.some((t) => t.to_stage === 'Replied'));
    for (const winner of replied) {
      const sent = winner.messages.find((m) => m.status === 'sent');
      if (!sent) continue;
      const cited = new Set(sent.sentences.filter((x) => x.kind === 'claim' && x.status === 'ok').flatMap((x) => x.receipt_ids));
      const types = new Set(winner.receipts.filter((r) => cited.has(r.id) && r.field === 'signal').map((r) => r.signal_type));
      for (const other of leads) {
        if (other.id === winner.id || other.stage !== 'Matched') continue;
        for (const r of other.receipts.filter((x) => x.field === 'signal' && x.sign === 'positive' && x.live && types.has(x.signal_type))) {
          rows.push({
            path: [`${winner.company.name} (replied)`, SIGNALS[r.signal_type].label, other.company.name],
            note: `${other.company.name} shows the same kind of signal that earned ${winner.company.name}'s reply. State: ${other.state.replace('_', ' ')}, score ${other.score}.`,
            receipt_ids: [r.id],
            lead_id: other.id,
          });
        }
      }
    }
  }

  return { ...spec, rows };
}
