import { useUi } from '../api';
import { Chip, Empty } from '../components';

export function Competitors() {
  const { snap } = useUi();
  const now = snap.now;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Competitors</h1>
          <p>One card each: how they position themselves, what they charge in public, and where we differ. The pricing claim carries a receipt like any other fact.</p>
        </div>
      </header>
      {snap.competitors.length === 0 ? (
        <Empty title="No competitors found yet">The Researcher collects competitors in the same pass as accounts. Run discovery first.</Empty>
      ) : (
        <div className="cards">
          {snap.competitors.map((c) => {
            const positioning = c.receipts.filter((r) => r.field === 'positioning').pop();
            const pricing = c.receipts.filter((r) => r.field === 'pricing').pop();
            const signed = snap.leads.filter((l) => l.receipts.some((r) => r.signal_type === 'competitor_signed' && r.data.competitor === c.company.name && r.live));
            return (
              <article key={c.company.id} className="comp-card">
                <header>
                  <h3>{c.company.name}</h3>
                  <span className="mono muted">{c.company.domain}</span>
                </header>
                <dl>
                  <dt>Positioning</dt>
                  <dd>
                    {c.positioning ?? <span className="muted">not found</span>} {positioning && <Chip r={positioning} now={now} />}
                  </dd>
                  <dt>Public pricing</dt>
                  <dd>
                    {c.pricing ?? <span className="muted">not published</span>} {pricing && <Chip r={pricing} now={now} />}
                  </dd>
                  <dt>Our differentiator</dt>
                  <dd>{c.company.differentiator ?? <span className="muted">not written yet</span>}</dd>
                  <dt>Accounts lost to them</dt>
                  <dd>
                    {signed.length === 0
                      ? 'None seen.'
                      : signed.map((l) => (
                          <span key={l.id} className="fact">
                            {l.company.name}
                            {l.receipts
                              .filter((r) => r.signal_type === 'competitor_signed')
                              .map((r) => (
                                <Chip key={r.id} r={r} now={now} />
                              ))}
                          </span>
                        ))}
                  </dd>
                </dl>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
