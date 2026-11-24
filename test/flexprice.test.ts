import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { config } from '../server/config';
import { all, initDb } from '../server/db';
import { connectFlexprice, flexpriceStatus, meterEvent, resetFlexprice, topUpWallet } from '../server/integrations/flexprice';
import { restoreDemoWallet, syncWallet } from '../server/services/billing';
import { balance, charge, credit } from '../server/services/ledger';

// The credit balance, tested against a stand-in for Flexprice built from docs.flexprice.io:
// x-api-key auth, customers by external id, wallets, the real-time balance, top-ups with an
// idempotency key, and metered events that the wallet's balance reflects. No real Flexprice
// account is used, so this proves the client follows the documented contract, not that Flexprice
// accepts it.

const KEY = 'fp-test-key';
const CUSTOMER = 'receipts-demo';

interface Wallet {
  id: string;
  customer_id: string;
  credit_balance: number;
  wallet_status: 'active' | 'closed';
  wallet_type: string;
}

const fp = {
  customers: new Map<string, { id: string; external_id: string; name: string }>(),
  wallets: [] as Wallet[],
  events: [] as { event_name: string; external_customer_id: string; properties: { credits: number; ref: string } }[],
  topUps: [] as { wallet: string; credits: number; key: string; reason: string }[],
  /** Like Flexprice itself: usage only reaches the wallet when a plan prices the events. */
  pricesUsage: true,
  down: false,
  calls: [] as string[],
};

const read = (req: IncomingMessage) =>
  new Promise<Record<string, any>>((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });

const money = (n: number) => n.toFixed(6);

function mockFlexprice(): Server {
  return createServer(async (req, res) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const path = (req.url ?? '').replace(/^\/v1/, '');
    fp.calls.push(`${req.method} ${path}`);
    if (fp.down) return send(500, { code: 'internal_error', http_status_code: 500, message: 'upstream unavailable' });
    if (req.headers['x-api-key'] !== KEY) return send(401, { message: 'unauthorized' });
    const body = req.method === 'POST' ? await read(req) : {};
    const view = (w: Wallet) => {
      const used = fp.pricesUsage ? fp.events.reduce((sum, e) => sum + Number(e.properties.credits || 0), 0) : 0;
      return {
        ...w,
        currency: 'usd',
        conversion_rate: '1',
        credit_balance: money(w.credit_balance),
        balance: money(w.credit_balance),
        real_time_credit_balance: money(w.credit_balance - used),
        real_time_balance: money(w.credit_balance - used),
      };
    };

    let m: RegExpMatchArray | null;
    if (req.method === 'POST' && path === '/events') {
      if (!body.event_name || !body.external_customer_id) return send(400, { message: 'event_name and external_customer_id are required' });
      fp.events.push(body as (typeof fp.events)[number]);
      return send(202, { message: 'Event accepted for processing' });
    }
    if (req.method === 'GET' && (m = path.match(/^\/customers\/external\/([^/]+)$/))) {
      const found = fp.customers.get(decodeURIComponent(m[1]));
      return found ? send(200, found) : send(404, { message: 'customer not found' });
    }
    if (req.method === 'POST' && path === '/customers') {
      if (!body.external_id || !body.name) return send(400, { message: 'external_id and name are required' });
      const made = { id: `cust_${fp.customers.size + 1}`, external_id: body.external_id, name: body.name };
      fp.customers.set(body.external_id, made);
      return send(201, made);
    }
    if (req.method === 'GET' && (m = path.match(/^\/customers\/([^/]+)\/wallets$/))) {
      return send(200, fp.wallets.filter((w) => w.customer_id === m![1]).map(view));
    }
    if (req.method === 'POST' && path === '/wallets') {
      if (!body.currency) return send(400, { message: 'currency is required' });
      const made: Wallet = {
        id: `wallet_${fp.wallets.length + 1}`,
        customer_id: body.customer_id,
        credit_balance: Number(body.initial_credits_to_load ?? 0),
        wallet_status: 'active',
        wallet_type: body.wallet_type ?? 'PRE_PAID',
      };
      fp.wallets.push(made);
      return send(200, view(made));
    }
    if (req.method === 'GET' && (m = path.match(/^\/wallets\/([^/]+)\/balance\/real-time$/))) {
      const wallet = fp.wallets.find((w) => w.id === m![1]);
      return wallet ? send(200, view(wallet)) : send(404, { message: 'wallet not found' });
    }
    if (req.method === 'POST' && (m = path.match(/^\/wallets\/([^/]+)\/top-up$/))) {
      const wallet = fp.wallets.find((w) => w.id === m![1]);
      if (!wallet) return send(404, { message: 'wallet not found' });
      if (!body.transaction_reason) return send(400, { message: 'transaction_reason is required' });
      if (fp.topUps.some((t) => t.key === body.idempotency_key)) return send(409, { message: 'idempotency key already used' });
      const credits = Number(body.credits_to_add);
      wallet.credit_balance += credits;
      fp.topUps.push({ wallet: wallet.id, credits, key: body.idempotency_key, reason: body.transaction_reason });
      return send(200, { wallet: view(wallet), wallet_transaction: { id: `txn_${fp.topUps.length}`, type: 'credit' } });
    }
    return send(404, { message: `no route for ${req.method} ${path}` });
  });
}

