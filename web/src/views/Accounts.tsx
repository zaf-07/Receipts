import { useState } from 'react';
import type { LeadView, ReceiptView } from '../../../shared/types';
import { SIGNALS, bandFor } from '../../../shared/constants';
import { useUi } from '../api';
import { Chip, Empty, Fact, StateBadge, Tier, age, latest } from '../components';

type Filter = 'all' | 'active' | 'not_yet' | 'disqualified';

/** The receipt that best explains a lead's current state: its strongest live trigger, or the reason it is held. */
export function headline(lead: LeadView): ReceiptView | undefined {
  if (lead.state === 'active') {
    const top = lead.score_inputs?.intent[0]?.receipt_id;
    return lead.receipts.find((r) => r.id === top) ?? lead.receipts.find((r) => r.field === 'signal' && r.sign === 'positive' && r.live);
  }
  return lead.receipts.find((r) => r.id === lead.reason_receipt_id);
}

function Contact({ lead, now }: { lead: LeadView; now: string }) {
  const p = lead.person;
  if (!p) {
    if (lead.enrich_status === 'unresolved') return <span className="warn-text">Unresolved. {lead.enrich_note}</span>;
    if (lead.enrich_status === 'blocked_credits') return <span className="bad-text">On hold: credit gate</span>;
    return <span className="muted">{lead.state === 'active' ? 'not enriched yet' : 'not enriched (no live reason)'}</span>;
  }
  return (
    <>
      <span className="fact">
        <span>
          {p.name}
          <small>{p.title}</small>
        </span>
        {latest(lead.receipts, p.id, 'contact') && <Chip r={latest(lead.receipts, p.id, 'contact')!} now={now} />}
      </span>
      <Email lead={lead} now={now} />
    </>
  );
}

function Email({ lead, now }: { lead: LeadView; now: string }) {
  const p = lead.person;
  if (!p) return null;
  const receipt = latest(lead.receipts, p.id, 'email');
  if (p.email_status === 'verified' && receipt) {
    return (
      <span className="fact">
        <span className="mono">{p.email}</span>
        <Chip r={receipt} now={now} />
      </span>
    );
  }
  return (
    <span className="fact low">
      <span className="mono">{p.email}</span>
      <span className="no-receipt" title={lead.enrich_note ?? ''}>
        guessed, no receipt
      </span>
    </span>
  );
}

export function Accounts() {
  const { snap, openLead, go } = useUi();
  const [filter, setFilter] = useState<Filter>('all');
  const now = snap.now;
  const rank = { active: 0, not_yet: 1, disqualified: 2 };
  const leads = snap.leads.filter((l) => filter === 'all' || l.state === filter).sort((a, b) => rank[a.state] - rank[b.state] || b.score - a.score);
  const count = (s: Filter) => (s === 'all' ? snap.leads.length : snap.leads.filter((l) => l.state === s).length);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Accounts</h1>
          <p>Records write themselves. Every cell is backed by a receipt: click a chip to see the exact words and open the source. There is no Create Record button.</p>
        </div>
        <div className="tabs" role="tablist">
          {(['all', 'active', 'not_yet', 'disqualified'] as Filter[]).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'not_yet' ? 'Not yet' : f[0].toUpperCase() + f.slice(1)} <b>{count(f)}</b>
            </button>
          ))}
        </div>
      </header>

      {snap.leads.length === 0 ? (
        <Empty title={snap.running ? `${snap.running}…` : 'No accounts yet'}>
          {snap.icp ? (
            'Run discovery from the intake screen and accounts will load here with their receipts.'
          ) : (
            <>
              Start with the{' '}
              <button type="button" className="link" onClick={() => go('intake')}>
                intake
              </button>
              .
            </>
          )}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Account</th>
                <th>Industry</th>
                <th>Size and region</th>
                <th>Why now, or why not</th>
                <th>Contact</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => {
                const c = l.company;
                const why = headline(l);
                return (
                  <tr key={l.id} onClick={() => openLead(l.id)} className={`row-${l.state}`}>
                    <td>
                      <strong>{c.name}</strong>
                      <small className="mono">{c.domain}</small>
                      <StateBadge state={l.state} />
                    </td>
                    <td>
                      <Fact value={c.industry} receipt={latest(l.receipts, c.id, 'industry')} now={now} />
                    </td>
                    <td className="stack">
                      <Fact value={c.headcount ? `${c.headcount} (${bandFor(c.headcount)})` : null} receipt={latest(l.receipts, c.id, 'headcount')} now={now} />
                      <Fact value={c.region} receipt={latest(l.receipts, c.id, 'region')} now={now} />
                    </td>
                    <td className="why">
                      {why ? (
                        <span className="fact">
                          <span>
                            {why.field === 'region_exclusion' ? 'Outside served regions' : SIGNALS[why.signal_type].label}
                            <small>
                              {why.status === 'failed'
                                ? 'failed re-verification'
                                : why.expired
                                  ? 'expired'
                                  : why.event_at
                                    ? age(why.event_at, now)
                                    : `found ${age(why.seen_at, now)}`}
                            </small>
                          </span>
                          <Chip r={why} now={now} />
                        </span>
                      ) : (
                        <span className="muted">no trigger found</span>
                      )}
                    </td>
                    <td className="contact">
                      <Contact lead={l} now={now} />
                    </td>
                    <td className="num score-cell">
                      <b>{l.score}</b> <Tier tier={l.tier} />
                      <small>
                        fit {l.fit_score} · intent {l.intent_score}
                      </small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
