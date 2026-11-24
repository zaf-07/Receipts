import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../shared/types';
import { call } from '../api';

// The guided demo. It drives the real app through the demo script, with the narration on screen,
// so a recording needs nothing but pressing record. Nothing here is faked: every step calls the
// same actions a person would, and waits for the real pipeline to finish.

interface Controls {
  go: (view: string) => void;
  act: (path: string, body?: unknown) => Promise<boolean>;
  openLead: (id: string | null) => void;
  setFeed: (open: boolean) => void;
  snap: () => Snapshot;
}

interface Beat {
  say: string;
  /** Seconds to stay on this beat after its action has finished. */
  hold: number;
  run?: (c: Controls, t: Tools) => Promise<void>;
}

interface Tools {
  wait: (ms: number) => Promise<void>;
  /** Wait for the pipeline to go quiet, then for a condition on the fresh snapshot. */
  settled: (ready?: (s: Snapshot) => boolean) => Promise<void>;
  click: (selector: string, text?: string) => boolean;
  show: (selector: string) => void;
  top: () => void;
}

const pendingEmail = (s: Snapshot) =>
  s.leads
    .flatMap((l) => l.messages.map((m) => ({ lead: l, message: m })))
    .filter((x) => x.message.status === 'pending_review' && x.message.channel === 'email')
    .sort((a, b) => b.lead.score - a.lead.score);

const BEATS: Beat[] = [
  {
    say: 'Receipts is a GTM agent that only acts when it can prove why now.',
    hold: 4,
    run: async (c, t) => {
      c.setFeed(false);
      c.openLead(null);
      await c.act('/demo/reset');
      c.go('intake');
      await t.settled((s) => s.leads.length === 0 && !s.icp);
    },
  },
  {
    say: 'We give it two lines about the product. The Planner infers the ideal customer, with a confidence on every field.',
    hold: 6,
    run: async (c, t) => {
      await c.act('/intake', await call('/example'));
      await t.settled((s) => Boolean(s.icp));
      t.top();
    },
  },
  {
    say: 'It proposes adjacent segments with its reasoning. We accept one and dismiss the other.',
    hold: 5,
    run: async (c, t) => {
      const [first, second] = c.snap().icp?.expansions ?? [];
      t.show('.expansions');
      await t.wait(1200);
      if (first) await c.act(`/icp/expansions/${first.id}`, { decision: 'accepted' });
      if (second) await c.act(`/icp/expansions/${second.id}`, { decision: 'dismissed' });
    },
  },
  {
    say: 'Discovery. Every fact is a receipt: a claim, the exact words that support it, and the page they came from. Nothing here was typed in.',
    hold: 5,
    run: async (c, t) => {
      await c.act('/run');
      c.go('accounts');
      await t.settled((s) => s.leads.length > 0);
      t.top();
    },
  },
  {
    say: 'Click any cell. The quoted source, when it expires, and whether the Skeptic has re-checked it.',
    hold: 7,
    run: async (_c, t) => {
      t.click('.grid td.why .chip');
    },
  },
  {
    say: 'This is what a typical AI SDR sends to the same lead. Every red line is a claim with no source.',
    hold: 7,
    run: async (c, t) => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const best = [...c.snap().leads].filter((l) => l.state === 'active').sort((a, b) => b.score - a.score)[0];
      if (best) c.openLead(best.id);
      await t.wait(900);
      t.click('.drawer .tabs.mini button', 'Without');
      await t.wait(300);
      t.show('.drawer .contrast');
    },
  },
  {
    say: 'Eight agents work in parallel under one orchestrator. One task per account, per lead, per draft. Each is leased, retried if its worker stops, and settled once.',
    hold: 9,
    run: async (c, t) => {
      c.openLead(null);
      c.go('team');
      t.top();
    },
  },
  {
    say: 'Follow one lead. A page says something, a receipt is written, and the Writer cites it.',
    hold: 11,
    run: async (c, t) => {
      c.go('graph');
      await t.wait(700);
      if (!t.click('.journey-pick button', 'Vectorly')) t.click('.journey-pick button');
      await t.wait(400);
      // Bring the stage to the top so the narration bar does not cover it.
      document.querySelector('.journey-stage')?.scrollIntoView({ block: 'start' });
      t.click('.journey-stage .btn', 'Play');
    },
  },
  {
    say: 'Then the Skeptic re-opens every source. A job posting has been taken down, so that sentence is struck before any person sees it.',
    hold: 13,
  },
  {
    say: 'And these are the leads it refused to contact: no trigger, an expired one, or a reason not to. Restraint is a state, not a filter.',
    hold: 8,
    run: async (c, t) => {
      c.go('not-yet');
      t.top();
    },
  },
  {
    say: 'Nothing sends without a person. We approve one draft and reject another.',
    hold: 7,
    run: async (c, t) => {
      c.go('review');
      t.top();
      await t.wait(2500);
      const reviewer = c.snap().profile?.sender || 'Reviewer';
      const [yes, no] = pendingEmail(c.snap());
      if (yes) await c.act(`/messages/${yes.message.id}/approve`, { reviewer });
      if (no) await c.act(`/messages/${no.message.id}/reject`, { reviewer, note: 'Not specific enough.' });
    },
  },
  {
    say: 'The approved card moved to Contacted with an AI badge. Every move records who made it.',
    hold: 6,
    run: async (c, t) => {
      c.go('pipeline');
      t.top();
    },
  },
  {
    say: 'New signals arrive and a dormant lead wakes up. Enriching it needs credits we do not have, so the pipeline stops itself and says so.',
    hold: 8,
    run: async (c, t) => {
      await c.act('/ingest');
      c.go('not-yet');
      await t.settled();
      c.go('team');
      t.top();
    },
  },
  {
    say: 'A lead replies. The signal that earned the reply gains weight, and the next version of the ICP appears as a diff.',
    hold: 8,
    run: async (c, t) => {
      const contacted = c.snap().leads.find((l) => l.stage === 'Contacted');
      if (contacted) await c.act(`/leads/${contacted.id}/stage`, { to_stage: 'Replied', actor: c.snap().profile?.sender || 'Rep' });
      await t.settled((s) => s.icp_versions.length > 1 || !contacted);
      c.go('intake');
      await t.wait(500);
      t.show('.versions');
    },
  },
  {
    say: 'Catch rate: the share of drafted claims we struck before a human saw them. Proof is what licenses autonomy.',
    hold: 8,
    run: async (c, t) => {
      c.go('dashboard');
      t.top();
    },
  },
  { say: 'Receipts. No receipt, no action.', hold: 4 },
];

