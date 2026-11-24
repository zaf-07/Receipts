import type { Lead, Profile, Stage } from '../../shared/types';
import { STAGES } from '../../shared/constants';
import { advanceClock, now } from '../clock';
import { config } from '../config';
import { wipe } from '../db';
import { isExpired, isLive, isTrigger } from '../domain/state';
import { changed, log } from '../services/activity';
import { balance, charge, credit } from '../services/ledger';
import { moveStage, recomputeAll } from '../services/leads';
import {
  currentIcp,
  getCompany,
  getLead,
  getMessage,
  getPerson,
  getProfile,
  getReceipt,
  latestMessage,
  leadReceipts,
  listIcpVersions,
  listLeads,
  saveProfile,
  setCurrentIcp,
  updateIcpExpansions,
  updateMessage,
} from '../services/store';
import { applyAfterCrawl, releaseNextBatch, seedWorld } from '../world/world';
import { runAnalyst } from './analyst';
import { enrichLead } from './enricher';
import { runPlanner } from './planner';
import { runResearcher } from './researcher';
import { recheckNegatives, reviewDraft } from './skeptic';
import { validateDraft, writeDraft } from './writer';

// Hands work from one agent to the next:
// Planner -> Researcher -> Enricher -> Writer -> Skeptic -> Human -> Analyst.
// The human gate is a real stop: nothing below calls a send without an approve() from a person.

let running: string | null = null;
let tail: Promise<unknown> = Promise.resolve();

export const currentRun = () => running;

