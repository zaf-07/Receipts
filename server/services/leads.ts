import type { Lead, Stage } from '../../shared/types';
import { SIGNALS } from '../../shared/constants';
import { now } from '../clock';
import { deriveState } from '../domain/state';
import { scoreLead } from '../domain/scoring';
import { log } from './activity';
import {
  addTransition,
  currentIcp,
  getCompany,
  getLead,
  latestMessage,
  listLeads,
  receiptsFor,
  updateLead,
  updateMessage,
} from './store';

/**
 * Re-derive one lead's state and score from its receipts and the clock.
 * State is never set by hand: it is always the output of the rules in domain/state.ts.
 * Returns true when the state changed.
 */
export function recomputeLead(leadId: string, opts: { announce?: boolean; keepDraft?: boolean } = {}): boolean {
  const lead = getLead(leadId);
  if (!lead) return false;
  const company = getCompany(lead.company_id);
  if (!company) return false;

  const icp = currentIcp();
  const at = now();
  const receipts = receiptsFor([company.id]);
  const wanted = (icp?.fields.trigger_events ?? []).map((t) => SIGNALS[t.value].label.toLowerCase());
  const derived = deriveState(receipts, at, wanted);
  const inputs = icp ? scoreLead(company, receipts, icp, at) : null;

  const patch: Partial<Lead> = {};
  const set = <K extends keyof Lead>(key: K, value: Lead[K]) => {
    if (JSON.stringify(lead[key]) !== JSON.stringify(value)) patch[key] = value;
  };
  set('state', derived.state);
  set('reason_code', derived.reason_code);
  set('dormant_reason', derived.state === 'active' ? null : derived.reason);
  set('reason_receipt_id', derived.receipt_id);
  if (inputs) {
    set('fit_score', inputs.fit_score);
    set('intent_score', inputs.intent_score);
    set('score', inputs.score);
    set('tier', inputs.tier);
    set('score_inputs', inputs);
    set('icp_version_id', icp!.id);
  }
  if (Object.keys(patch).length > 0) updateLead(lead.id, patch);

  const moved = lead.state !== derived.state;
  if (moved || opts.announce) {
    if (derived.state === 'active') {
      const woke = moved && !opts.announce;
      log('researcher', 'info', `${company.name} ${woke ? 'woke up' : 'is active'}: ${derived.reason}`, {
        lead_id: lead.id,
        ref: derived.receipt_id,
      });
    } else if (derived.state === 'disqualified') {
      log('researcher', 'warn', `${company.name} disqualified: ${derived.reason}`, { lead_id: lead.id, ref: derived.receipt_id });
    } else {
      log('researcher', 'info', `${company.name} held in Not yet: ${derived.reason}`, { lead_id: lead.id, ref: derived.receipt_id });
    }
  }

  // No receipt, no action: a draft waiting for review cannot outlive the reason it was written.
  if (derived.state !== 'active' && !opts.keepDraft) {
    const message = latestMessage(lead.id);
    if (message && (message.status === 'pending_review' || message.status === 'draft')) {
      updateMessage(message.id, {
        status: 'blocked',
        block_reason: derived.state === 'disqualified' ? `Lead disqualified: ${derived.reason}` : `No live receipt left. ${derived.reason}`,
      });
      log('skeptic', 'block', `Draft for ${company.name} blocked: the lead no longer has a live reason to contact.`, {
        lead_id: lead.id,
        ref: message.id,
      });
    }
  }
  return moved;
}

/** Run the state rules over every lead. Called after each change and on every clock tick. */
export function recomputeAll(opts: { announce?: boolean } = {}): number {
  let changed = 0;
  for (const lead of listLeads()) if (recomputeLead(lead.id, opts)) changed++;
  return changed;
}

/** Record a stage move with who made it. The AI / rep badge is read from these rows. */
export function moveStage(leadId: string, to: Stage, actorType: 'agent' | 'rep', actor: string, note: string | null): boolean {
  const lead = getLead(leadId);
  if (!lead || lead.stage === to) return false;
  addTransition(lead.id, lead.stage, to, actorType, actor, note);
  updateLead(lead.id, { stage: to });
  return true;
}
