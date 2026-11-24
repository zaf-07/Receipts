import type { Lead, Message, PipelineRun, Profile, Receipt, Stage, TaskRun } from '../../shared/types';
import { STAGES } from '../../shared/constants';
import { advanceClock, now } from '../clock';
import { config } from '../config';
import { wipe } from '../db';
import { UserError } from '../errors';
import { isLive, isTrigger } from '../domain/state';
import { changed, log } from '../services/activity';
import { balance, credit } from '../services/ledger';
import { mirrorTopUp, restoreDemoWallet, syncWallet } from '../services/billing';
import { flexpriceStatus } from '../integrations/flexprice';
import { deliver } from '../services/delivery';
import { moveStage, recomputeAll } from '../services/leads';
import {
  availableCredits,
  createRun,
  creditNeed,
  enqueue,
  getRun,
  getTask,
  addTaskMessage,
  createManualTask,
  resolveReview,
  retryTask,
  setRunPhase,
  settleRuns,
  tasksWhere,
  type Outcome,
} from '../services/tasks';
import {
  currentIcp,
  getCompany,
  getLead,
  getMessage,
  getPerson,
  getProfile,
  getReceipt,
  leadReceipts,
  listCompanies,
  listIcpVersions,
  listLeads,
  listTransitions,
  messagesForLead,
  saveProfile,
  setCurrentIcp,
  updateIcpExpansions,
  updateLead,
  updateMessage,
} from '../services/store';
import { applyAfterCrawl, releaseNextBatch, seedWorld } from '../world/world';
import { clearBoard, onBandDecision, onBandNote, requestDecision, resolveDecision, say, track, type CardStep } from '../integrations/band';
import { runAnalyst } from './analyst';
import { enrichLead } from './enricher';
import { runPlanner } from './planner';
import { createPool, type Handler } from './pool';
import { readTarget, runSearch, type Target } from './researcher';
import { recheckNegatives, reviewDraft } from './skeptic';
import { scanDraft, summarise } from './security';
import { validateDraft, writeDraft } from './writer';

export { UserError };

// The orchestrator is the lead of the team. It plans, assigns and reconciles. It does no agent
// work itself, and it is the only thing that creates tasks.
//
//   Planner (one ICP run)
//   -> Researcher: one search task, then one read task per account, in parallel
//   -> Enricher: one task per active lead, in parallel
//   -> Writer: one task per enriched lead, in parallel
//   -> Skeptic: one task per draft, in parallel
//   -> Security: one scan per verified draft (links, data exposure, recipient)
//   -> Human gate: one review task per verified draft. Nothing sends without it.
//   -> Analyst: one task per outcome
//
// Workers do scoped work and return an outcome. What happens next is decided here, in onSettled.

// ---------- commands are serialised; the tasks inside them are not ----------

let running: string | null = null;
let tail: Promise<unknown> = Promise.resolve();