/** Pipeline runs are serialised so two agents never write the same lead at once. */
export function exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const next = tail.then(async () => {
    running = label;
    changed();
    try {
      return await fn();
    } catch (err) {
      log('system', 'warn', `${label} stopped on an error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      running = null;
      changed();
    }
  });
  tail = next.catch(() => undefined);
  return next;
}

export class UserError extends Error {}

function requireSetup() {
  const profile = getProfile();
  const icp = currentIcp();
  if (!profile || !icp) throw new UserError('Complete the intake first, so there is an ICP to work from.');
  return { profile, icp };
}

// ---------- intake ----------

export function intake(profile: Profile) {
  return exclusive('Planning', async () => {
    saveProfile(profile);
    const icp = await runPlanner(profile, currentIcp()?.id ?? null);
    recomputeAll();
    return icp;
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

// ---------- pipeline ----------

function needsDraft(lead: Lead): boolean {
  const latest = latestMessage(lead.id);
  if (!latest) return true;
  if (latest.status !== 'blocked' && latest.status !== 'rejected') return false;
  // A blocked or rejected draft is only retried when new evidence has arrived since.
  const at = now();
  return leadReceipts(lead).some((r) => r.sign === 'positive' && isTrigger(r) && isLive(r, at) && r.seen_at > latest.created_at);
}

/**
 * Move every active lead as far as it can go without a human: enrich, draft, verify.
 * Stops at the first credit gate rather than failing lead after lead.
 */
async function advance(): Promise<void> {
  const { profile, icp } = requireSetup();
  for (const snapshot of listLeads()) {
    let lead = getLead(snapshot.id)!;
    if (lead.state !== 'active' || lead.stage !== 'Matched') continue;

    if (!lead.person_id && (lead.enrich_status === 'pending' || lead.enrich_status === 'blocked_credits')) {
      const result = await enrichLead(lead, icp);
      if (result === 'blocked_credits') return;
      lead = getLead(lead.id)!;
    }
    if (!lead.person_id || !needsDraft(lead)) continue;

    const message = await writeDraft(lead, icp, profile);
    if (message === 'blocked_credits') return;
    if (message) await reviewDraft(message.id);
  }
}

export function discover() {
  requireSetup();
  return exclusive('Discovery', async () => {
    const { profile, icp } = requireSetup();
    await runResearcher(icp, profile, 'discovery');
    if (config.source === 'world') {
      // The world keeps moving between the Researcher's visit and the Skeptic's.
      for (const change of applyAfterCrawl()) log('world', 'info', `Demo world: ${change} after it was read.`);
    }
    log('researcher', 'handoff', 'Every lead has a live receipt or a dormant reason. Handing active leads to the Enricher.');
    await advance();
  });
}

/** Refresh signals. This is the continuous ingestion: new pages can wake a dormant lead. */
export function ingest() {
  requireSetup();
  return exclusive('Ingesting signals', async () => {
    const { profile, icp } = requireSetup();
    if (config.source === 'world') {
      const published = releaseNextBatch();
      if (published.length) log('world', 'info', `Demo world: ${published.map((p) => `${p.company} published "${p.title}"`).join('; ')}.`);
      else log('world', 'info', 'Demo world: no new pages were published since the last refresh.');
    }
    await recheckNegatives();
    await runResearcher(icp, profile, 'ingest');
    await advance();
  });
}

export function resume() {
  requireSetup();
  return exclusive('Continuing', advance);
}

/** Run the Skeptic again on a draft, on request. Used to show a source going stale. */
export function reverify(messageId: string) {
  return exclusive('Re-verifying', async () => {
    const message = getMessage(messageId);
    if (!message) throw new UserError('Unknown draft.');
    const lead = getLead(message.lead_id);
    log('skeptic', 'start', `Re-opening every source behind the draft for ${lead ? getCompany(lead.company_id)?.name : 'this lead'}.`, { lead_id: message.lead_id, ref: message.id });
    if (message.status === 'blocked' && message.sentences.some((s) => s.kind === 'claim' && s.status === 'ok')) {
      updateMessage(message.id, { status: 'draft' });
    }
    return reviewDraft(message.id);
  });
}

// ---------- the human gate ----------

/** Approve a draft. This is the only path to a send, and it re-checks the evidence one last time. */
export function approve(messageId: string, reviewer: string): void {
  const message = getMessage(messageId);
  if (!message) throw new UserError('Unknown draft.');
  if (message.status !== 'pending_review') throw new UserError(`This draft is ${message.status.replace('_', ' ')} and cannot be approved.`);
  recomputeAll();
  const lead = getLead(message.lead_id)!;
  const company = getCompany(lead.company_id)!;
  const person = getPerson(lead.person_id);
  if (lead.state !== 'active') throw new UserError(`${company.name} no longer has a live reason to contact: ${lead.dormant_reason}`);
  if (!person?.email) throw new UserError('There is no email address to send to.');

  const at = now();
  for (const s of message.sentences) {
    if (s.kind !== 'claim' || s.status !== 'ok') continue;
    for (const id of s.receipt_ids) {
      const r = getReceipt(id);
      if (!r || r.status === 'failed' || isExpired(r, at)) {
        throw new UserError(`A receipt behind "${s.text}" is no longer live. Re-verify the draft before sending.`);
      }
    }
  }
  if (!charge('send', message.id, `Sending to ${company.name}`, lead.id)) {
    throw new UserError(`Sending needs ${config.costs.send} credit and the balance is ${balance()}. Top up to send.`);
  }

  updateMessage(message.id, { status: 'sent', reviewer, sent_at: at.toISOString() });
  moveStage(lead.id, 'Contacted', 'agent', 'Writer + Skeptic', `Approved by ${reviewer}. Send logged.`);
  log('human', 'done', `${reviewer} approved the email to ${person.name} at ${company.name}. Send logged (delivery is simulated) and the card moved to Contacted.`, {
    lead_id: lead.id,
    ref: message.id,
  });
  changed();
}

export function reject(messageId: string, reviewer: string, note: string): void {
  const message = getMessage(messageId);
  if (!message) throw new UserError('Unknown draft.');
  if (message.status !== 'pending_review' && message.status !== 'blocked') throw new UserError('Only a draft waiting for review can be rejected.');
  updateMessage(message.id, { status: 'rejected', reviewer, block_reason: note || 'Rejected by the reviewer.' });
  const lead = getLead(message.lead_id);
  log('human', 'info', `${reviewer} rejected the draft for ${lead ? getCompany(lead.company_id)?.name : 'a lead'}${note ? `: ${note}` : ''}. Nothing was sent.`, {
    lead_id: message.lead_id,
    ref: message.id,
  });
  changed();
}

/**
 * Edit a draft. Sentences can be reworded or removed, never left factual and uncited:
 * the format check runs on the result and the Skeptic reviews it again.
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

  updateMessage(message.id, { subject: subject.trim(), sentences, reviewer });
  log('human', 'info', `${reviewer} edited the draft for ${getCompany(lead.company_id)?.name}. Sending it back through the Skeptic.`, { lead_id: lead.id, ref: message.id });
  return exclusive('Re-verifying', () => reviewDraft(message.id));
}

/** A manual stage move by a rep. Marking a reply triggers the Analyst. */
export function moveLead(leadId: string, to: Stage, actor: string, note: string | null): void {
  if (!STAGES.includes(to)) throw new UserError('Unknown stage.');
  const lead = getLead(leadId);
  if (!lead) throw new UserError('Unknown lead.');
  const from = lead.stage;
  if (!moveStage(leadId, to, 'rep', actor, note)) return;
  log('human', 'info', `${actor} moved ${getCompany(lead.company_id)?.name} from ${from} to ${to}${note ? `: ${note}` : ''}.`, { lead_id: leadId });
  if (to === 'Replied') runAnalyst(leadId);
  changed();
}

// ---------- credits and demo controls ----------

export function topUp(amount: number) {
  credit(amount, 'topup', 'Manual top-up');
  log('ledger', 'info', `Topped up ${amount} credits. Balance is ${balance()}. Resuming held work.`);
  changed();
  return currentIcp() && getProfile() ? resume() : Promise.resolve();
}

export function moveClock(days: number): void {
  advanceClock(days);
  log('system', 'info', `Clock moved forward ${days} day${days === 1 ? '' : 's'}. Re-checking every receipt's expiry.`);
  const moved = recomputeAll();
  if (moved === 0) log('system', 'info', 'No lead changed state.');
  changed();
}

/** Clock tick. Receipts expire on their own, so state is re-derived even when nothing else happens. */
export function tick(): void {
  if (running) return;
  if (recomputeAll() > 0) changed();
}

/** Start again from an empty store and a freshly seeded world. */
export function resetDemo(): void {
  wipe();
  seedWorld();
  credit(config.startingCredits, 'grant', 'Starting credits');
  log('system', 'info', `Fresh start: empty pipeline, seeded demo world, ${config.startingCredits} credits.`);
  changed();
}
