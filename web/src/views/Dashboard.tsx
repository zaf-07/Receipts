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

const OP: Record<string, string> = { enrich: 'Lead enriched', draft: 'Draft generated', send: 'Outreach sent', topup: 'Top-up', grant: 'Starting credits', flexprice: 'Flexprice wallet' };

export function Dashboard() {
  const { snap, go, act, refresh } = useUi();
  const m = snap.metrics;
  const wallet = snap.credits.wallet;
  const declined = m.declined.not_yet + m.declined.disqualified;

  const refreshWallet = async () => {
    if (await act('/billing/sync')) await refresh();
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
        </div>
      </header>

      <div className="hero-metric">
        <div className="hero-n">{m.proof_rate == null ? 'n/a' : pct(m.proof_rate)}</div>
        <div>
          <h2>Proof rate</h2>
          <p>
            <b>{m.messages_sent === 0 ? 'No messages sent yet' : `${m.messages_sent} approved message${m.messages_sent === 1 ? '' : 's'} carried only re-verified claims`}</b>.
          </p>
          <p className="muted small">
            A message counts only when every factual sentence has a receipt and the Skeptic passed it against the live source. Human approval is still required to send.
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
          <span>Skeptic catch rate</span>
          <strong>{pct(m.catch_rate)}</strong>
          <small>
            {m.claims_struck} of {m.claims_drafted} drafted claims struck before review
          </small>
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
            Costs: enrich {snap.credits.costs.enrich}, draft {snap.credits.costs.draft}, send {snap.credits.costs.send} credits.
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

      <Section
        title="Flexprice billing"
        aside={
          <span className={`billing-status ${wallet.connected ? 'is-connected' : wallet.configured ? 'has-warning' : ''}`}>
            <i /> {wallet.connected ? 'Connected' : wallet.configured ? 'Connection issue' : 'Local ledger'}
          </span>
        }
      >
        <div className="billing-panel">
          <div className="billing-balance">
            <span>Wallet balance</span>
            <strong>{wallet.balance == null ? '—' : wallet.balance}</strong>
            <small>{wallet.balance === 1 ? 'credit' : 'credits'} · {wallet.mode === 'source' ? 'wallet controls the gate' : 'local ledger controls the gate'}</small>
          </div>
          <dl className="billing-details">
            <dt>Usage events accepted</dt>
            <dd>{wallet.events_sent}</dd>
            <dt>Last balance read</dt>
            <dd>{wallet.synced_at ? `${fmtDate(wallet.synced_at)} ${fmtTime(wallet.synced_at)}` : 'Not synced yet'}</dd>
            {wallet.last_error && <>
              <dt>Last issue</dt>
              <dd className="billing-error">{wallet.last_error}</dd>
            </>}
          </dl>
          <div className="billing-actions">
            <p className="muted small">
              {wallet.connected
                ? 'Receipts sends metered usage to Flexprice. Events accepted is counted since this server process started.'
                : wallet.configured
                  ? 'Receipts will keep using its local credit ledger while it retries the Flexprice connection.'
                  : 'Flexprice is not configured. Usage and credit gating are handled by the local ledger.'}
            </p>
            {wallet.configured && <button type="button" className="btn small" onClick={() => void refreshWallet()}>Refresh wallet</button>}
          </div>
        </div>
      </Section>
    </div>
  );
}
