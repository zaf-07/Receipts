import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Profile, Stage } from '../shared/types';
import { REGIONS } from '../shared/constants';
import { config } from './config';
import { initDb } from './db';
import { changed, log, subscribe } from './services/activity';
import { balance, credit } from './services/ledger';
import { buildGraph, buildSnapshot, contrastEmail, whyNow } from './services/snapshot';
import { latestMessage } from './services/store';
import {
  UserError,
  activateIcp,
  approve,
  currentRun,
  decideExpansion,
  discover,
  editDraft,
  ingest,
  intake,
  moveClock,
  moveLead,
  reject,
  resetDemo,
  resume,
  reverify,
  tick,
  topUp,
} from './agents/orchestrator';
import { setPageStatus, seedWorld, worldRouter, worldSeeded } from './world/world';
import { EXAMPLE_PROFILE } from './world/seed';
import { AGENT_ROLES } from './integrations/band';

const text = (v: unknown, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown) =>
  (Array.isArray(v) ? v.map((x) => text(x, 200)) : text(v).split(/[,\n]/).map((x) => x.trim())).filter(Boolean).slice(0, 30);

/** Long pipeline work runs in the background. Progress and failures both arrive through the activity feed. */
function background(work: Promise<unknown>): void {
  work.catch((err) => {
    if (!(err instanceof UserError)) console.error(err);
  });
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '200kb' }));

  // The seeded demo world: fictional company sites, served as real pages.
  app.use('/world', worldRouter());

  const api = express.Router();

  api.get('/snapshot', (_req, res) => res.json(buildSnapshot(currentRun())));
  api.get('/example', (_req, res) => res.json(EXAMPLE_PROFILE));
  api.get('/roles', (_req, res) => res.json(AGENT_ROLES));

  api.get('/events', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const stop = subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(beat);
      stop();
    });
  });

  api.post('/intake', async (req, res) => {
    const profile: Profile = {
      product_name: text(req.body.product_name, 80),
      description: text(req.body.description),
      customers: list(req.body.customers),
      pricing: text(req.body.pricing, 600),
      excluded_regions: list(req.body.excluded_regions).filter((r) => REGIONS.includes(r)),
      sender: text(req.body.sender, 80),
    };
    if (!profile.product_name || profile.description.length < 20) {
      throw new UserError('Give the product a name and a description of at least a sentence.');
    }
    res.json(await intake(profile));
  });

  api.post('/icp/expansions/:id', (req, res) => {
    const decision = text(req.body.decision);
    if (decision !== 'accepted' && decision !== 'dismissed' && decision !== 'proposed') throw new UserError('Unknown decision.');
    decideExpansion(req.params.id, decision);
    res.json({ ok: true });
  });

  api.post('/icp/versions/:id/activate', (req, res) => {
    activateIcp(req.params.id);
    res.json({ ok: true });
  });

  api.post('/run', (_req, res) => {
    background(discover());
    res.status(202).json({ ok: true });
  });

  api.post('/ingest', (_req, res) => {
    background(ingest());
    res.status(202).json({ ok: true });
  });

  api.post('/resume', (_req, res) => {
    background(resume());
    res.status(202).json({ ok: true });
  });

  api.get('/graph', (_req, res) => res.json(buildGraph()));
  api.get('/leads/:id/why', (req, res) => res.json(whyNow(req.params.id)));
  api.get('/leads/:id/contrast', (req, res) => res.json(contrastEmail(req.params.id)));

  api.post('/leads/:id/verify', async (req, res) => {
    const message = latestMessage(req.params.id);
    if (!message) throw new UserError('This lead has no draft to verify.');
    res.json(await reverify(message.id));
  });

  api.post('/leads/:id/stage', (req, res) => {
    moveLead(req.params.id, text(req.body.to_stage) as Stage, text(req.body.actor, 80) || 'Rep', text(req.body.note, 400) || null);
    res.json({ ok: true });
  });

  api.post('/messages/:id/approve', (req, res) => {
    approve(req.params.id, text(req.body.reviewer, 80) || 'Reviewer');
    res.json({ ok: true });
  });

  api.post('/messages/:id/reject', (req, res) => {
    reject(req.params.id, text(req.body.reviewer, 80) || 'Reviewer', text(req.body.note, 400));
    res.json({ ok: true });
  });

  api.post('/messages/:id/edit', async (req, res) => {
    const kept = Array.isArray(req.body.sentences)
      ? req.body.sentences.map((s: { index: unknown; text: unknown }) => ({ index: Number(s.index), text: text(s.text, 600) }))
      : [];
    res.json(await editDraft(req.params.id, text(req.body.subject, 200), kept, text(req.body.reviewer, 80) || 'Reviewer'));
  });

  api.post('/credits/topup', (req, res) => {
    const amount = Math.min(1000, Math.max(1, Math.round(Number(req.body.amount) || 50)));
    background(topUp(amount));
    res.json({ ok: true, balance: balance() });
  });

  // Demo controls. They change the world and the clock, never the pipeline's own records.
  api.post('/demo/reset', (_req, res) => {
    if (currentRun()) throw new UserError('Wait for the current run to finish before resetting.');
    resetDemo();
    res.json({ ok: true });
  });

  api.post('/demo/clock', (req, res) => {
    const days = Math.min(730, Math.max(1, Math.round(Number(req.body.days) || 1)));
    moveClock(days);
    res.json({ ok: true });
  });

  api.post('/demo/pages/:id', (req, res) => {
    const status = text(req.body.status) === 'gone' ? 'gone' : 'live';
    const page = setPageStatus(req.params.id, status);
    if (!page) throw new UserError('Unknown page.');
    log('world', 'info', `Demo world: ${page.company} ${status === 'gone' ? 'took down' : 'restored'} "${page.title}".`);
    changed();
    res.json({ ok: true });
  });

  app.use('/api', api);

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found.' });
  });

  // Built web client, when present. In development Vite serves it instead.
  const dist = resolve('web/dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof UserError) return void res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. The details are in its log.' });
  });

  return app;
}

/** Open the store, seed the world on first run, and start listening. */
export async function start(opts: { port?: number; dbPath?: string } = {}): Promise<{ server: Server; port: number; stop: () => Promise<void> }> {
  initDb(opts.dbPath ?? config.dbPath);
  const app = createApp();
  const server = await new Promise<Server>((ok) => {
    const s = app.listen(opts.port ?? config.port, () => ok(s));
  });
  const port = (server.address() as AddressInfo).port;
  if (!process.env.PUBLIC_URL) config.baseUrl = `http://localhost:${port}`;

  if (!worldSeeded()) {
    seedWorld();
    if (balance() === 0) credit(config.startingCredits, 'grant', 'Starting credits');
  }

  // Receipts expire on their own, so the state rules also run on a clock tick.
  const timer = setInterval(tick, 30_000);
  timer.unref();

  return {
    server,
    port,
    stop: () =>
      new Promise<void>((done) => {
        clearInterval(timer);
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
