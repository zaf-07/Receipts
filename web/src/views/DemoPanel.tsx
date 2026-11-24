import { useState } from 'react';
import { useUi } from '../api';
import { fmtDate } from '../components';

/** Controls for the seeded world and the clock. They change the outside world, never the pipeline's own records. */
export function DemoPanel({ onClose }: { onClose: () => void }) {
  const { snap, act } = useUi();
  const [confirm, setConfirm] = useState(false);
  const pages = snap.world.pages.filter((p) => p.kind === 'job' || p.kind === 'news' || p.kind === 'pricing');
  const companies = [...new Set(pages.map((p) => p.company))];

  return (
    <section className="demo-panel" aria-label="Demo controls">
      <header>
        <div>
          <h3>Demo controls</h3>
          <p className="muted small">
            These act on the world outside the pipeline: the pages companies publish and the date. The agents only ever find out by reading and re-reading sources.
          </p>
        </div>
        <button type="button" className="link" onClick={onClose}>
          close
        </button>
      </header>

      <div className="demo-grid">
        <div>
          <h4>Clock</h4>
          <p className="muted small">
            Now {fmtDate(snap.now)}
            {snap.clock_offset_days > 0 ? ` (moved forward ${snap.clock_offset_days} days)` : ''}. Move it forward to watch receipts expire and leads return to Not
            yet.
          </p>
          <div className="row-actions">
            {[30, 60, 120].map((d) => (
              <button key={d} type="button" className="btn small" onClick={() => void act('/demo/clock', { days: d })}>
                +{d} days
              </button>
            ))}
          </div>

          <h4>Start over</h4>
          <p className="muted small">Empties the pipeline, re-seeds the world and resets the credits.</p>
          {confirm ? (
            <div className="row-actions">
              <button
                type="button"
                className="btn small danger"
                onClick={async () => {
                  if (await act('/demo/reset')) setConfirm(false);
                }}
              >
                Yes, erase everything
              </button>
              <button type="button" className="btn small" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="btn small" onClick={() => setConfirm(true)}>
              Reset the demo
            </button>
          )}
        </div>

        <div>
          <h4>World pages</h4>
          {snap.mode.source !== 'world' ? (
            <p className="muted small">Live web mode: there are no local pages to control.</p>
          ) : (
            <>
              <p className="muted small">Take a page down, then re-verify a draft that cites it. The Skeptic will strike the sentence.</p>
              <div className="world-list">
                {companies.map((name) => (
                  <div key={name} className="world-co">
                    <strong>{name}</strong>
                    <ul>
                      {pages
                        .filter((p) => p.company === name)
                        .map((p) => (
                          <li key={p.id} className={`world-${p.status}`}>
                            <a href={p.url} target="_blank" rel="noreferrer">
                              {p.title}
                            </a>
                            <span className="tag">{p.status}</span>
                            {p.status !== 'scheduled' && (
                              <button type="button" className="link" onClick={() => void act(`/demo/pages/${p.id}`, { status: p.status === 'live' ? 'gone' : 'live' })}>
                                {p.status === 'live' ? 'take down' : 'restore'}
                              </button>
                            )}
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
