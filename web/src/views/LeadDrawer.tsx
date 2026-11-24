import { useEffect, useState } from 'react';
import type { ContrastSentence, LeadView, ReceiptView, WhyStep } from '../../../shared/types';
import { SIGNALS, bandFor } from '../../../shared/constants';
import { call, useUi } from '../api';
import { Chip, Section, StateBadge, Tier, age, fmtDate, fmtTime } from '../components';
import { ReviewCard } from './Review';

function Why({ lead }: { lead: LeadView }) {
  const { snap } = useUi();
  const [steps, setSteps] = useState<WhyStep[] | null>(null);
  useEffect(() => {
    let live = true;
    void call<WhyStep[]>(`/leads/${lead.id}/why`).then((s) => live && setSteps(s));
    return () => {
      live = false;
    };
  }, [lead.id, lead.state, lead.person?.id, lead.receipts.length]);
  if (!steps) return <p className="muted">Reading the graph.</p>;
  return (
    <ol className="why-path">
      {steps.map((s, i) => (
        <li key={i} className={`why-step type-${s.node.type} ${s.node.id === 'none' ? 'missing' : ''}`}>
          <span className="why-q">{s.question}</span>
          <div>
            <strong>{s.node.label}</strong>
            <p>{s.answer}</p>
            <div className="chips">
              {s.receipt_ids.map((id) => {
                const r = lead.receipts.find((x) => x.id === id);
                return r ? <Chip key={id} r={r} now={snap.now} /> : null;
              })}
              {s.receipt_ids.length === 0 && s.node.type === 'Product' && <span className="muted small">our own claim, from the intake</span>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Score({ lead }: { lead: LeadView }) {
  const { snap } = useUi();
  const s = lead.score_inputs;
  if (!s) return <p className="muted">Not scored yet.</p>;
  const fit = [
    ['Industry', s.fit.industry],
    ['Headcount band', s.fit.headcount],
    ['Region', s.fit.region],
  ] as const;
  return (
    <div className="score">
      <table>
        <tbody>
          {fit.map(([label, part]) => (
            <tr key={label} className={part.matched ? '' : 'miss'}>
              <td>{label}</td>
              <td>
                {part.value ?? 'unknown'}
                {part.via === 'expansion' && <span className="tag good">accepted segment</span>}
              </td>
              <td className="num">
                {part.points} / {part.max}
              </td>
            </tr>
          ))}
          <tr className="total">
            <td colSpan={2}>Fit</td>
            <td className="num">{s.fit_score} / 100</td>
          </tr>
          {s.intent.map((p) => {
            const r = lead.receipts.find((x) => x.id === p.receipt_id);
            return (
              <tr key={p.receipt_id}>
                <td>{SIGNALS[p.signal_type].label}</td>
                <td>
                  weight {p.weight} × freshness {p.freshness} {r && <Chip r={r} now={snap.now} />}
                </td>
                <td className="num">{p.points}</td>
              </tr>
            );
          })}
          {s.intent.length === 0 && (
            <tr className="miss">
              <td colSpan={2}>No live trigger</td>
              <td className="num">0</td>
            </tr>
          )}
          <tr className="total">
            <td colSpan={2}>Intent</td>
            <td className="num">{s.intent_score} / 100</td>
          </tr>
          <tr className="grand">
            <td colSpan={2}>Score: half fit, half intent</td>
            <td className="num">
              {s.score} <Tier tier={s.tier} />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function tone(r: ReceiptView): string {
  if (r.status === 'failed') return 'failed';
  if (r.expired) return 'expired';
  return r.sign === 'negative' ? 'negative' : 'live';
}

function Timeline({ lead }: { lead: LeadView }) {
  const { snap } = useUi();
  const rows = [...lead.receipts].sort((a, b) => new Date(b.event_at ?? b.seen_at).getTime() - new Date(a.event_at ?? a.seen_at).getTime());
  return (
    <ol className="timeline">
      {rows.map((r) => (
        <li key={r.id} className={`tl tl-${tone(r)}`}>
          <span className="tl-date">{r.event_at ? fmtDate(r.event_at) : `found ${fmtDate(r.seen_at)}`}</span>
          <div>
            <p>
              <span className="tag">{r.field === 'signal' ? SIGNALS[r.signal_type].label : r.field.replace('_', ' ')}</span>
              {r.claim}
            </p>
            <div className="chips">
              <Chip r={r} now={snap.now} />
              <span className={`tl-status s-${tone(r)}`}>
                {r.status === 'failed'
                  ? `failed: ${r.fail_reason}`
                  : r.expired
                    ? `expired ${age(r.expires_at, snap.now)}`
                    : r.status === 'verified'
                      ? 'live, verified'
                      : 'live, unverified'}
              </span>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Contrast({ lead }: { lead: LeadView }) {
  const [lines, setLines] = useState<ContrastSentence[] | null>(null);
  useEffect(() => {
    let live = true;
    void call<ContrastSentence[]>(`/leads/${lead.id}/contrast`).then((s) => live && setLines(s));
    return () => {
      live = false;
    };
  }, [lead.id]);
  if (!lines) return null;
  return (
    <div className="contrast">
      <p className="muted small">
        An illustration of what a volume-first AI SDR sends to this same lead. The text is a fixed example; the verdicts are real checks against this lead's
        receipts.
      </p>
      <ul>
        {lines.map((l, i) => (
          <li key={i} className={l.factual ? 'unsupported' : ''}>
            <span>{l.text}</span>
            {l.factual && <em>{l.verdict}</em>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LeadDrawer({ lead, onClose }: { lead: LeadView; onClose: () => void }) {
  const { snap } = useUi();
  const [tab, setTab] = useState<'ours' | 'theirs'>('ours');
  const c = lead.company;

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const audit = [
    ...lead.transitions.map((t) => ({
      at: t.created_at,
      who: t.actor_type === 'agent' ? 'AI' : 'Rep',
      cls: t.actor_type,
      text: `${t.from_stage ?? 'New'} to ${t.to_stage} by ${t.actor}${t.note ? `. ${t.note}` : ''}`,
    })),
    ...snap.activity.filter((a) => a.lead_id === lead.id).map((a) => ({ at: a.at, who: a.agent, cls: a.agent === 'human' ? 'rep' : 'agent', text: a.message })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${c.name} details`}>
        <header className="drawer-head">
          <div>
            <h2>{c.name}</h2>
            <p className="muted">
              {[c.industry, c.headcount ? `${c.headcount} people (${bandFor(c.headcount)})` : null, c.hq].filter(Boolean).join(' · ')}
            </p>
            <div className="drawer-badges">
              <StateBadge state={lead.state} />
              <span className="tag">{lead.stage}</span>
              <Tier tier={lead.tier} />
              <span className="muted small">score {lead.score}</span>
              {lead.warm_intro && <span className="tag good">warm intro via {lead.warm_intro}</span>}
            </div>
          </div>
          <button type="button" className="btn small" onClick={onClose}>
            Close
          </button>
        </header>

        {lead.state !== 'active' && (
          <p className={`banner ${lead.state === 'disqualified' ? 'bad' : ''}`}>
            {lead.state === 'disqualified' ? 'Disqualified. ' : 'Held in Not yet. '}
            {lead.dormant_reason}
          </p>
        )}

        <Section title="Why this person, why now, why us">
          <Why lead={lead} />
        </Section>

        <Section
          title="Draft"
          aside={
            <div className="tabs mini">
              <button type="button" className={tab === 'ours' ? 'active' : ''} onClick={() => setTab('ours')}>
                With receipts
              </button>
              <button type="button" className={tab === 'theirs' ? 'active' : ''} onClick={() => setTab('theirs')}>
                Without
              </button>
            </div>
          }
        >
          {tab === 'theirs' ? (
            <Contrast lead={lead} />
          ) : lead.message ? (
            <ReviewCard lead={lead} />
          ) : (
            <p className="muted">
              {lead.state !== 'active'
                ? 'No draft. There is no live reason to write, so nothing was written.'
                : lead.enrich_status === 'unresolved'
                  ? `No draft. ${lead.enrich_note}`
                  : lead.enrich_status === 'blocked_credits'
                    ? `No draft yet. ${lead.enrich_note}`
                    : 'No draft yet.'}
            </p>
          )}
        </Section>

        <Section title="Score, with its inputs">
          <Score lead={lead} />
        </Section>

        <Section title={`Evidence · ${lead.receipts.length} receipts`}>
          <Timeline lead={lead} />
        </Section>

        <Section title="Audit log">
          {audit.length === 0 ? (
            <p className="muted">Nothing recorded yet.</p>
          ) : (
            <ol className="audit">
              {audit.map((a, i) => (
                <li key={i}>
                  <span className={`who who-${a.cls}`}>{a.who}</span>
                  <p>{a.text}</p>
                  <time>
                    {fmtDate(a.at)} {fmtTime(a.at)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </aside>
    </div>
  );
}