/** One command at a time (a discovery, a refresh). Inside a command, tasks run in parallel. */
export function exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const next = tail.then(async () => {
    running = label;
    changed();
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof UserError)) log('system', 'warn', `${label} stopped on an error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      running = null;
      changed();
    }
  });
  tail = next.catch(() => undefined);
  return next;
}

function requireSetup() {
  const profile = getProfile();
  const icp = currentIcp();
  if (!profile || !icp) throw new UserError('Complete the intake first, so there is an ICP to work from.');
  return { profile, icp };
}

// ---------- what each kind of task does ----------

const handlers: Record<'plan' | 'search' | 'read' | 'recheck' | 'enrich' | 'write' | 'verify' | 'scan' | 'learn', Handler> = {
  async plan(task) {
    const profile = getProfile();
    if (!profile) throw new Error('There is no product description to plan from.');
    const icp = await runPlanner(profile, currentIcp()?.id ?? null, task.input.goal ?? '');
    return { status: 'done', result: `ICP v${icp.version} saved with ${icp.search_plan.length} searches planned.` };
  },

  async search(task) {
    const { profile, icp } = requireSetup();
    const found = await runSearch(icp, profile, task.input.pass === 'ingest' ? 'ingest' : 'discovery');
    if (found.blocker) return { status: 'blocked', result: found.blocker, blocker: found.blocker };
    return {
      status: 'done',
      result: `${found.searches} searches run. ${found.targets.length} accounts to read, ${found.competitors} competitors recorded.`,
      receipts: found.receipts,
      data: { targets: found.targets },
    };
  },

  async read(task) {
    const { profile, icp } = requireSetup();
    const read = await readTarget(task.input.url, icp, profile);
    const wrote = read.receipts.length;
    if (wrote > 0 || read.rejected > 0) {
      log(
        'researcher',
        read.rejected ? 'warn' : 'info',
        `${read.name}: ${wrote} new receipt${wrote === 1 ? '' : 's'} from ${read.pages} page${read.pages === 1 ? '' : 's'}` +
          (read.rejected ? `, ${read.rejected} claim${read.rejected === 1 ? '' : 's'} rejected for having no matching source text` : '') +
          '.',
        { lead_id: read.lead_id },
      );
    }
    return {
      status: 'done',
      result: read.skipped ?? `${read.pages} page${read.pages === 1 ? '' : 's'} read, ${wrote} new receipt${wrote === 1 ? '' : 's'}${read.rejected ? `, ${read.rejected} rejected` : ''}.`,
      receipts: read.receipts,
      data: { lead_id: read.lead_id },
    };
  },

  async recheck() {
    const disproved = await recheckNegatives();
    return { status: 'done', result: disproved ? `${disproved} reason${disproved === 1 ? '' : 's'} to hold back no longer check out.` : 'Every reason to hold back still checks out.' };
  },

  async enrich(task) {
    const { icp } = requireSetup();
    const lead = task.lead_id ? getLead(task.lead_id) : null;
    if (!lead) throw new Error('The lead no longer exists.');
    // Safe to run twice: a lead that already has its contact is left alone.
    if (lead.person_id) return { status: 'done', result: 'Contact already resolved.', receipts: receiptIds(lead.person_id) };
    const result = await enrichLead(lead, icp);
    if (result === 'blocked_credits') return { status: 'blocked', result: 'Not enough credits to enrich.', blocker_code: 'credits' };
    const after = getLead(lead.id)!;
    const person = getPerson(after.person_id);
    if (result === 'unresolved') return { status: 'done', result: `Contact unresolved. ${after.enrich_note ?? ''}`.trim() };
    return {
      status: 'done',
      result: `${person?.name}, ${person?.title}. Email ${result === 'resolved' ? 'found on the page' : 'guessed, marked low confidence'}.`,
      receipts: receiptIds(after.person_id),
    };
  },

  async write(task) {
    const { profile, icp } = requireSetup();
    const lead = task.lead_id ? getLead(task.lead_id) : null;
    if (!lead) throw new Error('The lead no longer exists.');
    // Safe to run twice: if this round's drafts exist, they are the result.
    if (!needsDraft(lead)) {
      const waiting = messagesForLead(lead.id).filter((m) => m.status === 'draft');
      return { status: 'done', result: 'Drafts for this lead already exist.', messages: waiting.map((m) => m.id), inputs: citedReceipts(waiting) };
    }
    if (lead.state !== 'active') return { status: 'done', result: 'No live reason left, so nothing was written.' };
    const drafts = await writeDraft(lead, icp, profile);
    if (drafts === 'blocked_credits') return { status: 'blocked', result: 'Not enough credits to draft.', blocker_code: 'credits' };
    if (!drafts) return { status: 'done', result: 'No live trigger to write about, so nothing was written.' };
    return {
      status: 'done',
      result: `${drafts.length} variant${drafts.length === 1 ? '' : 's'} drafted: ${drafts.map((m) => `${m.channel} ${m.variant}`).join(', ')}.`,
      messages: drafts.map((m) => m.id),
      inputs: citedReceipts(drafts),
    };
  },

  async verify(task) {
    const message = await reviewDraft(task.input.message_id);
    if (!message) throw new Error('The draft no longer exists.');
    const claims = message.sentences.filter((s) => s.kind === 'claim');
    const struck = claims.filter((s) => s.status === 'struck').length;
    return {
      status: 'done',
      result:
        `${claims.length - struck} of ${claims.length} claim${claims.length === 1 ? '' : 's'} verified against the live page` +
        (struck ? `, ${struck} struck` : '') +
        (message.status === 'blocked' ? '. Draft blocked.' : '. Ready for a person.'),
      messages: [message.id],
      receipts: citedReceipts([message]),
    };
  },

  async scan(task) {
    const message = getMessage(task.input.message_id);
    if (!message) throw new Error('The draft no longer exists.');
    if (message.status !== 'pending_review') return { status: 'done', result: `Nothing to scan: the draft is ${message.status.replace('_', ' ')}.`, messages: [message.id] };
    const lead = getLead(message.lead_id);
    const company = lead ? getCompany(lead.company_id) : null;
    const findings = scanDraft(message, {
      company,
      person: lead ? getPerson(lead.person_id) : null,
      cited: citedLive(message),
      otherAccounts: listCompanies('prospect').map((c) => c.name),
    });
    const blocking = findings.filter((f) => f.severity === 'block');
    if (blocking.length) {
      updateMessage(message.id, { status: 'blocked', block_reason: `Security: ${blocking[0].message}` });
      log('security', 'block', `Draft for ${company?.name ?? 'a lead'} blocked by the security scan: ${blocking.map((f) => f.message).join(' ')}`, { lead_id: message.lead_id, ref: message.id });
    } else {
      log('security', 'handoff', `${company?.name ?? 'A lead'}: ${channelName(message)} ${summarise(findings).replace(/^Cleared/, 'cleared')} Waiting for a human.`, { lead_id: message.lead_id, ref: message.id });
    }
    return { status: 'done', result: summarise(findings), messages: [message.id], receipts: citedReceipts([message]), data: { findings } };
  },

  async learn(task) {
    if (!task.lead_id) throw new Error('No lead to learn from.');
    const next = runAnalyst(task.lead_id);
    return { status: 'done', result: next ? `ICP v${next.version} saved from this outcome.` : 'Nothing to learn from this outcome.' };
  },
};

const receiptIds = (entityId: string | null) => (entityId ? leadReceipts({ company_id: '', person_id: entityId }).map((r) => r.id) : []);
const citedReceipts = (messages: Message[]) => [...new Set(messages.flatMap((m) => m.sentences.flatMap((s) => s.receipt_ids)))];
const citedLive = (message: Message): Receipt[] =>
  [...new Set(message.sentences.filter((s) => s.kind === 'claim' && s.status === 'ok').flatMap((s) => s.receipt_ids))]
    .map((id) => getReceipt(id))
    .filter((r): r is Receipt => r !== null);

const pool = createPool({ handlers, concurrency: config.concurrency, leaseMs: config.leaseMs, onSettled, onBlocked });

/** What the header shows: the command in progress, or simply that agents are still working. */
export const currentRun = () => running ?? (pool.busy() ? 'Agents working' : null);

/** Wake the pool. Called on a timer so expired leases are taken back even when nothing else happens. */
export function wake(): void {
  pool.kick();
}

async function dispatch(): Promise<void> {
  await pool.idle();
  reconcileGate();
  settleRuns();
}

// ---------- planning: the orchestrator decides what happens next ----------

function needsDraft(lead: Lead): boolean {
  const messages = messagesForLead(lead.id);
  if (messages.length === 0) return true;
  if (messages.some((message) => message.status !== 'blocked' && message.status !== 'rejected')) return false;
  // A blocked or rejected draft is only retried when new evidence has arrived since.
  const at = now();
  const newest = messages[messages.length - 1];
  return leadReceipts(lead).some((r) => r.sign === 'positive' && isTrigger(r) && isLive(r, at) && r.seen_at > newest.created_at);
}

const companyName = (lead: Lead) => getCompany(lead.company_id)?.name ?? 'this account';
const channelName = (message: Message) => (message.channel === 'linkedin' ? 'LinkedIn note' : 'email');

function planWrite(lead: Lead, runId: string, after: string[], prepaid: boolean): void {
  const person = getPerson(lead.person_id);
  enqueue({
    run_id: runId,
    kind: 'write',
    agent: 'writer',
    lead_id: lead.id,
    title: `Draft outreach to ${person?.name ?? 'the contact'} at ${companyName(lead)}`,
    detail: 'Every factual sentence must cite a live receipt. Connectives may not state facts.',
    priority: lead.score,
    depends_on: after,
    // One writing round per batch of evidence: a new round only starts once earlier drafts are settled.
    key: `write:${lead.id}:${messagesForLead(lead.id).length}`,
    // The enrichment task already held the cost of this draft, so the lead it started can be finished.
    reserved_credits: prepaid ? config.costs.draft : 0,
    max_attempts: 2,
  });
}

function planVerify(message: Message, runId: string, after: string[]): void {
  const lead = getLead(message.lead_id);
  const earlier = tasksWhere("kind = 'verify'").filter((t) => t.input.message_id === message.id).length;
  enqueue({
    run_id: runId,
    kind: 'verify',
    agent: 'skeptic',
    lead_id: message.lead_id,
    title: `Re-open the sources behind the ${channelName(message)} for ${lead ? companyName(lead) : 'a lead'}`,
    detail: 'Fetch each cited page again. Strike any claim whose quoted words are gone.',
    priority: lead?.score ?? 0,
    depends_on: after,
    input: { message_id: message.id, channel: message.channel },
    input_receipt_ids: citedReceipts([message]),
    key: `verify:${message.id}:${earlier}`,
    max_attempts: 2,
  });
}

function planScan(message: Message, runId: string, after: string[]): void {
  const lead = getLead(message.lead_id);
  const earlier = tasksWhere("kind = 'scan'").filter((t) => t.input.message_id === message.id).length;
  enqueue({
    run_id: runId,
    kind: 'scan',
    agent: 'security',
    lead_id: message.lead_id,
    title: `Scan the ${channelName(message)} for ${lead ? companyName(lead) : 'a lead'} before it reaches a person`,
    detail: 'Check outbound links, internal data in the copy, other prospects named, and that the recipient is at the target company.',
    priority: lead?.score ?? 0,
    depends_on: after,
    input: { message_id: message.id, channel: message.channel },
    input_receipt_ids: citedReceipts([message]),
    key: `scan:${message.id}:${earlier}`,
    max_attempts: 2,
  });
}

/** A lead's outreach is one card on the Band room's task board. Each agent reports on it as the work reaches it. */
function card(lead: Lead, steps: CardStep[]): void {
  track(cardOf(lead), `Tier ${lead.tier}, score ${Math.round(lead.score)}. Find the contact, draft only from receipts, re-open every source, scan the draft, then a person decides.`, steps);
}
const cardOf = (lead: Lead) => `Outreach to ${companyName(lead)}`;

/** Every active lead gets the next task it needs. Idempotent: planning twice creates nothing new. */
function planLeadWork(runId: string): void {
  for (const lead of listLeads()) {
    if (lead.state !== 'active' || lead.stage !== 'Matched') continue;
    if (!lead.person_id) {
      if (lead.enrich_status !== 'pending' && lead.enrich_status !== 'blocked_credits') continue;
      enqueue({
        run_id: runId,
        kind: 'enrich',
        agent: 'enricher',
        lead_id: lead.id,
        title: `Find the right contact at ${companyName(lead)}`,
        detail: 'Pick the closest match to the ICP personas. Mark a guessed email as a guess.',
        priority: lead.score,
        key: `enrich:${lead.id}`,
        max_attempts: 2,
      });
      card(lead, [{ from: 'enricher', status: 'in_progress', doing: `Finding the right contact at ${companyName(lead)}` }]);
    } else if (needsDraft(lead)) {
      planWrite(lead, runId, [], false);
    }
  }
}

/** Research is a barrier: enrichment starts only once every search and read task of the run has settled. */
function afterResearch(runId: string): void {
  const run = getRun(runId);
  if (!run || run.phase === 'planned' || (run.kind !== 'discovery' && run.kind !== 'ingest')) return;
  if (tasksWhere("run_id = ? AND kind IN ('search', 'read', 'recheck') AND status IN ('queued', 'running')", runId).length > 0) return;
  setRunPhase(runId, 'planned');

  if (run.kind === 'discovery' && config.source === 'world') {
    // The world keeps moving between the Researcher's visit and the Skeptic's.
    for (const change of applyAfterCrawl()) log('world', 'info', `Demo world: ${change} after it was read.`, { run_id: runId });
  }
  recomputeAll({ announce: run.kind === 'discovery' });

  const research = tasksWhere("run_id = ? AND kind IN ('search', 'read')", runId);
  const receipts = research.reduce((n, t) => n + t.output_receipt_ids.length, 0);
  const failed = research.filter((t) => t.status === 'failed').length;
  log(
    'researcher',
    'handoff',
    `${receipts} new receipt${receipts === 1 ? '' : 's'} from ${research.filter((t) => t.kind === 'read').length} accounts` +
      (failed ? `, ${failed} read${failed === 1 ? '' : 's'} failed` : '') +
      '. Every lead has a live receipt or a dormant reason. Handing active leads to the Enricher, one task each.',
    { run_id: runId },
  );
  planLeadWork(runId);
  const all = listLeads();
  const ready = all.filter((l) => l.state === 'active' && l.stage === 'Matched');
  say(
    'researcher',
    'enricher',
    `${ready.length} lead${ready.length === 1 ? ' has' : 's have'} a live reason to contact: ${ready.slice(0, 8).map(companyName).join(', ') || 'none'}. ${all.length - ready.length} are held back with their reasons. Each active lead needs a contact.`,
  );
}

/** Keep the human gate in step with the drafts: one open review task per draft that is waiting for a person. */
function syncGate(message: Message, runId?: string): TaskRun | null {
  const open = tasksWhere("kind = 'approve' AND status = 'review'").filter((t) => t.input.message_id === message.id);
  if (message.status !== 'pending_review') {
    for (const t of open) resolveReview(t.id, `Withdrawn: the draft is ${message.status.replace('_', ' ')}.`);
    return null;
  }
  if (open.length > 0) return open[0];
  const lead = getLead(message.lead_id);
  const person = lead ? getPerson(lead.person_id) : null;
  const earlier = tasksWhere("kind = 'approve'").filter((t) => t.input.message_id === message.id).length;
  return enqueue({
    run_id: runId ?? createRun('outcome', 'Human review').id,
    kind: 'approve',
    agent: 'human',
    status: 'review',
    lead_id: message.lead_id,
    title: `Approve, edit or reject the ${channelName(message)} to ${person?.name ?? 'the contact'}${lead ? ` at ${companyName(lead)}` : ''}`,
    detail: 'Nothing sends without this decision.',
    priority: lead?.score ?? 0,
    input: { message_id: message.id, channel: message.channel },
    input_receipt_ids: [...new Set(message.sentences.filter((s) => s.kind === 'claim' && s.status === 'ok').flatMap((s) => s.receipt_ids))],
    key: `approve:${message.id}:${earlier}`,
  });
}

/** Drafts can stop being sendable on their own (a receipt expires). Close the review tasks that no longer apply. */
function reconcileGate(): void {
  for (const task of tasksWhere("kind = 'approve' AND status = 'review'")) {
    const message = getMessage(task.input.message_id);
    if (!message || message.status !== 'pending_review') resolveReview(task.id, `Withdrawn: the draft is ${message ? message.status.replace('_', ' ') : 'gone'}.`);
  }
}

/** Called by the pool after every task settles. This is the only place follow-up work is created. */
function onSettled(task: TaskRun, outcome: Outcome | null): void {
  switch (task.kind) {
    case 'plan': {
      if (task.input.start_discovery === 'true') {
        const run = getRun(task.run_id);
        if (run) startResearch(run, 'discovery', [task.id]);
      }
      break;
    }
    case 'search': {
      const targets = (outcome?.data?.targets as Target[] | undefined) ?? [];
      for (const target of targets) {
        enqueue({
          run_id: task.run_id,
          kind: 'read',
          agent: 'researcher',
          title: `Read ${target.name}`,
          detail: 'Read this one account and write a receipt for every fact it can quote.',
          depends_on: [task.id],
          input: { url: target.url, name: target.name },
          key: `read:${task.run_id}:${target.url}`,
          max_attempts: 2,
        });
      }
      afterResearch(task.run_id);
      break;
    }
    case 'read':
    case 'recheck':
      afterResearch(task.run_id);
      break;
    case 'enrich': {
      const lead = task.lead_id ? getLead(task.lead_id) : null;
      if (outcome?.status === 'done' && lead?.person_id && lead.state === 'active') {
        planWrite(lead, task.run_id, [task.id], true);
        say('enricher', 'writer', `${companyName(lead)}: ${task.result} Contact receipts: ${task.output_receipt_ids.join(', ') || 'none'}. Yours to draft.`);
        card(lead, [
          { from: 'enricher', status: 'completed', comment: task.result ?? 'Contact resolved.' },
          { from: 'writer', status: 'in_progress', doing: 'Drafting from receipts only' },
        ]);
      } else if (lead && outcome?.status === 'done') {
        card(lead, [{ from: 'enricher', status: 'blocked', comment: lead.enrich_note ?? task.result ?? 'No contact could be resolved, and none was guessed.' }]);
      }
      break;
    }
    case 'write': {
      for (const id of task.output_message_ids) {
        const message = getMessage(id);
        if (message) planVerify(message, task.run_id, [task.id]);
      }
      const lead = task.lead_id ? getLead(task.lead_id) : null;
      if (lead && task.output_message_ids.length) {
        say('writer', 'skeptic', `${companyName(lead)}: ${task.result} The claims cite ${task.input_receipt_ids.join(', ')}. Re-open every source before a person sees this.`);
        card(lead, [
          { from: 'writer', status: 'completed', comment: task.result ?? 'Drafted.' },
          { from: 'skeptic', status: 'in_progress', doing: 'Re-opening every source behind the draft' },
        ]);
      }
      break;
    }
    case 'verify': {
      // A verified draft goes to the Security agent before it can reach a person.
      const message = getMessage(task.input.message_id);
      if (!message) break;
      const lead = getLead(message.lead_id);
      const about = `${lead ? companyName(lead) : 'A lead'}, ${channelName(message)}`;
      if (message.status === 'pending_review') {
        planScan(message, task.run_id, [task.id]);
        say('skeptic', 'security', `${about}: ${task.result} Yours to scan before it reaches a person.`);
        if (lead) {
          card(lead, [
            { from: 'skeptic', status: 'completed', comment: `${channelName(message)}: ${task.result}` },
            { from: 'security', status: 'in_progress', doing: 'Scanning the verified draft' },
          ]);
        }
      } else {
        syncGate(message, task.run_id);
        say('skeptic', 'human', `${about}: ${task.result}`);
        if (lead && !messagesForLead(lead.id).some((m) => m.status === 'pending_review')) {
          card(lead, [{ from: 'skeptic', status: 'blocked', comment: `${channelName(message)}: ${task.result}` }]);
        }
      }
      break;
    }
    case 'scan': {
      const message = getMessage(task.input.message_id);
      if (!message) break;
      syncGate(message, task.run_id);
      const lead = getLead(message.lead_id);
      const person = lead ? getPerson(lead.person_id) : null;
      const about = `${lead ? companyName(lead) : 'A lead'}: the ${channelName(message)} to ${person?.name ?? 'the contact'}`;
      if (message.status === 'pending_review') {
        const claims = message.sentences.filter((s) => s.kind === 'claim' && s.status === 'ok');
        if (lead) card(lead, [{ from: 'security', status: 'in_review', doing: 'Waiting for a person to decide', comment: `${channelName(message)}: ${task.result}` }]);
        requestDecision('security', message.id, `${about} is verified and cleared. ${claims.length} claim${claims.length === 1 ? ' rests' : 's rest'} on receipts ${[...new Set(claims.flatMap((s) => s.receipt_ids))].join(', ')}. ${task.result}`, lead ? cardOf(lead) : undefined);
      } else {
        say('security', 'human', `${about} did not pass. ${task.result}`);
        if (lead && !messagesForLead(lead.id).some((m) => m.status === 'pending_review')) {
          card(lead, [{ from: 'security', status: 'blocked', comment: `${channelName(message)}: ${task.result}` }]);
        }
      }
      break;
    }
    case 'learn':
      say('analyst', 'planner', `${task.title}. ${task.result}`);
      break;
    default:
      break;
  }
  settleRuns();
}

/** A blocked task is a real state with a reason, shown on the board and projected onto the lead. */
function onBlocked(tasks: TaskRun[]): void {
  for (const task of tasks) {
    const held = task.lead_id ? getLead(task.lead_id) : null;
    if (held) card(held, [{ from: task.kind === 'write' ? 'writer' : 'enricher', status: 'blocked', comment: `Credit gate: this needs ${creditNeed(task.kind)} credits and ${Math.max(0, availableCredits())} are free.` }]);
    if (task.kind === 'enrich' && task.lead_id) {
      updateLead(task.lead_id, {
        enrich_status: 'blocked_credits',
        enrich_note: `Enrichment holds ${creditNeed('enrich')} credits (contact plus draft). Top up to continue.`,
      });
    }
  }
  const first = tasks[0];
  log(
    'ledger',
    'block',
    `Credit gate: ${tasks.length} task${tasks.length === 1 ? ' is' : 's are'} on hold. "${first.title}" needs ${creditNeed(first.kind)} credits and ${Math.max(0, availableCredits())} are free. Top up to continue.`,
    { lead_id: first.lead_id, task_id: first.id, run_id: first.run_id },
  );
}

// ---------- commands ----------

export function intake(profile: Profile) {
  return exclusive('Planning', async () => {
    saveProfile(profile);
    const run = createRun('intake', `Plan the ICP for ${profile.product_name}`);
    const task = enqueue({
      run_id: run.id,
      kind: 'plan',
      agent: 'planner',
      title: 'Turn the product description into an ICP and a search plan',
      detail: 'Every ICP field carries a confidence. Propose two adjacent segments.',
      max_attempts: 2,
    });
    await dispatch();
    const done = getTask(task.id)!;
    if (done.status !== 'done') throw new UserError(`The Planner could not finish: ${done.error ?? done.blocker ?? 'no reason recorded'}`);
    recomputeAll();
    const icp = currentIcp()!;
    say('planner', 'researcher', `ICP v${icp.version} for ${profile.product_name} is ready: ${icp.fields.industries.map((i) => i.value).join(', ')}. ${icp.search_plan.length} searches are planned. Yours to run.`);
    return icp;
  });
}

/**
 * Begin an executable GTM goal from the Agent team screen. The goal always starts with the
 * Planner; after it has focused the ICP and search plan, the orchestrator fans the work out to
 * the other specialists. This is deliberately different from a manual task card.
 */
export function startGoal(goal: string) {
  const objective = goal.trim().slice(0, 1200);
  if (objective.length < 12) throw new UserError('Describe the outcome you want in a little more detail.');
  requireSetup();
  return exclusive('Starting goal', async () => {
    const run = createRun('discovery', objective);
    const task = enqueue({
      run_id: run.id,
      kind: 'plan',
      agent: 'planner',
      title: 'Turn the requested outcome into an ICP and search plan',
      detail: 'Focus the plan on the operator goal, then hand the work to Researcher. Evidence requirements still apply.',
      input: { goal: objective, start_discovery: 'true' },
      max_attempts: 2,
    });
    log('human', 'handoff', `Asked the Orchestrator to start: "${objective}"`, { task_id: task.id, run_id: run.id });
    await dispatch();
    return getRun(run.id)!;
  });
}

/** Accept or dismiss an adjacent segment. Accepted segments widen the fit score. */
export function decideExpansion(expansionId: string, decision: 'accepted' | 'dismissed' | 'proposed'): void {
  const icp = currentIcp();
  if (!icp) throw new UserError('There is no ICP yet.');
  const target = icp.expansions.find((e) => e.id === expansionId);
  if (!target) throw new UserError('That segment is not part of the current ICP.');
  updateIcpExpansions(icp.id, icp.expansions.map((e) => (e.id === expansionId ? { ...e, status: decision } : e)));
  log('human', 'info', `${decision === 'accepted' ? 'Accepted' : decision === 'dismissed' ? 'Dismissed' : 'Reopened'} the adjacent segment "${target.name}".`, { ref: icp.id });
  const moved = recomputeAll();
  if (decision === 'accepted') log('planner', 'info', `Fit widened to include ${target.industries.join(', ')}. Leads rescored${moved ? `, ${moved} changed state` : ''}.`);
  changed();
}

export function activateIcp(id: string): void {
  if (!listIcpVersions().some((v) => v.id === id)) throw new UserError('Unknown ICP version.');
  setCurrentIcp(id);
  recomputeAll();
  log('human', 'info', `Switched the active ICP to v${currentIcp()!.version}. Leads rescored.`, { ref: id });
  changed();
}

function startResearch(run: PipelineRun, pass: 'discovery' | 'ingest', after: string[] = []): void {
  enqueue({
    run_id: run.id,
    kind: 'search',
    agent: 'researcher',
    title: pass === 'ingest' ? 'Search again for new signals' : 'Run the search plan and choose the accounts to read',
    detail: 'Returns the accounts worth a read task. Competitors are recorded here so readers know their names.',
    depends_on: after,
    input: { pass },
    max_attempts: 2,
  });
}

export function discover() {
  requireSetup();
  return exclusive('Discovery', async () => {
    requireSetup();
    startResearch(createRun('discovery', 'Discovery'), 'discovery');
    await dispatch();
  });
}

/** Refresh signals. This is the continuous ingestion: new pages can wake a dormant lead. */
export function ingest() {
  requireSetup();
  return exclusive('Ingesting signals', async () => {
    requireSetup();
    const run = createRun('ingest', 'Signal refresh');
    if (config.source === 'world') {
      const published = releaseNextBatch();
      if (published.length) log('world', 'info', `Demo world: ${published.map((p) => `${p.company} published "${p.title}"`).join('; ')}.`, { run_id: run.id });
      else log('world', 'info', 'Demo world: no new pages were published since the last refresh.', { run_id: run.id });
    }
    enqueue({
      run_id: run.id,
      kind: 'recheck',
      agent: 'skeptic',
      title: 'Re-check every reason to hold a lead back',
      detail: 'Holding back is also a claim. A negative receipt whose source is gone stops suppressing.',
      max_attempts: 2,
    });
    startResearch(run, 'ingest');
    await dispatch();
  });
}

/** Pick up held work: tasks that were waiting for credits, and leads that still need a step. */
export function resume() {
  requireSetup();
  return exclusive('Continuing', async () => {
    requireSetup();
    planLeadWork(createRun('resume', 'Continue held work').id);
    await dispatch();
  });
}

function verifyNow(messageId: string, label: string) {
  return exclusive('Re-verifying', async () => {
    const message = getMessage(messageId);
    if (!message) throw new UserError('Unknown draft.');
    const lead = getLead(message.lead_id);
    // A blocked draft that still has standing claims is allowed back in front of the Skeptic.
    if (message.status === 'blocked' && message.sentences.some((s) => s.kind === 'claim' && s.status === 'ok')) updateMessage(message.id, { status: 'draft' });
    log('skeptic', 'start', `Re-opening every source behind the draft for ${lead ? companyName(lead) : 'this lead'}.`, { lead_id: message.lead_id, ref: message.id });
    planVerify(getMessage(messageId)!, createRun('reverify', label).id, []);
    await dispatch();
    return getMessage(messageId);
  });
}

/** Run the Skeptic again on a draft, on request. Used to show a source going stale. */
export function reverify(messageId: string) {
  if (!getMessage(messageId)) throw new UserError('Unknown draft.');
  return verifyNow(messageId, 'Re-verify on request');
}

// ---------- the human gate ----------

/**
 * Approve a draft. A person closes the review task for this draft, and that is what releases
 * the send. The delivery service checks for the open review task itself, so there is no other way in.
 */
export function approve(messageId: string, reviewer: string): void {
  const message = getMessage(messageId);
  if (!message) throw new UserError('Unknown draft.');
  if (message.status !== 'pending_review') throw new UserError(`This draft is ${message.status.replace('_', ' ')} and cannot be approved.`);
  recomputeAll();
  const fresh = getMessage(messageId)!;
  if (tasksWhere("kind = 'scan' AND status IN ('queued', 'running')").some((t) => t.input.message_id === messageId)) {
    throw new UserError('The security scan for this draft has not finished yet.');
  }
  // Drafts written before task runs existed have no review task yet. The orchestrator opens one.
  // Delivery repeats the security check itself, so this cannot be used to skip it.
  const gate = syncGate(fresh);
  if (!gate) {
    const lead = getLead(fresh.lead_id)!;
    throw new UserError(`${companyName(lead)} no longer has a live reason to contact: ${lead.dormant_reason ?? fresh.block_reason}`);
  }
  deliver(messageId, gate.id, reviewer);
  resolveReview(gate.id, `Approved by ${reviewer}. Send logged.`, [messageId]);
  resolveDecision(messageId, `${messageId} approved by ${reviewer}. The send to ${companyName(getLead(fresh.lead_id)!)} is logged and the card moved to Contacted.`);
  decided(fresh.lead_id, `${channelName(fresh)} approved by ${reviewer}. Send logged.`);
  settleRuns();
  changed();
}

/** A person decided on one draft. The lead's card stays in review while another of its drafts still waits. */
function decided(leadId: string, what: string): void {
  const lead = getLead(leadId);
  if (!lead) return;
  const waiting = messagesForLead(leadId).some((m) => m.status === 'pending_review');
  card(lead, [{ from: 'security', status: waiting ? 'in_review' : 'completed', comment: what, ...(waiting ? { doing: 'Waiting for a person to decide on the other draft' } : {}) }]);
}

export function reject(messageId: string, reviewer: string, note: string): void {
  const message = getMessage(messageId);
  if (!message) throw new UserError('Unknown draft.');
  if (message.status !== 'pending_review' && message.status !== 'blocked') throw new UserError('Only a draft waiting for review can be rejected.');
  const gate = tasksWhere("kind = 'approve' AND status = 'review'").find((t) => t.input.message_id === messageId);
  updateMessage(message.id, { status: 'rejected', reviewer, block_reason: note || 'Rejected by the reviewer.' });
  if (gate) resolveReview(gate.id, `Rejected by ${reviewer}${note ? `: ${note}` : ''}. Nothing was sent.`);
  resolveDecision(messageId, `${messageId} rejected by ${reviewer}${note ? `: ${note}` : ''}. Nothing was sent.`);
  decided(message.lead_id, `${channelName(message)} rejected by ${reviewer}${note ? `: ${note}` : ''}. Nothing was sent.`);
  const lead = getLead(message.lead_id);
  log('human', 'info', `${reviewer} rejected the draft for ${lead ? companyName(lead) : 'a lead'}${note ? `: ${note}` : ''}. Nothing was sent.`, {
    lead_id: message.lead_id,
    ref: message.id,
    task_id: gate?.id,
    run_id: gate?.run_id,
  });
  settleRuns();
  changed();
}

/**
 * Edit a draft. Sentences can be reworded or removed, never left factual and uncited:
 * the format check runs on the result and the Skeptic reviews it again. The edit is a new
 * version of the draft; the versions before it are kept.
 */
export function editDraft(messageId: string, subject: string, kept: { index: number; text: string }[], reviewer: string) {
  const message = getMessage(messageId);
  if (!message) throw new UserError('Unknown draft.');
  if (message.status !== 'pending_review') throw new UserError('Only a draft waiting for review can be edited.');
  const lead = getLead(message.lead_id)!;

  const sentences = kept.map(({ index, text }) => {
    const original = message.sentences[index];
    if (!original) throw new UserError('That sentence is not part of this draft.');
    const trimmed = text.trim();
    if (original.status === 'struck') return original;
    return trimmed === original.text ? original : { ...original, text: trimmed, edited: true };
  });
  const allowed = new Map(leadReceipts(lead).map((r) => [r.id, r]));
  const errors = validateDraft({ subject, sentences: sentences.filter((s) => s.status === 'ok') }, allowed);
  if (errors.length) throw new UserError(errors[0]);

  updateMessage(message.id, { subject: subject.trim(), sentences, reviewer }, { author: 'human', note: `Edited by ${reviewer}` });
  log('human', 'info', `${reviewer} edited the draft for ${companyName(lead)}. Sending it back through the Skeptic.`, { lead_id: lead.id, ref: message.id });
  return verifyNow(message.id, 'Re-verify after an edit');
}

/** An outcome arrived. The Analyst gets one task for it. */
function planLearning(leadId: string): void {
  const lead = getLead(leadId);
  if (!lead) return;
  const replies = listTransitions().filter((t) => t.lead_id === leadId && t.to_stage === 'Replied').length;
  enqueue({
    run_id: createRun('outcome', `${companyName(lead)} replied`).id,
    kind: 'learn',
    agent: 'analyst',
    lead_id: leadId,
    title: `Learn from ${companyName(lead)}'s reply`,
    detail: 'Find which receipts the email rested on and reweight those signal types. Save the change as a new ICP version.',
    key: `learn:${leadId}:${replies}`,
    max_attempts: 2,
  });
  pool.kick();
}

