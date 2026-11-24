import type { WalletStatus } from '../../shared/types';
import { config } from '../config';

// Flexprice, from its published API reference (docs.flexprice.io):
//
//   POST /v1/events                          one metered usage event (202)
//   GET  /v1/customers/external/{id}         our customer, by the id we chose for it
//   POST /v1/customers                       create it when it is missing
//   GET  /v1/customers/{id}/wallets          the customer's credit wallets
//   POST /v1/wallets                         create one when there is none
//   GET  /v1/wallets/{id}/balance/real-time  what the wallet has left, usage included
//   POST /v1/wallets/{id}/top-up             add credits
//
// Flexprice has no call that takes credits out of a wallet by hand. Usage reaches the wallet the
// way it does for any Flexprice customer: events are metered, the plan prices them, and the
// real-time balance is the settled balance less the usage of the current period. So Receipts sends
// events, reads the balance back, and never pretends to debit.
//
// Tested against a stand-in built from those pages (test/flexprice.test.ts), not yet against a
// live Flexprice account.

export type WalletMode = WalletStatus['mode'];

const state = {
  customerId: '',
  walletId: '',
  balance: null as number | null,
  syncedAt: null as string | null,
  eventsSent: 0,
  error: null as string | null,
  /** Writes still on their way to Flexprice. The balance is not trusted while any are in flight. */
  pending: 0,
  lastWriteAt: 0,
};

export function flexpriceEnabled(): boolean {
  return Boolean(config.flexprice.apiKey && config.flexprice.customerId);
}

export function walletMode(): WalletMode {
  return flexpriceEnabled() ? config.flexprice.wallet : 'off';
}

export function walletConnected(): boolean {
  return Boolean(state.walletId);
}

export function flexpriceStatus(): WalletStatus {
  return {
    configured: flexpriceEnabled(),
    mode: walletMode(),
    connected: walletConnected(),
    wallet_id: state.walletId || null,
    balance: state.balance,
    synced_at: state.syncedAt,
    events_sent: state.eventsSent,
    last_error: state.error,
  };
}

/** Forget the connection. Used when the configuration changes, and by the tests. */
export function resetFlexprice(): void {
  Object.assign(state, { customerId: '', walletId: '', balance: null, syncedAt: null, eventsSent: 0, error: null, pending: 0, lastWriteAt: 0 });
}

/**
 * True when nothing we sent can still be on its way into the wallet's balance. Flexprice ingests
 * events asynchronously, so a balance read straight after a charge would not include it yet.
 */
export function walletQuiet(): boolean {
  return state.pending === 0 && Date.now() - state.lastWriteAt >= config.flexprice.settleMs;
}

