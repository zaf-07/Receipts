import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { connectFlexprice, flexpriceEnabled, readWallet, topUpWallet, walletConnected, walletMode, walletQuiet } from '../integrations/flexprice';
import { log } from './activity';
import { balance, credit } from './ledger';

// Where the credit balance comes from.
//
// The credit gate has to answer at once and from inside a database transaction, so it reads the
// local ledger. When a Flexprice wallet is the source, the ledger is a cache of that wallet: usage
// is metered to Flexprice as it happens, and here the wallet's balance is read back and the ledger
// is corrected to match. A top-up made in Flexprice therefore opens the gate in Receipts, and the
// balance a person sees in either place is the same number.

export interface SyncResult {
  /** The ledger was corrected to the wallet. */
  changed: boolean;
  /** The correction added credits, so held work may be able to continue. */
  raised: boolean;
}

const NOTHING: SyncResult = { changed: false, raised: false };
let syncing = false;
let lastConnectAt = 0;

/**
 * Read the wallet, and when it is the source of truth, make the local ledger agree with it.
 * Pass false while agents are working: the wallet is still read, but nothing is corrected mid-run.
 */
export async function syncWallet(mayCorrect = true): Promise<SyncResult> {
  if (!flexpriceEnabled() || syncing) return NOTHING;
  syncing = true;
  try {
    if (!walletConnected()) {
      // Do not hammer an API that is down or misconfigured.
      if (Date.now() - lastConnectAt < 30_000) return NOTHING;
      lastConnectAt = Date.now();
      log('system', 'info', await connectFlexprice());
      if (!walletConnected()) return NOTHING;
    }
    const remote = await readWallet();
    // A charge made while we were reading is not in that number yet, so wait for a quiet moment.
    if (remote === null || !mayCorrect || walletMode() !== 'source' || !walletQuiet()) return NOTHING;
    return adopt(remote);
  } finally {
    syncing = false;
  }
}

function adopt(remote: number): SyncResult {
  const target = Math.max(0, Math.floor(remote));
  const local = balance();
  if (target === local) return NOTHING;
  credit(target - local, 'flexprice', `Set from the Flexprice wallet (ledger had ${local}, wallet has ${target})`);
  log('ledger', 'info', `The Flexprice wallet holds ${target} credits and the ledger had ${local}. The wallet is the source, so the balance is now ${target}.`);
  return { changed: true, raised: target > local };
}

/** A top-up made in Receipts is a top-up of the wallet. The ledger is credited first so the gate opens at once. */
export function mirrorTopUp(credits: number): void {
  if (!walletConnected()) return;
  void topUpWallet(credits, `receipts_topup_${randomUUID()}`, 'Top-up from Receipts').then((ok) => {
    if (!ok) log('ledger', 'warn', `Flexprice did not accept the ${credits} credit top-up. ${walletMode() === 'source' ? 'The wallet is the source, so the balance will fall back to what it holds.' : 'The local ledger keeps it.'}`);
  });
}

/**
 * Resetting the demo starts again with the starting credits. When the wallet is the source it is
 * brought back up to that amount, so the run can be shown again. It is only ever topped up:
 * Flexprice has no way to take credits out, and a fuller wallet simply means a longer run.
 */
export async function restoreDemoWallet(): Promise<void> {
  if (walletMode() !== 'source' || !walletConnected()) return;
  const remote = await readWallet();
  if (remote === null) return;
  const short = config.startingCredits - Math.floor(remote);
  if (short > 0) await topUpWallet(short, `receipts_reset_${randomUUID()}`, 'Demo reset: back to the starting credits');
}