/** A manual stage move by a rep. Marking a reply hands the outcome to the Analyst. */
export function moveLead(leadId: string, to: Stage, actor: string, note: string | null): void {
  if (!STAGES.includes(to)) throw new UserError('Unknown stage.');
  const lead = getLead(leadId);
  if (!lead) throw new UserError('Unknown lead.');
  const from = lead.stage;
  if (!moveStage(leadId, to, 'rep', actor, note)) return;
  log('human', 'info', `${actor} moved ${companyName(lead)} from ${from} to ${to}${note ? `: ${note}` : ''}.`, { lead_id: leadId });
  if (to === 'Replied') planLearning(leadId);
  changed();
}

/**
 * Process a reply received by a mail provider. This is deliberately provider-neutral:
 * adapters only need to resolve their message to our message id and post the reply text.
 * A booking-intent reply passes through Replied first so the stage history remains complete.
 */
export function receiveInboundReply(messageId: string, replyText: string, source = 'inbound webhook'): { stage: Stage; booking_intent: boolean } {
  const message = getMessage(messageId);
  if (!message) throw new UserError('Unknown message.');
  if (message.status !== 'sent') throw new UserError('Inbound replies are accepted only for a sent message.');

  const lead = getLead(message.lead_id)!;
  if (lead.stage !== 'Contacted' && lead.stage !== 'Replied' && lead.stage !== 'Meeting Booked') {
    throw new UserError(`This lead is ${lead.stage}, so an inbound reply cannot advance it.`);
  }

  const bookingIntent = /\b(book(?:ing|ed)?|schedule|calendar|meet(?:ing)?|demo|available|availability)\b/i.test(replyText);
  const company = companyName(lead);
  const summary = replyText.replace(/\s+/g, ' ').trim().slice(0, 240);
  const note = summary ? `${source}: ${summary}` : `${source}: reply received.`;

  if (lead.stage === 'Contacted') {
    moveStage(lead.id, 'Replied', 'agent', 'Inbound webhook', note);
    log('system', 'handoff', `${company} replied${bookingIntent ? ' with booking intent' : ''}. Pipeline moved to Replied. Handing the outcome to the Analyst.`, {
      lead_id: lead.id,
      ref: message.id,
    });
    planLearning(lead.id);
  }
  if (bookingIntent && getLead(lead.id)!.stage === 'Replied') {
    moveStage(lead.id, 'Meeting Booked', 'agent', 'Inbound webhook', 'Booking intent detected in inbound reply.');
    log('system', 'done', `${company}: booking intent detected. Pipeline moved to Meeting Booked.`, { lead_id: lead.id, ref: message.id });
  }
  changed();
  return { stage: getLead(lead.id)!.stage, booking_intent: bookingIntent };
}