let server: Server;
const saved = { ...config.flexprice };

async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ready(), 'timed out waiting for Flexprice to receive what was sent');
}

before(async () => {
  server = mockFlexprice().listen(0);
  await new Promise((r) => server.once('listening', r));
});

after(async () => {
  Object.assign(config.flexprice, saved);
  resetFlexprice();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  initDb(':memory:');
  Object.assign(fp, { wallets: [], events: [], topUps: [], pricesUsage: true, down: false, calls: [] });
  fp.customers.clear();
  resetFlexprice();
  Object.assign(config.flexprice, {
    apiKey: KEY,
    customerId: CUSTOMER,
    // With the /v1 suffix on purpose: Flexprice's docs give the base URL both ways.
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    wallet: 'source',
    walletId: '',
    settleMs: 0,
  });
  credit(config.startingCredits, 'grant', 'Starting credits');
});

test('the first connection creates the customer and a wallet loaded with the starting credits', async () => {
  const said = await connectFlexprice();
  assert.match(said, /wallet created/);
  assert.equal(fp.customers.get(CUSTOMER)?.name, 'Receipts workspace');
  assert.equal(fp.wallets.length, 1);
  assert.equal(fp.wallets[0].credit_balance, config.startingCredits);
  const status = flexpriceStatus();
  assert.deepEqual([status.connected, status.mode, status.balance, status.wallet_id], [true, 'source', config.startingCredits, 'wallet_1']);

  // A restart finds the same wallet. It must not create a second one.
  resetFlexprice();
  assert.match(await connectFlexprice(), /wallet connected/);
  assert.equal(fp.wallets.length, 1);
  assert.equal(fp.customers.size, 1);
});

test('a closed wallet is not used, and a pinned wallet id skips the lookup', async () => {
  fp.customers.set(CUSTOMER, { id: 'cust_1', external_id: CUSTOMER, name: 'Existing' });
  fp.wallets.push({ id: 'wallet_old', customer_id: 'cust_1', credit_balance: 900, wallet_status: 'closed', wallet_type: 'PRE_PAID' });
  await connectFlexprice();
  assert.equal(flexpriceStatus().wallet_id, 'wallet_2', 'a new wallet, not the closed one');

  resetFlexprice();
  fp.calls.length = 0;
  fp.wallets[0].wallet_status = 'active';
  config.flexprice.walletId = 'wallet_old';
  await connectFlexprice();
  assert.equal(flexpriceStatus().balance, 900);
  assert.deepEqual(fp.calls, ['GET /wallets/wallet_old/balance/real-time']);
});

test('usage is metered as events, and the wallet balance is the credit balance', async () => {
  await connectFlexprice();
  assert.ok(charge('enrich', 'lead_1', 'Enrichment for Acme'));
  assert.ok(charge('draft', 'lead_1', 'Draft for Acme'));
  await until(() => fp.events.length === 2);
  assert.deepEqual(
    fp.events.map((e) => [e.event_name, e.external_customer_id, e.properties.credits, e.properties.ref]),
    [
      ['receipts.enrich', CUSTOMER, config.costs.enrich, 'lead_1'],
      ['receipts.draft', CUSTOMER, config.costs.draft, 'lead_1'],
    ],
  );

  // Flexprice priced the same usage, so both sides already agree and nothing is corrected.
  const spent = config.costs.enrich + config.costs.draft;
  assert.deepEqual(await syncWallet(), { changed: false, raised: false });
  assert.equal(balance(), config.startingCredits - spent);
  assert.equal(flexpriceStatus().balance, config.startingCredits - spent);
  assert.equal(flexpriceStatus().events_sent, 2);

  // Someone adds credits in Flexprice. Receipts picks it up and reports that work may continue.
  fp.wallets[0].credit_balance += 50;
  assert.deepEqual(await syncWallet(), { changed: true, raised: true });
  assert.equal(balance(), config.startingCredits - spent + 50);
  const row = all<{ op: string; amount: number }>("SELECT op, amount FROM ledger WHERE op = 'flexprice'");
  assert.deepEqual(row.map((r) => [r.op, r.amount]), [['flexprice', 50]]);

  // And the other way: the wallet has less than the ledger thinks, so the ledger comes down.
  fp.wallets[0].credit_balance -= 20;
  assert.deepEqual(await syncWallet(), { changed: true, raised: false });
  assert.equal(balance(), config.startingCredits - spent + 30);
});

