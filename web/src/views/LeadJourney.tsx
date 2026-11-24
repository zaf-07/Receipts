import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LeadView, ReceiptView, Snapshot } from '../../../shared/types';
import { SIGNALS, bandFor } from '../../../shared/constants';
import { useUi } from '../api';
import { Chip, Empty, StateBadge, Tier, age, daysBetween, fmtDate, latest } from '../components';

// One lead, step by step: the path its receipts took from a public page to the human gate.
// Everything on the stage is read from the lead's real records. Nothing here is scripted.

interface P {
  x: number;
  y: number;
}

type NodeId = 'page0' | 'page1' | 'page2' | 'company' | 'person' | 'customer' | 'product' | 'draft' | 'skeptic' | 'human';
type Tone = 'good' | 'bad' | 'old' | 'ink' | 'ai' | 'plain';

const POS: Record<NodeId, P> = {
  page0: { x: 95, y: 122 },
  page1: { x: 80, y: 218 },
  page2: { x: 65, y: 314 },
  company: { x: 300, y: 200 },
  customer: { x: 520, y: 88 },
  person: { x: 500, y: 268 },
  product: { x: 700, y: 196 },
  skeptic: { x: 175, y: 408 },
  draft: { x: 362, y: 384 },
  human: { x: 572, y: 396 },
};

const STOP_AT = { contact: { x: 402, y: 236 }, send: { x: 468, y: 392 } };

interface Edge {
  from: NodeId;
  to: NodeId;
  tone: Tone;
}

interface Step {
  key: string;
  tag: string;
  tone: Tone;
  short: string;
  title: string;
  body: ReactNode;
  changed: string[];
  reveal: NodeId[];
  edges: Edge[];
  packets: (Edge & { delay?: number })[];
  focus: NodeId[];
  /** From this step on the Skeptic's verdicts are drawn on the source pages. */
  verdicts?: boolean;
  stop?: { at: P; label: string };
  gate?: 'closed' | 'open';
}

// ---------- isometric drawing ----------

const pts = (list: P[]) => list.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

/** Faces of a box standing on the floor at c. a and b are half-extents along the two floor axes, h is the height. */
function faces(c: P, a: number, b: number, h: number) {
  const R = { x: c.x + 0.866 * (a + b), y: c.y + 0.5 * (a - b) };
  const F = { x: c.x + 0.866 * (a - b), y: c.y + 0.5 * (a + b) };
  const L = { x: c.x - 0.866 * (a + b), y: c.y - 0.5 * (a - b) };
  const B = { x: c.x - 0.866 * (a - b), y: c.y - 0.5 * (a + b) };
  const up = (p: P) => ({ x: p.x, y: p.y - h });
  return { top: [up(L), up(B), up(R), up(F)], left: [L, F, up(F), up(L)], right: [F, R, up(R), up(F)], L, F, R, B, front: F.y };
}

function Box({ c, a, b, h, tone = 'plain', dashed = false }: { c: P; a: number; b: number; h: number; tone?: Tone; dashed?: boolean }) {
  const f = faces(c, a, b, h);
  return (
    <g className={`iso-box t-${tone} ${dashed ? 'dashed' : ''}`}>
      <polygon className="f-left" points={pts(f.left)} />
      <polygon className="f-right" points={pts(f.right)} />
      <polygon className="f-top" points={pts(f.top)} />
    </g>
  );
}

/** Short strokes on a slab's top face, running along one floor axis: lines of text on a page. */
function topLines(c: P, a: number, b: number, h: number, rows: number[]): [P, P][] {
  return rows.map((r) => {
    const mx = c.x - 0.866 * (r * b);
    const my = c.y - h + 0.5 * (r * b);
    return [
      { x: mx - 0.866 * a * 0.62, y: my - 0.5 * a * 0.62 },
      { x: mx + 0.866 * a * 0.62, y: my + 0.5 * a * 0.62 },
    ];
  });
}

function Label({ at, text, sub, tone = 'plain' }: { at: P; text: string; sub?: string; tone?: Tone }) {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const main = clip(text, 26);
  const w = Math.max(main.length * 7.1, (sub ? clip(sub, 30).length : 0) * 5.9) + 20;
  const h = sub ? 34 : 22;
  return (
    <g className={`iso-label t-${tone}`}>
      <rect x={at.x - w / 2} y={at.y - 11} width={w} height={h} rx={11} />
      <text x={at.x} y={at.y + 4.5}>
        {main}
      </text>
      {sub && (
        <text className="sub" x={at.x} y={at.y + 17}>
          {clip(sub, 30)}
        </text>
      )}
    </g>
  );
}

function Mark({ at, ok }: { at: P; ok: boolean }) {
  return (
    <g className={`iso-mark ${ok ? 'ok' : 'no'}`}>
      <circle cx={at.x} cy={at.y} r={10} />
      {ok ? (
        <path d={`M ${at.x - 4.5} ${at.y + 0.5} l 3 3.2 l 6 -7`} />
      ) : (
        <path d={`M ${at.x - 4} ${at.y - 4} l 8 8 M ${at.x + 4} ${at.y - 4} l -8 8`} />
      )}
    </g>
  );
}