/** A person asks for another attempt at a failed or blocked task. */
export function retry(taskId: string): TaskRun {
  const task = retryTask(taskId);
  pool.kick();
  return task;
}

// ---------- credits and demo controls ----------

export function topUp(amount: number) {
  credit(amount, 'topup', 'Manual top-up');
  mirrorTopUp(amount);
  log('ledger', 'info', `Topped up ${amount} credits. Balance is ${balance()}. Resuming held work.`);
  changed();
  return currentIcp() && getProfile() ? resume() : Promise.resolve();
}

/**
 * Bring the credit balance in line with the Flexprice wallet. When the wallet is the source and
 * someone has added credits to it in Flexprice, the work that was waiting for credits continues.
 */
export async function syncBilling(): Promise<void> {
  const before = flexpriceStatus();
  const result = await syncWallet(!running && !pool.busy());
  const after = flexpriceStatus();
  if (result.changed || before.balance !== after.balance || before.connected !== after.connected || before.last_error !== after.last_error) changed();
  if (result.raised && !running && currentIcp() && getProfile()) await resume().catch(() => undefined);
}

export function moveClock(days: number): void {
  advanceClock(days);
  log('system', 'info', `Clock moved forward ${days} day${days === 1 ? '' : 's'}. Re-checking every receipt's expiry.`);
  const moved = recomputeAll();
  if (moved === 0) log('system', 'info', 'No lead changed state.');
  reconcileGate();
  settleRuns();
  changed();
}