export function Tour({ controls, onDone }: { controls: Controls; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(true);
  const live = useRef(true);
  const latest = useRef(controls);
  latest.current = controls;

  useEffect(() => {
    live.current = true;
    const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
    const tools: Tools = {
      wait,
      settled: async (ready) => {
        // Give the server a moment to start, then wait until it is idle and the snapshot has caught up.
        await wait(500);
        for (let i = 0; i < 600 && live.current; i++) {
          const s = latest.current.snap();
          if (!s.running && (!ready || ready(s))) return;
          await wait(200);
        }
      },
      click: (selector, text) => {
        const all = [...document.querySelectorAll<HTMLElement>(selector)];
        const el = text ? all.find((e) => e.textContent?.trim() === text) : all[0];
        el?.click();
        return Boolean(el);
      },
      show: (selector) => document.querySelector(selector)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      top: () => document.querySelector('.main')?.scrollTo({ top: 0 }),
    };
    void (async () => {
      for (let i = 0; i < BEATS.length && live.current; i++) {
        setIndex(i);
        setBusy(true);
        const proxy: Controls = {
          go: (v) => latest.current.go(v),
          act: (p, b) => latest.current.act(p, b),
          openLead: (id) => latest.current.openLead(id),
          setFeed: (o) => latest.current.setFeed(o),
          snap: () => latest.current.snap(),
        };
        try {
          await BEATS[i].run?.(proxy, tools);
        } catch {
          // A step that cannot run is skipped. The narration still moves on.
        }
        setBusy(false);
        await wait(BEATS[i].hold * 1000);
      }
      if (live.current) onDone();
    })();
    return () => {
      live.current = false;
    };
    // The tour runs once, from the moment it is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="tour-bar" role="status" aria-live="polite">
      <p>{BEATS[index].say}</p>
      <div className="tour-foot">
        <span className="tour-dots" aria-hidden="true">
          {BEATS.map((_, i) => (
            <i key={i} className={i < index ? 'done' : i === index ? 'now' : ''} />
          ))}
        </span>
        <span className="tour-step">
          {index + 1} / {BEATS.length}
          {busy ? ' · working' : ''}
        </span>
        <button type="button" className="link" onClick={onDone}>
          stop
        </button>
      </div>
    </div>
  );
}