test('the balance is not corrected while a write is still settling, or while agents are working', async () => {
  await connectFlexprice();
  config.flexprice.settleMs = 60_000;
  meterEvent('receipts.graph_query', 0, 'warm_intros');
  await until(() => fp.events.length === 1);
  fp.wallets[0].credit_balance += 10;
  assert.deepEqual(await syncWallet(), { changed: false, raised: false }, 'too soon after our own write');
  assert.equal(balance(), config.startingCredits);
  assert.equal(flexpriceStatus().balance, config.startingCredits + 10, 'the wallet is still read and shown');

  config.flexprice.settleMs = 0;
  assert.deepEqual(await syncWallet(false), { changed: false, raised: false }, 'not while a run is in progress');
  assert.deepEqual(await syncWallet(), { changed: true, raised: true });
  assert.equal(balance(), config.startingCredits + 10);
});

test('in mirror mode the wallet is shown and the local ledger stays the gate', async () => {
  config.flexprice.wallet = 'mirror';
  fp.pricesUsage = false;
  assert.match(await connectFlexprice(), /local ledger still gates/);
  assert.ok(charge('enrich', 'lead_1', 'Enrichment for Acme'));
  await until(() => fp.events.length === 1);
  assert.deepEqual(await syncWallet(), { changed: false, raised: false });
  assert.equal(balance(), config.startingCredits - config.costs.enrich, 'the ledger keeps its own count');
  assert.equal(flexpriceStatus().balance, config.startingCredits, 'no plan prices the events, and the app says what the wallet holds');
});

test('a top-up from Receipts is a wallet top-up, and a repeated key is not applied twice', async () => {
  await connectFlexprice();
  assert.equal(await topUpWallet(50, 'receipts_topup_a', 'Top-up from Receipts'), true);
  assert.equal(await topUpWallet(50, 'receipts_topup_a', 'Top-up from Receipts'), true, 'a 409 on a key already applied is success');
  assert.equal(fp.wallets[0].credit_balance, config.startingCredits + 50);
  assert.deepEqual(fp.topUps, [{ wallet: 'wallet_1', credits: 50, key: 'receipts_topup_a', reason: 'FREE_CREDIT_GRANT' }]);
});

test('resetting the demo brings the wallet back up to the starting credits, and never above', async () => {
  await connectFlexprice();
  fp.wallets[0].credit_balance = 3;
  await restoreDemoWallet();
  assert.equal(fp.wallets[0].credit_balance, config.startingCredits);
  await restoreDemoWallet();
  assert.equal(fp.topUps.length, 1, 'a wallet already at the starting amount is left alone');
});

test('a Flexprice outage leaves the ledger as it was and says why', async () => {
  await connectFlexprice();
  fp.down = true;
  assert.ok(charge('enrich', 'lead_1', 'Enrichment for Acme'), 'the gate decides locally and does not wait for Flexprice');
  assert.deepEqual(await syncWallet(), { changed: false, raised: false });
  assert.equal(balance(), config.startingCredits - config.costs.enrich);
  assert.match(flexpriceStatus().last_error ?? '', /HTTP 500/);

  // Never connected at all: the app says so and stays on its own ledger.
  resetFlexprice();
  assert.match(await connectFlexprice(), /could not be reached.*local ledger/);
  assert.equal(flexpriceStatus().connected, false);

  // A wrong key is reported as such.
  fp.down = false;
  config.flexprice.apiKey = 'wrong';
  assert.match(await connectFlexprice(), /HTTP 401/);
});
