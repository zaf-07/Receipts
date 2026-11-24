import type { LedgerEntry } from '../../shared/types';
import { all, get, run } from '../db';
import { nowIso } from '../clock';
import { config } from '../config';
import { log } from './activity';
import { meterEvent } from '../integrations/flexprice';

export type MeteredOp = 'enrich' | 'draft' | 'send';

export function balance(): number {
  return get<{ total: number | null }>('SELECT SUM(amount) AS total FROM ledger')?.total ?? 0;
}

export function credit(amount: number, op: string, note: string): void {
  run('INSERT INTO ledger (op, amount, ref, note, created_at) VALUES (?, ?, NULL, ?, ?)', op, amount, note, nowIso());
}

/**
 * The credit gate. Charges for a metered operation, or refuses and says so.
 * Returns false when the balance cannot cover the cost. The caller must not do the work.
 */
export function charge(op: MeteredOp, ref: string, note: string, leadId?: string): boolean {
  const cost = config.costs[op];
  const have = balance();
  if (have < cost) {
    log('ledger', 'block', `Credit gate: ${op} needs ${cost} credits, balance is ${have}. ${note} is on hold until you top up.`, {
      lead_id: leadId,
      ref,
    });
    return false;
  }
  run('INSERT INTO ledger (op, amount, ref, note, created_at) VALUES (?, ?, ?, ?, ?)', op, -cost, ref, note, nowIso());
  meterEvent(`receipts.${op}`, cost, ref);
  return true;
}

export function recentLedger(limit = 40): LedgerEntry[] {
  return all<LedgerEntry>('SELECT * FROM ledger ORDER BY id DESC LIMIT ?', limit);
}

export function countOps(op: string): number {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM ledger WHERE op = ?', op)?.n ?? 0;
}
