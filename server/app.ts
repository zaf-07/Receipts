import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { once } from 'node:events';
import type { Profile, Stage } from '../shared/types';
import { REGIONS } from '../shared/constants';
import { config } from './config';
import { initDb } from './db';
import { changed, log, subscribe } from './services/activity';
import { balance, credit } from './services/ledger';
import { GRAPH_QUESTIONS, buildGraph, buildSnapshot, contrastEmail, graphQuery, whyNow } from './services/snapshot';
import { searchPipeline } from './services/moss';
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
  receiveInboundReply,
  reject,
  resetDemo,
  resume,
  retry,
  syncBilling,
  reverify,
  startGoal,
  tick,
  topUp,
  wake,
} from './agents/orchestrator';
import { setPageStatus, seedWorld, worldRouter, worldSeeded } from './world/world';
import { EXAMPLE_PROFILE } from './world/seed';
import { AGENT_ROLES, bandEnabled, bandStatus, connectBand, pollBand } from './integrations/band';
import { flexpriceEnabled } from './integrations/flexprice';
import { addTaskMessage, createManualTask, setManualStatus } from './services/tasks';
import { validInboundSignature } from './services/security';

const text = (v: unknown, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown) =>
  (Array.isArray(v) ? v.map((x) => text(x, 200)) : text(v).split(/[,\n]/).map((x) => x.trim())).filter(Boolean).slice(0, 30);

/** Long pipeline work runs in the background. Progress and failures both arrive through the activity feed. */
function background(work: Promise<unknown>): void {
  work.catch((err) => {
    if (!(err instanceof UserError)) console.error(err);
  });
}

type RawRequest = Request & { rawBody?: Buffer };

export function createApp() {
  const app = express();
  app.use(
    express.json({
      limit: '200kb',
      verify: (req, _res, buffer) => {
        (req as RawRequest).rawBody = Buffer.from(buffer);
      },
    }),
  );

  // The seeded demo world: fictional company sites, served as real pages.
  app.use('/world', worldRouter());

  const api = express.Router();

  api.get('/snapshot', (_req, res) => res.json(buildSnapshot(currentRun())));
  api.get('/example', (_req, res) => res.json(EXAMPLE_PROFILE));
  api.get('/roles', (_req, res) => res.json(AGENT_ROLES));
  api.get('/band/status', (_req, res) =>
    res.json({
      ...bandStatus(),
      mode: bandEnabled() ? 'Band room: mention handoffs, human decisions and execution events' : 'local activity stream only',
      roles: AGENT_ROLES,
    }),
  );

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

  api.post('/tasks', (req, res) => {
    try {
      res.status(201).json(
        createManualTask({
          title: text(req.body.title, 160),
          detail: text(req.body.detail, 1200),
          agent: text(req.body.agent, 40),
          depends_on: Array.isArray(req.body.depends_on) ? req.body.depends_on.map((id: unknown) => text(id, 120)) : [],
          lead_id: text(req.body.lead_id, 120) || null,
        }),
      );
    } catch (err) {
      throw new UserError(err instanceof Error ? err.message : 'Could not create the task.');
    }
  });

  api.post('/goals', async (req, res) => {
    res.status(202).json(await startGoal(text(req.body.goal, 1200)));
  });

  api.post('/tasks/:id/status', (req, res) => {
    try {
      res.json(setManualStatus(req.params.id, text(req.body.status, 20)));
    } catch (err) {
      throw new UserError(err instanceof Error ? err.message : 'Could not update the task.');
    }
  });

  api.post('/tasks/:id/retry', (req, res) => {
    try {
      res.json(retry(req.params.id));
    } catch (err) {
      throw new UserError(err instanceof Error ? err.message : 'Could not retry the task.');
    }
  });

  api.post('/tasks/:id/messages', (req, res) => {
    try {
      res.status(201).json(addTaskMessage(req.params.id, { author: text(req.body.author, 80) || 'Human', body: text(req.body.body, 1600) }));
    } catch (err) {
      throw new UserError(err instanceof Error ? err.message : 'Could not send the message.');
    }
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
  api.get('/graph/questions', (_req, res) => res.json(GRAPH_QUESTIONS));
  api.get('/graph/query/:name', (req, res) => {
    const answer = graphQuery(req.params.name);
    if (!answer) throw new UserError('Unknown graph question.');
    changed();
    res.json(answer);
  });
  api.get('/search', async (req, res) => {
    const query = text(req.query.q, 500);
    if (query.length < 3) throw new UserError('Use at least three characters to search the pipeline.');
    const limit = Math.min(20, Math.max(1, Math.round(Number(req.query.limit) || 8)));
    res.json({ query, results: await searchPipeline(query, limit) });
  });
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

  /** Provider adapters POST the Receipts message id and the plain-text reply here. */
  api.post('/inbound', (req, res) => {
    if (config.inboundWebhookSecret) {
      const signed = req as RawRequest;
      if (!validInboundSignature(signed.rawBody ?? Buffer.alloc(0), req.get('x-receipts-signature'), config.inboundWebhookSecret)) {
        throw new UserError('Inbound signature could not be verified.');
      }
    }
    const messageId = text(req.body.message_id, 120);
    const reply = text(req.body.text, 4000);
    if (!messageId || !reply) throw new UserError('message_id and reply text are required.');
    res.json(receiveInboundReply(messageId, reply, text(req.body.source, 80) || 'inbound webhook'));
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
  const server = app.listen(opts.port ?? config.port);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not expose a TCP address after listening.');
  const port = (address as AddressInfo).port;
  if (!process.env.PUBLIC_URL) config.baseUrl = `http://localhost:${port}`;

  if (!worldSeeded()) {
    seedWorld();
    if (balance() === 0) credit(config.startingCredits, 'grant', 'Starting credits');
  }
  // Tasks that were running when the server last stopped still hold a lease. Once it expires they are
  // taken back and retried, so a restart resumes the pipeline instead of losing work.
  const waker = setInterval(wake, Math.min(5000, Math.max(250, Math.floor(config.leaseMs / 2))));
  waker.unref();
  wake();

  // Join the Band room when one is configured, then listen for what people say in it.
  let listener: NodeJS.Timeout | null = null;
  if (bandEnabled()) {
    log('system', 'info', await connectBand());
    let polling = false;
    listener = setInterval(() => {
      if (polling) return;
      polling = true;
      void pollBand().finally(() => {
        polling = false;
      });
    }, config.band.pollMs);
    listener.unref();
  }

  // Find the Flexprice wallet when one is configured, then keep the balance in step with it.
  let billing: NodeJS.Timeout | null = null;
  if (flexpriceEnabled()) {
    await syncBilling();
    billing = setInterval(() => void syncBilling(), config.flexprice.syncMs);
    billing.unref();
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
        clearInterval(waker);
        if (listener) clearInterval(listener);
        if (billing) clearInterval(billing);
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