/** Clock tick. Receipts expire on their own, so state is re-derived even when nothing else happens. */
export function tick(): void {
  if (running || pool.busy()) return;
  if (recomputeAll() > 0) {
    reconcileGate();
    changed();
  }
}

/** Start again from an empty store and a freshly seeded world. */
export function resetDemo(): void {
  clearBoard();
  wipe();
  seedWorld();
  credit(config.startingCredits, 'grant', 'Starting credits');
  void restoreDemoWallet();
  log('system', 'info', `Fresh start: empty pipeline, seeded demo world, ${config.startingCredits} credits.`);
  changed();
}

// ---------- the Band room ----------

const ROOM_NOTES = 'Instructions from the Band room';

// A person decides in the room. Their reply goes through the same approve and reject as the
// review queue, so the human gate and the delivery guard apply exactly as they do in the app.
onBandDecision(({ action, messageId, reviewer, note }) => {
  try {
    if (action === 'approve') approve(messageId, reviewer);
    else reject(messageId, reviewer, note);
    return '';
  } catch (err) {
    return `Could not ${action} ${messageId}: ${err instanceof Error ? err.message : 'unknown error'}`;
  }
});

// A person instructs an agent in the room. The instruction is kept as a note on that agent's
// standing task and reaches the agent on its next model-backed run, bounded and marked as operator intent.
onBandNote((role, text, author) => {
  const standing =
    tasksWhere("kind = 'manual' AND agent = ? AND title = ? AND status NOT IN ('done', 'failed')", role, ROOM_NOTES)[0] ??
    createManualTask({ title: ROOM_NOTES, agent: role, detail: 'What people asked this agent for in the Band room.' });
  addTaskMessage(standing.id, { author, body: text });
  return `Noted for the ${role}. It applies from the next run.`;
});
