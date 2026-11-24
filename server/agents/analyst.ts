import type { IcpVersion, SignalType } from '../../shared/types';
import { LEARNING_STEP, SIGNALS } from '../../shared/constants';
import { isTrigger } from '../domain/state';
import { log } from '../services/activity';
import { recomputeAll } from '../services/leads';
import { currentIcp, getCompany, getLead, getReceipt, listLeads, listMessages, saveIcpVersion } from '../services/store';

// The Analyst reads outcomes, reweights signal types and proposes the next ICP version.
// It stops when a diff is ready for review. Receipts that earn replies gain weight.

/**
 * A lead replied. The signal types cited in the email that earned the reply gain 25% weight,
 * the change is saved as a new ICP version with its rationale, and every lead is rescored.
 */
export function runAnalyst(leadId: string): IcpVersion | null {
  const lead = getLead(leadId);
  const icp = currentIcp();
  if (!lead || !icp) return null;
  const company = getCompany(lead.company_id);
  const sent = listMessages()
    .filter((m) => m.lead_id === leadId && m.status === 'sent')
    .pop();
  if (!sent) {
    log('analyst', 'info', `${company?.name ?? 'A lead'} replied, but no sent message is on record, so there is nothing to learn from.`, { lead_id: leadId });
    return null;
  }

  const types = new Set<SignalType>();
  for (const s of sent.sentences) {
    if (s.kind !== 'claim' || s.status !== 'ok') continue;
    for (const id of s.receipt_ids) {
      const r = getReceipt(id);
      if (r && r.sign === 'positive' && isTrigger(r)) types.add(r.signal_type);
    }
  }
  if (types.size === 0) {
    log('analyst', 'info', `${company?.name ?? 'A lead'} replied, but the email cited no trigger receipts. Weights unchanged.`, { lead_id: leadId });
    return null;
  }

  log('analyst', 'start', `${company?.name} replied. Reading which receipts the email rested on.`, { lead_id: leadId });
  const before = new Map(listLeads().map((l) => [l.id, l.score]));
  const weights = { ...icp.weights };
  const changes: string[] = [];
  for (const t of types) {
    const old = weights[t] ?? SIGNALS[t].weight;
    const next = Math.round(old * (1 + LEARNING_STEP) * 100) / 100;
    weights[t] = next;
    changes.push(`${SIGNALS[t].label} ${old} to ${next}`);
  }

  const next = saveIcpVersion({
    parent_id: icp.id,
    fields: icp.fields,
    weights,
    windows: icp.windows,
    expansions: icp.expansions,
    search_plan: icp.search_plan,
    rationale: `${company?.name} replied to an email that cited ${[...types].map((t) => SIGNALS[t].label.toLowerCase()).join(' and ')}. Weight raised by ${LEARNING_STEP * 100}%: ${changes.join('; ')}.`,
    planned_by: 'analyst',
  });

  recomputeAll();
  const moved = listLeads()
    .map((l) => ({ name: getCompany(l.company_id)?.name ?? l.id, from: before.get(l.id) ?? 0, to: l.score }))
    .filter((x) => x.from !== x.to)
    .sort((a, b) => b.to - b.from - (a.to - a.from));
  log(
    'analyst',
    'done',
    `ICP v${next.version} saved. ${changes.join('; ')}. ${moved.length} lead${moved.length === 1 ? '' : 's'} rescored` +
      (moved.length ? ` (${moved.slice(0, 3).map((m) => `${m.name} ${m.from} to ${m.to}`).join(', ')})` : '') +
      '. A diff against the previous version is ready for review.',
    { ref: next.id },
  );
  return next;
}
