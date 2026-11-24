import type { SegmentRow } from '../../../shared/types';
import { useUi } from '../api';
import { Section, fmtDate, fmtTime, pct } from '../components';

function Funnel({ rows }: { rows: SegmentRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.matched));
  return (
    <table className="funnel">
      <thead>
        <tr>
          <th>Segment</th>
          <th>Matched</th>
          <th>Contacted</th>
          <th>Replied</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.segment}>
            <td>{r.segment}</td>
            {[r.matched, r.contacted, r.replied].map((n, i) => (
              <td key={i}>
                <span className="funnel-bar">
                  <i style={{ width: `${(n / max) * 100}%` }} className={`step-${i}`} />
                  <b>{n}</b>
                </span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const OP: Record<string, string> = { enrich: 'Lead enriched', draft: 'Draft generated', send: 'Outreach sent', topup: 'Top-up', grant: 'Starting credits' };

export function Dashboard() {
  const { snap, go } = useUi();
  const m = snap.metrics;
  const declined = m.declined.not_yet + m.declined.disqualified;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>The number that matters is what the system refused to say. Everything else follows from that.</p>
        </div>
      </header>

      <div className="hero-metric">
        <div className="hero-n">{m.catch_rate == null ? 'n/a' : pct(m.catch_rate)}</div>
        <div>
          <h2>Catch rate</h2>
          <p>
            <b>{m.claims_struck}</b> of <b>{m.claims_drafted}</b> drafted claims were struck by the Skeptic before a human saw them.
          </p>
          <p className="muted small">
            Proof rate of sent messages is not shown as a headline: failed claims are struck before sending, so it would always read near 100%.
          </p>
        </div>
      </div>

      <div className="tiles">
        <button type="button" className="tile" onClick={() => go('not-yet')}>
          <span>Declined to contact</span>
          <strong>{declined}</strong>
          <small>
            {m.declined.not_yet} waiting for a reason, {m.declined.disqualified} disqualified
          </small>
        </button>
        <div className="tile">
          <span>Reply rate</span>
          <strong>{pct(m.reply_rate)}</strong>
          <small>
            {m.replies} repl{m.replies === 1 ? 'y' : 'ies'} from {m.messages_sent} sent
          </small>
        </div>
        <div className="tile">
          <span>Meetings booked</span>
          <strong>{m.meetings}</strong>
          <small>leads at Meeting Booked or later</small>
        </div>
        <div className="tile">
          <span>Approved and sent</span>
          <strong>{m.messages_sent}</strong>
          <small>every one approved by a person</small>
        </div>
      </div>

      <div className="two-col even">
        <Section title="Conversion by industry">
          <Funnel rows={m.by_industry} />
        </Section>
        <Section title="Conversion by tier">
          <Funnel rows={m.by_tier} />
        </Section>
      </div>

      <div className="two-col even">
        <Section title="Usage">
          <dl className="usage">
            <dt>Leads enriched</dt>
            <dd>{m.usage.leads_enriched}</dd>
            <dt>Drafts generated</dt>
            <dd>{m.usage.drafts_generated}</dd>
            <dt>Outreach sent</dt>
            <dd>{m.usage.outreach_sent}</dd>
            <dt>Graph queries</dt>
            <dd>{m.usage.graph_queries}</dd>
          </dl>
          <p className="muted small">
            Costs: enrich {snap.credits.costs.enrich}, draft {snap.credits.costs.draft}, send {snap.credits.costs.send} credits.{' '}
            {snap.mode.flexprice ? 'Events are mirrored to Flexprice.' : 'Metered on the local ledger. Set FLEXPRICE_API_KEY to mirror events to Flexprice.'}
          </p>
        </Section>
        <Section title="Credit ledger" aside={<span className="tag">{snap.credits.balance} left</span>}>
          <ul className="ledger">
            {snap.credits.ledger.map((e) => (
              <li key={e.id}>
                <span>{OP[e.op] ?? e.op}</span>
                <small className="muted">{e.note}</small>
                <time>
                  {fmtDate(e.created_at)} {fmtTime(e.created_at)}
                </time>
                <b className={e.amount < 0 ? 'neg' : 'pos'}>{e.amount > 0 ? `+${e.amount}` : e.amount}</b>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
