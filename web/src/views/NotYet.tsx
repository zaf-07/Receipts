import type { LeadView } from '../../../shared/types';
import { useUi } from '../api';
import { Chip, Empty, Tier } from '../components';

const WHY: Record<string, string> = {
  no_trigger: 'No trigger found',
  expired: 'Last trigger expired',
  failed_verification: 'Trigger failed re-verification',
  negative: 'Negative receipt',
};

function Held({ lead }: { lead: LeadView }) {
  const { snap, openLead } = useUi();
  const receipt = lead.receipts.find((r) => r.id === lead.reason_receipt_id);
  return (
    <li className="held" onClick={() => openLead(lead.id)}>
      <div className="held-top">
        <strong>{lead.company.name}</strong>
        <Tier tier={lead.tier} />
        <span className="muted small">
          {lead.company.industry} · fit {lead.fit_score}
        </span>
      </div>
      <p className="held-reason">
        <span className="tag">{WHY[lead.reason_code] ?? lead.reason_code}</span>
        {lead.dormant_reason}
        {receipt && <Chip r={receipt} now={snap.now} />}
      </p>
    </li>
  );
}

export function NotYet() {
  const { snap, act } = useUi();
  const dormant = snap.leads.filter((l) => l.state === 'not_yet');
  const disqualified = snap.leads.filter((l) => l.state === 'disqualified');
  const world = snap.mode.source === 'world';

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Not yet</h1>
          <p>
            Leads the agent declined to contact. A lead with no live positive receipt waits here with the missing evidence named. When a new signal arrives it wakes
            up on its own; when its last receipt expires it comes back.
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="btn primary" disabled={Boolean(snap.running) || !snap.icp} onClick={() => void act('/ingest')}>
            {snap.running ?? 'Refresh signals'}
          </button>
          {world && (
            <span className="muted small">
              Demo world: this also publishes the next batch of new pages ({snap.world.pending_batches} left), then re-reads every known site.
            </span>
          )}
        </div>
      </header>

      {snap.leads.length === 0 ? (
        <Empty title="Nothing held back yet">Run discovery first.</Empty>
      ) : (
        <div className="two-col even">
          <section>
            <h2 className="group">No reason yet · {dormant.length}</h2>
            <p className="muted small">Good fit or not, there is nothing true to say right now. Waiting for a trigger.</p>
            <ul className="held-list">
              {dormant.map((l) => (
                <Held key={l.id} lead={l} />
              ))}
            </ul>
            {dormant.length === 0 && <p className="muted">No dormant leads.</p>}
          </section>
          <section>
            <h2 className="group bad">Disqualified · {disqualified.length}</h2>
            <p className="muted small">A live negative receipt is a reason not to contact. It expires too, and the lead is reconsidered when it does.</p>
            <ul className="held-list">
              {disqualified.map((l) => (
                <Held key={l.id} lead={l} />
              ))}
            </ul>
            {disqualified.length === 0 && <p className="muted">No disqualified leads.</p>}
          </section>
        </div>
      )}
    </div>
  );
}