function Barrier({ at, open = false }: { at: P; open?: boolean }) {
  const l = { x: at.x - 24, y: at.y - 12 };
  const r = { x: at.x + 24, y: at.y + 12 };
  const top = 24;
  const tip = open ? { x: l.x + 22, y: l.y - top - 34 } : { x: r.x, y: r.y - top };
  return (
    <g className={`iso-gate ${open ? 'open' : 'closed'}`}>
      <Box c={l} a={4.5} b={4.5} h={top} tone="ink" />
      <Box c={r} a={4.5} b={4.5} h={top} tone="ink" />
      <line className="bar" x1={l.x} y1={l.y - top} x2={tip.x} y2={tip.y} />
    </g>
  );
}

function Packet({ a, b, tone, delay = 0, motion }: { a: P; b: P; tone: Tone; delay?: number; motion: boolean }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!motion) return;
    let raf = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / 950));
      setT(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [delay, motion]);
  if (t <= 0 || t >= 1) return null;
  const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  const hop = Math.sin(e * Math.PI) * 10;
  return <circle className={`iso-packet t-${tone}`} cx={a.x + (b.x - a.x) * e} cy={a.y + (b.y - a.y) * e - 10 - hop} r={6.5} />;
}

function trim(a: P, b: P, by: number): [P, P] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const k = Math.min(by, len / 2 - 4) / len;
  return [
    { x: a.x + dx * k, y: a.y + dy * k },
    { x: b.x - dx * k, y: b.y - dy * k },
  ];
}

// ---------- the story of one lead ----------

interface Story {
  pages: ReceiptView[];
  steps: Step[];
}

function pageTone(r: ReceiptView): Tone {
  if (r.sign === 'negative') return 'bad';
  return 'good';
}

function signalName(r: ReceiptView): string {
  return r.field === 'region_exclusion' ? 'Outside served regions' : SIGNALS[r.signal_type].label;
}

