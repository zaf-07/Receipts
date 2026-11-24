import type { LeadState, ReasonCode, Receipt } from '../../shared/types';
import { SIGNALS } from '../../shared/constants';

const DAY = 86_400_000;

export function isExpired(r: Pick<Receipt, 'expires_at'>, now: Date): boolean {
  return r.expires_at != null && new Date(r.expires_at).getTime() <= now.getTime();
}

/** A receipt counts while it has not failed re-verification and has not expired. */
export function isLive(r: Pick<Receipt, 'expires_at' | 'status'>, now: Date): boolean {
  return r.status !== 'failed' && !isExpired(r, now);
}

export function isTrigger(r: Pick<Receipt, 'signal_type'>): boolean {
  return SIGNALS[r.signal_type]?.trigger === true;
}

export interface DerivedState {
  state: LeadState;
  reason_code: ReasonCode;
  reason: string;
  receipt_id: string | null;
}

const byEventDesc = (a: Receipt, b: Receipt) =>
  new Date(b.event_at ?? b.seen_at).getTime() - new Date(a.event_at ?? a.seen_at).getTime();

/**
 * The state rules, checked on every change and on every clock tick.
 *
 * 1. Any live negative receipt: disqualified, and the reason is the claim.
 * 2. Otherwise at least one live positive trigger: active.
 * 3. Otherwise not yet, with one of three reasons: the only trigger failed
 *    re-verification, the last trigger expired N days ago, or no trigger was found.
 */
export function deriveState(receipts: Receipt[], now: Date, wanted: string[] = []): DerivedState {
  const negatives = receipts.filter((r) => r.sign === 'negative' && isLive(r, now)).sort(byEventDesc);
  if (negatives.length > 0) {
    return { state: 'disqualified', reason_code: 'negative', reason: negatives[0].claim, receipt_id: negatives[0].id };
  }

  const positives = receipts.filter((r) => r.sign === 'positive' && isTrigger(r));
  const live = positives.filter((r) => isLive(r, now)).sort(byEventDesc);
  if (live.length > 0) {
    return { state: 'active', reason_code: 'live', reason: live[0].claim, receipt_id: live[0].id };
  }

  // A trigger that would still be in its window, had the Skeptic not disproved it.
  const struck = positives.filter((r) => r.status === 'failed' && !isExpired(r, now)).sort(byEventDesc);
  if (struck.length > 0) {
    const why = struck[0].fail_reason ?? 'source could not be confirmed';
    return {
      state: 'not_yet',
      reason_code: 'failed_verification',
      reason: `The only trigger failed re-verification: ${why}.`,
      receipt_id: struck[0].id,
    };
  }

  const expired = positives
    .filter((r) => isExpired(r, now))
    .sort((a, b) => new Date(b.expires_at!).getTime() - new Date(a.expires_at!).getTime());
  if (expired.length > 0) {
    const days = Math.max(1, Math.ceil((now.getTime() - new Date(expired[0].expires_at!).getTime()) / DAY));
    return {
      state: 'not_yet',
      reason_code: 'expired',
      reason: `Last trigger expired ${days} day${days === 1 ? '' : 's'} ago (${SIGNALS[expired[0].signal_type].label.toLowerCase()}).`,
      receipt_id: expired[0].id,
    };
  }

  const waiting = wanted.length > 0 ? ` Waiting for: ${wanted.join(', ')}.` : '';
  return { state: 'not_yet', reason_code: 'no_trigger', reason: `No trigger found yet.${waiting}`, receipt_id: null };
}