// The base URL may be given with or without the /v1 suffix. Flexprice's own docs show both.
const root = () => `${config.flexprice.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;

interface Reply {
  status: number;
  ok: boolean;
  data: unknown;
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(root() + path, {
    method,
    headers: { 'x-api-key': config.flexprice.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const raw = await res.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data };
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The docs give two error shapes. Read either, and never echo more than a line of it. */
function reason(reply: Reply): string {
  const body = record(reply.data);
  const message = body.message ?? record(body.error).message;
  return `HTTP ${reply.status}${typeof message === 'string' && message ? `: ${message.slice(0, 160)}` : ''}`;
}

function fail(what: string, err: unknown): null {
  state.error = `${what}: ${err instanceof Error ? err.message : String(err)}`;
  console.warn(`[flexprice] ${state.error}`);
  return null;
}

/** A list endpoint answers with a bare array in the reference, and with { items } elsewhere. */
function rows(data: unknown): Record<string, unknown>[] {
  const list = Array.isArray(data) ? data : (record(data).items ?? record(data).data);
  return Array.isArray(list) ? list.map(record) : [];
}

/** Amounts arrive as decimal strings. */
function amount(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function findCustomer(): Promise<string | null> {
  const external = config.flexprice.customerId;
  const found = await call('GET', `/customers/external/${encodeURIComponent(external)}`);
  if (found.ok) return String(record(found.data).id ?? '') || null;
  if (found.status !== 404) throw new Error(`customer lookup failed (${reason(found)})`);
  const made = await call('POST', '/customers', { external_id: external, name: 'Receipts workspace' });
  if (!made.ok) throw new Error(`customer could not be created (${reason(made)})`);
  return String(record(made.data).id ?? '') || null;
}

async function findWallet(customerId: string): Promise<{ id: string; created: boolean }> {
  const listed = await call('GET', `/customers/${encodeURIComponent(customerId)}/wallets`);
  if (!listed.ok) throw new Error(`wallets could not be listed (${reason(listed)})`);
  const usable = rows(listed.data).filter((w) => (w.wallet_status ?? 'active') === 'active');
  const wallet = usable.find((w) => w.wallet_type === 'PRE_PAID') ?? usable[0];
  if (wallet?.id) return { id: String(wallet.id), created: false };
  const made = await call('POST', '/wallets', {
    customer_id: customerId,
    currency: config.flexprice.currency,
    name: 'Receipts credits',
    wallet_type: 'PRE_PAID',
    conversion_rate: '1',
    initial_credits_to_load: String(config.startingCredits),
  });
  const id = String(record(made.data).id ?? '');
  if (!made.ok || !id) throw new Error(`wallet could not be created (${reason(made)})`);
  return { id, created: true };
}

/**
 * Find the wallet that holds this workspace's credits, creating the customer and the wallet on
 * first use. Returns one sentence for the activity feed. It never throws: a Flexprice outage
 * leaves the app on its local ledger.
 */
export async function connectFlexprice(): Promise<string> {
  if (!flexpriceEnabled()) return 'Flexprice is not configured.';
  try {
    let created = false;
    if (config.flexprice.walletId) {
      state.walletId = config.flexprice.walletId;
    } else {
      const customerId = await findCustomer();
      if (!customerId) throw new Error('the customer came back without an id');
      state.customerId = customerId;
      const wallet = await findWallet(customerId);
      state.walletId = wallet.id;
      created = wallet.created;
    }
    const balance = await readWallet();
    if (balance === null) {
      state.walletId = config.flexprice.walletId ? state.walletId : '';
      return `Flexprice: the wallet could not be read (${state.error ?? 'no balance returned'}). Credits stay on the local ledger.`;
    }
    state.error = null;
    const role = walletMode() === 'source' ? 'It is the source of the credit balance.' : 'Usage is metered to it; the local ledger still gates.';
    return `Flexprice wallet ${created ? 'created' : 'connected'}: ${balance} credits. ${role}`;
  } catch (err) {
    state.walletId = '';
    fail('connect', err);
    return `Flexprice could not be reached (${state.error}). Credits stay on the local ledger.`;
  }
}

/** Read what the wallet has left, in credits. Null when it cannot be read. */
export async function readWallet(): Promise<number | null> {
  if (!state.walletId) return null;
  try {
    const reply = await call('GET', `/wallets/${encodeURIComponent(state.walletId)}/balance/real-time`);
    if (!reply.ok) throw new Error(reason(reply));
    const body = record(reply.data);
    // Credits first. The currency fields are a fallback, converted back with the wallet's own rate.
    const rate = amount(body.conversion_rate) || 1;
    const currency = amount(body.real_time_balance) ?? amount(body.balance);
    const credits = amount(body.real_time_credit_balance) ?? amount(body.credit_balance) ?? (currency === null ? null : currency / rate);
    if (credits === null) throw new Error('the balance response had no balance in it');
    state.balance = credits;
    state.syncedAt = new Date().toISOString();
    state.error = null;
    return credits;
  } catch (err) {
    return fail('balance', err);
  }
}

/**
 * Add credits to the wallet. A demo top-up is recorded as a free grant, so Flexprice raises no
 * invoice and takes no payment for it. The key makes a retry safe: Flexprice answers 409 to a key
 * it has already applied, which is success here.
 */
export async function topUpWallet(credits: number, key: string, description: string): Promise<boolean> {
  if (!state.walletId || credits <= 0) return false;
  state.pending++;
  try {
    const reply = await call('POST', `/wallets/${encodeURIComponent(state.walletId)}/top-up`, {
      credits_to_add: String(credits),
      transaction_reason: 'FREE_CREDIT_GRANT',
      idempotency_key: key,
      description,
    });
    if (!reply.ok && reply.status !== 409) throw new Error(reason(reply));
    return true;
  } catch (err) {
    fail('top-up', err);
    return false;
  } finally {
    state.pending--;
    state.lastWriteAt = Date.now();
  }
}

/**
 * Meter one usage event. Off unless FLEXPRICE_API_KEY and FLEXPRICE_CUSTOMER_ID are set.
 * It never blocks the caller: the credit gate has already decided on the local ledger, and a
 * Flexprice outage must not hold up or let through a send.
 */
export function meterEvent(eventName: string, credits: number, ref: string | null): void {
  if (!flexpriceEnabled()) return;
  state.pending++;
  void call('POST', '/events', {
    event_name: eventName,
    external_customer_id: config.flexprice.customerId,
    source: 'receipts',
    timestamp: new Date().toISOString(),
    properties: { credits, ref: ref ?? '' },
  })
    .then((reply) => {
      if (!reply.ok) throw new Error(reason(reply));
      state.eventsSent++;
    })
    .catch((err) => fail(eventName, err))
    .finally(() => {
      state.pending--;
      state.lastWriteAt = Date.now();
    });
}