function buildStory(lead: LeadView, snap: Snapshot): Story {
  const now = snap.now;
  const c = lead.company;
  const product = snap.profile?.product_name ?? 'our product';
  const message = lead.message;
  const cited = new Set((message?.sentences ?? []).flatMap((s) => s.receipt_ids));
  const intent = new Map((lead.score_inputs?.intent ?? []).map((i) => [i.receipt_id, i]));

  const signals = lead.receipts.filter((r) => r.field === 'signal' || r.field === 'region_exclusion');
  const rank = (r: ReceiptView) => (cited.has(r.id) ? 0 : r.sign === 'negative' && r.live ? 1 : r.live ? 2 : 3);
  const pages = [...signals].sort((a, b) => rank(a) - rank(b) || (intent.get(b.id)?.points ?? 0) - (intent.get(a.id)?.points ?? 0)).slice(0, 3);
  const pageIds = pages.map((_, i) => `page${i}` as NodeId);
  const chips = (list: (ReceiptView | undefined)[]) => (
    <div className="chips">
      {list
        .filter((r): r is ReceiptView => Boolean(r))
        .map((r) => (
          <Chip key={r.id} r={r} now={now} />
        ))}
    </div>
  );

  const steps: Step[] = [];
  const top = pages[0];
  const facts = (['industry', 'headcount', 'region'] as const).map((f) => latest(lead.receipts, c.id, f));

  // 1 and 2: a page, then a receipt
  if (top) {
    steps.push({
      key: 'page',
      tag: 'Signal',
      tone: pageTone(top),
      short: 'A page',
      title: pages.length === 1 ? 'A public page says something' : `${pages.length} public pages say something`,
      body: (
        <>
          <p>
            It starts outside the product. {c.name} published this{top.event_at ? ` ${age(top.event_at, now)}` : ''}:
          </p>
          <blockquote>{top.snippet}</blockquote>
          <p>Nobody typed this in. There is no Create Record button.</p>
        </>
      ),
      changed: pages.map((p) => `${signalName(p)}${p.event_at ? `, dated ${fmtDate(p.event_at)}` : ''}`),
      reveal: pageIds,
      edges: [],
      packets: [],
      focus: pageIds,
    });
    steps.push({
      key: 'receipt',
      tag: 'Researcher',
      tone: 'ai',
      short: 'Receipt',
      title: 'Read it, quote it, date it',
      body: (
        <>
          <p>
            The Researcher reads each page and writes a <b>receipt</b>: the claim, the exact words that support it, the source, whether it is a reason to contact or
            a reason not to, and when it stops counting.
          </p>
          <p>A claim whose words are not on the page is rejected before it is ever stored.</p>
          {chips(pages)}
        </>
      ),
      changed: [`${lead.receipts.filter((r) => r.entity_id === c.id).length} receipts written for ${c.name}`, 'Each one has an expiry date'],
      reveal: ['company'],
      edges: pageIds.map((id, i) => ({ from: id, to: 'company' as NodeId, tone: pageTone(pages[i]) })),
      packets: pageIds.map((id, i) => ({ from: id, to: 'company' as NodeId, tone: pageTone(pages[i]), delay: i * 260 })),
      focus: ['company'],
    });
  } else {
    steps.push({
      key: 'receipt',
      tag: 'Researcher',
      tone: 'ai',
      short: 'Account',
      title: 'An account is found',
      body: (
        <>
          <p>The Researcher found {c.name} and wrote a receipt for each fact it could quote from the company's own site.</p>
          {chips(facts)}
        </>
      ),
      changed: [`${lead.receipts.filter((r) => r.entity_id === c.id).length} receipts written for ${c.name}`],
      reveal: ['company'],
      edges: [],
      packets: [],
      focus: ['company'],
    });
  }

  // 3: fit
  const fit = lead.score_inputs?.fit;
  steps.push({
    key: 'fit',
    tag: 'Fit',
    tone: 'ink',
    short: 'Fit',
    title: 'Does the company fit?',
    body: (
      <>
        <p>Half the score is fit against the ICP. Every input is a receipt you can open.</p>
        {fit && (
          <table className="mini">
            <tbody>
              {(
                [
                  ['Industry', fit.industry, facts[0]],
                  ['Headcount', fit.headcount, facts[1]],
                  ['Region', fit.region, facts[2]],
                ] as const
              ).map(([label, part, r]) => (
                <tr key={label} className={part.matched ? '' : 'miss'}>
                  <td>{label}</td>
                  <td>
                    {part.value ?? 'unknown'} {r && <Chip r={r} now={now} />}
                  </td>
                  <td className="num">
                    {part.points}/{part.max}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    ),
    changed: [`Fit ${lead.fit_score} of 100`, [c.industry, bandFor(c.headcount), c.region].filter(Boolean).join(' · ')],
    reveal: [],
    edges: [],
    packets: [],
    focus: ['company'],
  });

  // 4: is there a live reason? This is where restraint happens.
  const progressed = lead.state === 'active' || lead.person !== null || message !== null || lead.stage !== 'Matched';
  const reason = lead.receipts.find((r) => r.id === lead.reason_receipt_id);
  if (!progressed) {
    steps.push({
      key: 'held',
      tag: lead.state === 'disqualified' ? 'Disqualified' : 'Not yet',
      tone: lead.state === 'disqualified' ? 'bad' : 'old',
      short: 'Held back',
      title: lead.state === 'disqualified' ? 'A reason not to contact' : 'No reason to contact yet',
      body: (
        <>
          <p>{lead.dormant_reason}</p>
          {chips([reason])}
          <p>
            {lead.state === 'disqualified'
              ? 'A live negative receipt suppresses the lead. It expires too, and the lead is reconsidered when it does.'
              : 'No receipt, no action. The lead waits here and wakes up on its own when a new signal arrives.'}
          </p>
          <p>No contact was looked up, no credits were spent, and nothing was written.</p>
        </>
      ),
      changed: ['Held in the Not yet queue', 'The pipeline stops here'],
      reveal: [],
      edges: [],
      packets: [],
      focus: pageIds,
      stop: { at: STOP_AT.contact, label: 'No receipt, no action' },
    });
    return { pages, steps };
  }

  const liveTop = pages.find((p) => p.sign === 'positive' && intent.has(p.id)) ?? pages.find((p) => p.sign === 'positive');
  steps.push({
    key: 'fresh',
    tag: 'Why now',
    tone: 'good',
    short: 'Fresh?',
    title: 'Is the reason still fresh?',
    body: (
      <>
        <p>The other half of the score is intent: each live trigger's weight, times a freshness that falls from 1 to 0.15 across the signal's window.</p>
        {lead.score_inputs && lead.score_inputs.intent.length > 0 ? (
          <table className="mini">
            <tbody>
              {lead.score_inputs.intent.map((i) => {
                const r = lead.receipts.find((x) => x.id === i.receipt_id);
                return (
                  <tr key={i.receipt_id}>
                    <td>{SIGNALS[i.signal_type].label}</td>
                    <td>
                      {i.weight} × {i.freshness} {r && <Chip r={r} now={now} />}
                    </td>
                    <td className="num">{i.points}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          liveTop && (
            <p>
              When this lead was worked, {signalName(liveTop).toLowerCase()} was inside its {SIGNALS[liveTop.signal_type].window}-day window.
            </p>
          )
        )}
        {liveTop?.expires_at && liveTop.live && <p>The strongest reason expires in {daysBetween(now, liveTop.expires_at)} days. After that this lead goes back to Not yet by itself.</p>}
      </>
    ),
    changed: [`Intent ${lead.intent_score} of 100`, `Score ${lead.score}, tier ${lead.tier}`],
    reveal: [],
    edges: [],
    packets: [],
    focus: pageIds,
  });

  // 5: contact
  const p = lead.person;
  if (!p) {
    const gated = lead.enrich_status === 'blocked_credits';
    steps.push({
      key: 'nocontact',
      tag: gated ? 'Credit gate' : 'Enricher',
      tone: gated ? 'bad' : 'old',
      short: gated ? 'Gate' : 'Contact',
      title: gated ? 'The credit gate holds it' : lead.enrich_status === 'unresolved' ? 'No contact, and no guess' : 'Waiting for the Enricher',
      body: (
        <>
          <p>{lead.enrich_note ?? 'This lead has a live reason and is next in line for enrichment.'}</p>
          <p>
            {gated
              ? 'Enrichment is metered. The pipeline stops itself and says so, rather than running up a bill or skipping the check.'
              : 'An unresolved contact is shown as unresolved. Receipts will not invent a person to write to.'}
          </p>
        </>
      ),
      changed: [gated ? `Balance ${snap.credits.balance}, enrichment costs ${snap.credits.costs.enrich}` : 'No contact resolved', 'Nothing was written'],
      reveal: [],
      edges: [],
      packets: [],
      focus: ['company'],
      stop: { at: STOP_AT.contact, label: gated ? 'Top up to continue' : 'Nobody to write to' },
    });
    return { pages, steps };
  }
  const contact = latest(lead.receipts, p.id, 'contact');
  const email = latest(lead.receipts, p.id, 'email');
  steps.push({
    key: 'contact',
    tag: 'Enricher',
    tone: 'ai',
    short: 'Contact',
    title: 'Who to reach',
    body: (
      <>
        <p>
          The Enricher reads the people {c.name} names in public and picks the closest match to the ICP personas: <b>{p.name}</b>, {p.title}.
        </p>
        {chips([contact, email])}
        {p.email_status === 'guessed' ? (
          <p className="flag">
            The email is not published. <span className="mono">{p.email}</span> is a pattern guess with no receipt, and the lead is marked low confidence instead of
            pretending.
          </p>
        ) : (
          <p>
            The email address is printed on the team page, so it has a receipt too: <span className="mono">{p.email}</span>
          </p>
        )}
      </>
    ),
    changed: [`${p.name}, ${p.title}`, p.email_status === 'guessed' ? 'Email guessed: low confidence' : 'Email verified on the page'],
    reveal: ['person'],
    edges: [{ from: 'company', to: 'person', tone: 'ink' }],
    packets: [{ from: 'company', to: 'person', tone: 'ai' }],
    focus: ['person'],
  });

  // 6: warm intro
  const warm = lead.receipts.find((r) => r.field === 'previous_company' && r.data.company === lead.warm_intro);
  if (lead.warm_intro && warm) {
    steps.push({
      key: 'warm',
      tag: 'Warm intro',
      tone: 'ai',
      short: 'Warm intro',
      title: 'They already know us',
      body: (
        <>
          <p>
            {p.name.split(' ')[0]} used to work at <b>{lead.warm_intro}</b>, which is already a {product} customer. That edge exists in the graph because a receipt
            says so.
          </p>
          {chips([warm])}
        </>
      ),
      changed: [`Previously employed at ${lead.warm_intro}`],
      reveal: ['customer'],
      edges: [{ from: 'person', to: 'customer', tone: 'ai' }],
      packets: [{ from: 'person', to: 'customer', tone: 'ai' }],
      focus: ['customer'],
    });
  }

  // 7: why us
  steps.push({
    key: 'match',
    tag: 'Match',
    tone: 'ink',
    short: 'Why us',
    title: 'Why this person, why now, why us',
    body: (
      <>
        <p>The path is complete: a signal, the company it belongs to, the person to reach, and the product.</p>
        <p className="quote">{snap.profile?.description.split(/(?<=[.!?])\s+/)[0]}</p>
        <p>That last line is our own claim from the intake. It is the only part of the path with no receipt, and the email will treat it that way.</p>
      </>
    ),
    changed: [`Matched to ${product}`, `Score ${lead.score}, tier ${lead.tier}`],
    reveal: ['product'],
    edges: [{ from: 'person', to: 'product', tone: 'good' }],
    packets: [{ from: 'person', to: 'product', tone: 'good' }],
    focus: ['product'],
  });

  // 8: writer
  if (!message) {
    steps.push({
      key: 'nodraft',
      tag: 'Writer',
      tone: 'old',
      short: 'Draft',
      title: 'No draft yet',
      body: <p>{snap.credits.balance < snap.credits.costs.draft ? 'Drafting is metered and the balance is too low. Top up to continue.' : 'The Writer has not reached this lead yet.'}</p>,
      changed: ['Waiting'],
      reveal: [],
      edges: [],
      packets: [],
      focus: ['person'],
    });
    return { pages, steps };
  }
  const claims = message.sentences.filter((s) => s.kind === 'claim');
  steps.push({
    key: 'draft',
    tag: 'Writer',
    tone: 'old',
    short: 'Draft',
    title: 'Write only what has a receipt',
    body: (
      <>
        <p>The email is a list of sentences. Each is a claim or a connective, and each claim names the receipts it rests on.</p>
        <ul className="sentences">
          {claims.map((s, i) => (
            <li key={i}>
              <span>{s.text}</span>
              {chips(s.receipt_ids.map((id) => lead.receipts.find((r) => r.id === id)))}
            </li>
          ))}
        </ul>
        <p>A claim with no receipt, or a figure that is not in its source, fails the format check before anyone reads it.</p>
      </>
    ),
    changed: [`${claims.length} claim${claims.length === 1 ? '' : 's'} drafted`, `${message.sentences.length - claims.length} connective sentences`],
    reveal: ['draft'],
    edges: [{ from: 'company', to: 'draft', tone: 'old' }],
    packets: claims.slice(0, 3).map((_, i) => ({ from: 'company' as NodeId, to: 'draft' as NodeId, tone: 'old' as Tone, delay: i * 260 })),
    focus: ['draft'],
  });

  // 9: skeptic
  const struck = claims.filter((s) => s.status === 'struck');
  const citedPages = pageIds.filter((_, i) => cited.has(pages[i].id));
  steps.push({
    key: 'skeptic',
    tag: 'Skeptic',
    tone: struck.length ? 'bad' : 'good',
    short: 'Skeptic',
    title: 'Re-open every source',
    body: (
      <>
        <p>Before a person sees the draft, the Skeptic fetches each cited page again and looks for the quoted words. Gone, unreachable or changed all count as failed.</p>
        <ul className="sentences">
          {claims.map((s, i) => (
            <li key={i} className={s.status === 'struck' ? 'struck' : 'ok'}>
              <span>{s.text}</span>
              <em>{s.status === 'struck' ? `Struck: ${s.strike_reason}` : 'Still on the page'}</em>
            </li>
          ))}
        </ul>
      </>
    ),
    changed: [`${claims.length - struck.length} verified against the live page`, `${struck.length} struck`],
    reveal: ['skeptic'],
    edges: [{ from: 'draft', to: 'skeptic', tone: 'bad' }, ...citedPages.map((id) => ({ from: 'skeptic' as NodeId, to: id, tone: 'bad' as Tone }))],
    packets: [{ from: 'draft', to: 'skeptic', tone: 'bad' }, ...citedPages.map((id, i) => ({ from: 'skeptic' as NodeId, to: id, tone: 'bad' as Tone, delay: 800 + i * 220 }))],
    focus: ['skeptic', ...citedPages],
    verdicts: true,
  });

  // 10: the human gate
  if (message.status === 'blocked') {
    steps.push({
      key: 'blocked',
      tag: 'Blocked',
      tone: 'bad',
      short: 'Blocked',
      title: 'Nothing true left to send',
      body: (
        <>
          <p>{message.block_reason}</p>
          <p>The draft never reaches the review queue. {lead.state !== 'active' ? `${c.name} goes back to Not yet: ${lead.dormant_reason}` : ''}</p>
        </>
      ),
      changed: ['Draft blocked before review', 'Counted in the catch rate'],
      reveal: [],
      edges: [],
      packets: [],
      focus: ['draft'],
      verdicts: true,
      stop: { at: STOP_AT.send, label: 'Blocked by the Skeptic' },
    });
    return { pages, steps };
  }

  const sent = message.status === 'sent';
  const rejected = message.status === 'rejected';
  steps.push({
    key: 'human',
    tag: 'Human',
    tone: sent ? 'good' : rejected ? 'bad' : 'ink',
    short: sent ? 'Approved' : rejected ? 'Rejected' : 'Human',
    title: sent ? 'A person approved it' : rejected ? 'A person rejected it' : 'A person decides',
    body: sent ? (
      <>
        <p>
          {message.reviewer} approved the draft. The send was logged and the card moved from Matched to Contacted with an <b>AI</b> badge.
        </p>
        <p>Approval re-checks that every receipt is still live. Delivery is simulated in this build.</p>
      </>
    ) : rejected ? (
      <>
        <p>
          {message.reviewer} rejected the draft: {message.block_reason}
        </p>
        <p>Nothing was sent.</p>
      </>
    ) : (
      <>
        <p>The draft is in the review queue with struck sentences still visible. A person can approve, edit or reject.</p>
        <p>
          <b>Nothing sends without that click.</b>
        </p>
      </>
    ),
    changed: sent ? ['Send logged', 'Stage: Contacted, by AI'] : rejected ? ['Rejected', 'Nothing sent'] : ['Waiting in the review queue'],
    reveal: ['human'],
    edges: [{ from: 'draft', to: 'human', tone: 'ink' }, ...(sent ? [{ from: 'human' as NodeId, to: 'person' as NodeId, tone: 'good' as Tone }] : [])],
    packets: [{ from: 'draft', to: 'human', tone: 'ink' }, ...(sent ? [{ from: 'human' as NodeId, to: 'person' as NodeId, tone: 'good' as Tone, delay: 900 }] : [])],
    focus: ['human'],
    verdicts: true,
    gate: sent ? 'open' : 'closed',
  });

  // 11: learning
  if (lead.transitions.some((t) => t.to_stage === 'Replied')) {
    const learned = [...snap.icp_versions].reverse().find((v) => v.planned_by === 'analyst' && v.rationale.startsWith(c.name));
    steps.push({
      key: 'learn',
      tag: 'Analyst',
      tone: 'good',
      short: 'Learns',
      title: 'The reply teaches the ICP',
      body: (
        <>
          <p>{p.name.split(' ')[0]} replied. The Analyst looks at which receipts that email rested on and gives those signal types more weight.</p>
          {learned && <p className="quote">{learned.rationale}</p>}
          <p>The change is saved as a new ICP version you can diff, and every lead is rescored.</p>
        </>
      ),
      changed: [learned ? `ICP v${learned.version} saved` : 'Reply recorded', 'Every lead rescored'],
      reveal: [],
      edges: [{ from: 'person', to: 'product', tone: 'good' }],
      packets: [{ from: 'person', to: 'product', tone: 'good' }],
      focus: ['product', 'person'],
      verdicts: true,
      gate: 'open',
    });
  }

  // The clock keeps running after the pipeline is done with a lead.
  if (lead.state !== 'active' && !sent) {
    steps.push({
      key: 'lapsed',
      tag: lead.state === 'disqualified' ? 'Disqualified' : 'Not yet',
      tone: lead.state === 'disqualified' ? 'bad' : 'old',
      short: 'Held back',
      title: 'Later, the reason ran out',
      body: (
        <>
          <p>{lead.dormant_reason}</p>
          {chips([reason])}
          <p>State is re-derived on every clock tick, so the lead left the active list without anyone touching it.</p>
        </>
      ),
      changed: ['Back in the Not yet queue'],
      reveal: [],
      edges: [],
      packets: [],
      focus: pageIds,
      verdicts: true,
      stop: { at: STOP_AT.send, label: 'No live receipt' },
    });
  }
  return { pages, steps };
}

// ---------- the stage ----------

function Stage({ lead, story, index, run, motion }: { lead: LeadView; story: Story; index: number; run: number; motion: boolean }) {
  const { snap } = useUi();
  const now = snap.now;
  const step = story.steps[index];
  const seen = story.steps.slice(0, index + 1);
  const visible = new Set(seen.flatMap((s) => s.reveal));
  const fresh = new Set(step.reveal);
  const edges = seen.flatMap((s, i) => s.edges.map((e) => ({ ...e, fresh: i === index })));
  const verdicts = seen.some((s) => s.verdicts);
  const gate = [...seen].reverse().find((s) => s.gate)?.gate ?? 'closed';
  const focus = new Set(step.focus);
  const message = lead.message;
  const product = snap.profile?.product_name ?? 'Product';

  const order = (Object.keys(POS) as NodeId[]).filter((id) => visible.has(id)).sort((a, b) => POS[a].y - POS[b].y);

  const node = (id: NodeId): ReactNode => {
    const c = POS[id];
    if (id.startsWith('page')) {
      const r = story.pages[Number(id.slice(4))];
      if (!r) return null;
      // Until the Skeptic has looked, a page reads as it did when the Researcher found it.
      const failed = r.status === 'failed' && verdicts;
      const expired = r.expired && r.status !== 'failed';
      const tone: Tone = failed ? 'bad' : expired ? 'old' : pageTone(r);
      const checked = verdicts && (message?.sentences ?? []).some((s) => s.receipt_ids.includes(r.id));
      const sub = failed ? 'page gone or changed' : expired ? 'expired' : r.event_at ? age(r.event_at, now) : undefined;
      return (
        <>
          <Box c={c} a={24} b={17} h={7} tone={tone} dashed={failed || expired} />
          {topLines(c, 24, 17, 7, [-0.5, 0, 0.5]).map(([a, b], i) => (
            <line key={i} className={`iso-ink ${failed ? 'gone' : ''}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
          ))}
          <Label at={{ x: c.x + 6, y: c.y - (sub ? 56 : 44) }} text={signalName(r)} sub={sub} tone={tone} />
          {checked && <Mark at={{ x: c.x + 44, y: c.y - 6 }} ok={r.status !== 'failed'} />}
        </>
      );
    }
    if (id === 'company') {
      const f = faces(c, 27, 27, 56);
      const windows = [0.25, 0.5, 0.75].flatMap((k) => [18, 36].map((h) => ({ k, h })));
      return (
        <>
          <Box c={c} a={27} b={27} h={56} tone="plain" />
          {windows.map(({ k, h }, i) => {
            const lx = f.L.x + (f.F.x - f.L.x) * k;
            const ly = f.L.y + (f.F.y - f.L.y) * k;
            const rx = f.F.x + (f.R.x - f.F.x) * k;
            const ry = f.F.y + (f.R.y - f.F.y) * k;
            return (
              <g key={i}>
                <line className="iso-ink" x1={lx} y1={ly - h} x2={lx} y2={ly - h - 9} />
                <line className="iso-ink" x1={rx} y1={ry - h} x2={rx} y2={ry - h - 9} />
              </g>
            );
          })}
          <Label at={{ x: c.x, y: f.front + 16 }} text={lead.company.name} sub={[lead.company.industry, bandFor(lead.company.headcount)].filter(Boolean).join(' · ')} />
        </>
      );
    }
    if (id === 'person') {
      const guessed = lead.person?.email_status === 'guessed';
      return (
        <>
          <Box c={c} a={19} b={19} h={5} tone="plain" />
          <g className={`iso-figure ${guessed ? 'low' : ''}`}>
            <rect x={c.x - 9} y={c.y - 36} width={18} height={30} rx={9} />
            <circle cx={c.x} cy={c.y - 45} r={8.5} />
          </g>
          <Label at={{ x: c.x, y: c.y + 36 }} text={lead.person?.name ?? 'Contact'} sub={lead.person?.title} tone={guessed ? 'old' : 'ai'} />
        </>
      );
    }
    if (id === 'customer') {
      return (
        <>
          <Box c={c} a={19} b={19} h={26} tone="ai" />
          <Label at={{ x: c.x, y: c.y + 36 }} text={lead.warm_intro ?? 'Customer'} sub="existing customer" tone="ai" />
        </>
      );
    }
    if (id === 'product') {
      const f = faces(c, 29, 29, 44);
      return (
        <>
          <Box c={c} a={29} b={29} h={44} tone="ink" />
          <path className="iso-receipt" d={`M ${c.x - 9} ${c.y - 62} h 18 v 22 l -3 -2.5 l -3 2.5 l -3 -2.5 l -3 2.5 l -3 -2.5 l -3 2.5 z`} />
          <Label at={{ x: c.x, y: f.front + 16 }} text={product} tone="ink" />
        </>
      );
    }
    if (id === 'draft') {
      const f = faces(c, 26, 18, 6);
      const t = f.top;
      const mid = { x: (t[0].x + t[2].x) / 2, y: (t[0].y + t[2].y) / 2 + 3 };
      const claims = (message?.sentences ?? []).filter((s) => s.kind === 'claim');
      const struck = verdicts ? claims.filter((s) => s.status === 'struck').length : 0;
      return (
        <>
          <Box c={c} a={26} b={18} h={6} tone="plain" />
          <polyline className="iso-ink" points={pts([t[0], mid, t[1]])} />
          <Label at={{ x: c.x, y: f.front + 16 }} text={`Draft · ${claims.length} claim${claims.length === 1 ? '' : 's'}`} sub={struck ? `${struck} struck` : undefined} tone={struck ? 'bad' : 'plain'} />
        </>
      );
    }
    if (id === 'skeptic') {
      const f = faces(c, 20, 20, 30);
      return (
        <>
          <Box c={c} a={20} b={20} h={30} tone="bad" />
          <g className="iso-lens">
            <line x1={c.x + 7} y1={c.y - 41} x2={c.x + 15} y2={c.y - 31} />
            <circle cx={c.x} cy={c.y - 49} r={10} />
          </g>
          <Label at={{ x: c.x, y: f.front + 16 }} text="Skeptic" tone="bad" />
        </>
      );
    }
    return (
      <>
        <Barrier at={c} open={gate === 'open'} />
        <Label at={{ x: c.x, y: c.y + 34 }} text="Human gate" sub={gate === 'open' ? 'approved' : 'nothing sends without a click'} tone={gate === 'open' ? 'good' : 'ink'} />
      </>
    );
  };

  const grid: ReactNode[] = [];
  for (let i = -14; i <= 26; i++) {
    const o = i * 46;
    grid.push(<line key={`a${i}`} x1={o} y1={0} x2={o + 480 * 1.732} y2={480} />);
    grid.push(<line key={`b${i}`} x1={o} y1={0} x2={o - 480 * 1.732} y2={480} />);
  }

  return (
    <svg viewBox="0 0 800 480" className="iso" role="img" aria-label={`Step ${index + 1}: ${step.title}`}>
      <defs>
        <marker id="iso-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="context-stroke" />
        </marker>
        <clipPath id="iso-clip">
          <rect width="800" height="480" />
        </clipPath>
      </defs>
      <g className="iso-floor" clipPath="url(#iso-clip)">
        {grid}
      </g>

      {edges.map((e) => {
        const [a, b] = trim(POS[e.from], POS[e.to], e.from.startsWith('page') || e.to.startsWith('page') ? 34 : 40);
        return (
          <path
            key={`${e.from}>${e.to}`}
            className={`iso-edge t-${e.tone} ${e.fresh ? 'fresh' : ''}`}
            d={`M ${a.x.toFixed(1)} ${a.y.toFixed(1)} L ${b.x.toFixed(1)} ${b.y.toFixed(1)}`}
            pathLength={1}
            markerEnd="url(#iso-arrow)"
          />
        );
      })}

      {order.map((id) => (
        <g key={id} className={`iso-node ${fresh.has(id) ? 'enter' : ''} ${focus.has(id) ? 'focus' : ''}`}>
          {focus.has(id) && <ellipse className="iso-halo" cx={POS[id].x} cy={POS[id].y + 2} rx={id.startsWith('page') ? 50 : 58} ry={id.startsWith('page') ? 25 : 30} />}
          {node(id)}
        </g>
      ))}

      {step.stop && (
        <g className="iso-node enter">
          <Barrier at={step.stop.at} />
          <Label at={{ x: step.stop.at.x, y: step.stop.at.y + 34 }} text={step.stop.label} tone="bad" />
        </g>
      )}

      <g key={`${index}-${run}`}>
        {step.packets.map((pk, i) => (
          <Packet key={i} a={POS[pk.from]} b={POS[pk.to]} tone={pk.tone} delay={280 + (pk.delay ?? 0)} motion={motion} />
        ))}
      </g>
    </svg>
  );
}

// ---------- the screen ----------

export function LeadJourney() {
  const { snap, openLead } = useUi();
  const rank = { active: 0, not_yet: 1, disqualified: 2 };
  const leads = useMemo(() => [...snap.leads].sort((a, b) => rank[a.state] - rank[b.state] || b.score - a.score), [snap.leads]);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [run, setRun] = useState(0);
  // Motion follows the system's reduced-motion setting until the viewer says otherwise.
  // Pressing Play or Replay is the viewer asking for the animation, so it turns motion on.
  const systemReduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const [motion, setMotionState] = useState(() => {
    try {
      const saved = window.localStorage.getItem('receipts.motion');
      if (saved === 'on' || saved === 'off') return saved === 'on';
    } catch {
      // Storage unavailable: fall back to the system setting.
    }
    return !systemReduced;
  });
  const setMotion = (on: boolean) => {
    setMotionState(on);
    try {
      window.localStorage.setItem('receipts.motion', on ? 'on' : 'off');
    } catch {
      // Not remembered, still applied.
    }
  };
  const play = (fromStart: boolean) => {
    if (!motion) setMotion(true);
    if (fromStart) {
      setIndex(0);
      setRun((n) => n + 1);
    }
    setPlaying(true);
  };

  const lead = leads.find((l) => l.id === leadId) ?? leads[0];
  const story = useMemo(() => (lead ? buildStory(lead, snap) : null), [lead, snap]);
  const count = story?.steps.length ?? 0;
  const at = Math.min(index, Math.max(0, count - 1));

  useEffect(() => {
    if (!playing) return;
    if (at >= count - 1) {
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(() => setIndex(at + 1), 2600);
    return () => window.clearTimeout(t);
  }, [playing, at, count]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, .drawer')) return;
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(count - 1, i + 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'r' || e.key === 'R') play(true);
      else if (e.key === ' ') {
        e.preventDefault();
        if (playing) setPlaying(false);
        else play(at >= count - 1);
      } else return;
      if (e.key.startsWith('Arrow')) setPlaying(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [count, playing, at, motion]);

  if (!lead || !story) return <Empty title="Nothing to walk through yet">The journey is drawn from receipts. Run discovery first.</Empty>;

  const step = story.steps[at];
  const reached = (key: string) => {
    const i = story.steps.findIndex((s) => s.key === key);
    return i !== -1 && i <= at;
  };
  const claims = (lead.message?.sentences ?? []).filter((s) => s.kind === 'claim');
  const struck = claims.filter((s) => s.status === 'struck').length;
  const tiles: { label: string; value: string; on: boolean; tone?: Tone }[] = [
    { label: 'Receipts', value: String(lead.receipts.length), on: reached('receipt') },
    { label: 'Fit', value: `${lead.fit_score}`, on: reached('fit') },
    { label: 'Intent', value: `${lead.intent_score}`, on: reached('fresh') || reached('held') },
    { label: 'Score', value: `${lead.score} ${lead.tier}`, on: reached('fresh') || reached('held') },
    { label: 'Claims verified', value: `${claims.length - struck} of ${claims.length}`, on: reached('skeptic'), tone: struck ? 'bad' : 'good' },
  ];

  const pick = (id: string) => {
    setLeadId(id);
    setIndex(0);
    setRun((n) => n + 1);
    setPlaying(false);
  };

  return (
    <div className={`journey ${motion ? 'motion-on' : 'motion-off'}`}>
      <div className="journey-pick" role="tablist" aria-label="Choose a lead">
        {leads.map((l) => (
          <button key={l.id} type="button" role="tab" aria-selected={l.id === lead.id} className={`${l.id === lead.id ? 'active' : ''} s-${l.state}`} onClick={() => pick(l.id)}>
            <i />
            {l.company.name}
          </button>
        ))}
      </div>

      <div className="journey-body">
        <section className="journey-stage">
          <header>
            <div className="journey-tiles">
              {tiles.map((t) => (
                <div key={t.label} className={`jtile ${t.on ? `on t-${t.tone ?? 'ink'}` : ''}`}>
                  <span>{t.label}</span>
                  <strong>{t.on ? t.value : '–'}</strong>
                </div>
              ))}
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="btn small ghost"
                aria-pressed={motion}
                title={systemReduced ? 'Your system asks for reduced motion. This overrides it for this view only.' : 'Turn the animation on or off'}
                onClick={() => setMotion(!motion)}
              >
                Motion {motion ? 'on' : 'off'}
              </button>
              <button type="button" className="btn small" onClick={() => play(true)}>
                Replay
              </button>
              <button type="button" className="btn small primary" onClick={() => (playing ? setPlaying(false) : play(at >= count - 1))}>
                {playing ? 'Pause' : 'Play'}
              </button>
            </div>
          </header>
          <Stage lead={lead} story={story} index={at} run={run} motion={motion} />
          <ul className="journey-legend">
            <li className="k-good">reason to contact</li>
            <li className="k-bad">reason not to, or failed check</li>
            <li className="k-old">expired or unverified</li>
            <li className="k-ai">agent handoff</li>
          </ul>
        </section>

        <aside className="journey-panel" aria-live="polite">
          <header>
            <span className="muted mono">
              Step {at + 1} / {count}
            </span>
            <span className={`tag t-${step.tone}`}>{step.tag}</span>
          </header>
          <h2>{step.title}</h2>
          <div className="journey-text">{step.body}</div>
          <h4>What changed</h4>
          <ul className="changed">
            {step.changed.filter(Boolean).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <footer>
            <button
              type="button"
              className="btn"
              disabled={at === 0}
              onClick={() => {
                setPlaying(false);
                setIndex(at - 1);
              }}
            >
              Back
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={at >= count - 1}
              onClick={() => {
                setPlaying(false);
                setIndex(at + 1);
              }}
            >
              {at >= count - 1 ? 'End of the path' : `Next: ${story.steps[at + 1].short}`}
            </button>
          </footer>
          <p className="keys">
            <kbd>←</kbd> <kbd>→</kbd> step · <kbd>R</kbd> replay · <kbd>Space</kbd> play or pause
          </p>
          <div className="journey-lead">
            <StateBadge state={lead.state} /> <Tier tier={lead.tier} />
            <button type="button" className="link" onClick={() => openLead(lead.id)}>
              Open the full record
            </button>
          </div>
        </aside>

        <ol className="journey-steps">
        {story.steps.map((s, i) => (
          <li key={s.key} className={`${i === at ? 'current' : ''} ${i < at ? 'done' : ''} ${s.stop ? 'stop' : ''}`}>
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setIndex(i);
              }}
              aria-current={i === at ? 'step' : undefined}
            >
              <b>{i + 1}</b>
              <span>{s.short}</span>
            </button>
          </li>
        ))}
        </ol>
      </div>
    </div>
  );
}
