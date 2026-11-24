import { useEffect, useState } from 'react';
import type { Expansion, IcpVersion, Profile, Scored } from '../../../shared/types';
import { HEADCOUNT_BANDS, INDUSTRIES, REGIONS, SIGNALS } from '../../../shared/constants';
import { call, useUi } from '../api';
import { Bar, Empty, Section, fmtDate, pct } from '../components';

const BLANK: Profile = { product_name: '', description: '', customers: [], pricing: '', excluded_regions: [], sender: '' };

function FieldRow<T extends string>({ label, items, render }: { label: string; items: Scored<T>[]; render?: (v: T) => string }) {
  return (
    <div className="icp-field">
      <h4>{label}</h4>
      <ul>
        {items.map((i) => (
          <li key={i.value}>
            <span>{render ? render(i.value) : i.value}</span>
            <Bar value={i.confidence} tone={i.confidence >= 0.7 ? 'good' : i.confidence >= 0.5 ? 'ink' : 'old'} />
            <b>{pct(i.confidence)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A set of choices shown as toggles: the ones that are on are in the segment. */
function Toggles({ label, all, on, onChange }: { label: string; all: string[]; on: string[]; onChange: (next: string[]) => void }) {
  return (
    <fieldset className="toggles">
      <legend>{label}</legend>
      {all.map((v) => (
        <button key={v} type="button" className={on.includes(v) ? 'on' : ''} aria-pressed={on.includes(v)} onClick={() => onChange(on.includes(v) ? on.filter((x) => x !== v) : [...on, v])}>
          {v}
        </button>
      ))}
    </fieldset>
  );
}

/** One adjacent segment. A person can accept it as proposed, change it and then accept it, or dismiss it. */
function Segment({ x }: { x: Expansion }) {
  const { act } = useUi();
  const [editing, setEditing] = useState(false);
  const [industries, setIndustries] = useState(x.industries);
  const [bands, setBands] = useState(x.headcount_bands);
  const decide = (decision: string, body: object = {}) => act(`/icp/expansions/${x.id}`, { decision, ...body });
  return (
    <li className={`expansion is-${x.status} ${editing ? 'is-editing' : ''}`}>
      <div>
        <strong>{x.name}</strong>
        <p>{x.reasoning}</p>
        <p className="segment-scope">
          {x.industries.join(', ')} · {x.headcount_bands.join(', ')} people
          {x.adjusted && <span className="tag">adjusted by you</span>}
        </p>
        {editing && (
          <div className="segment-edit">
            <Toggles label="Industries" all={INDUSTRIES} on={industries} onChange={setIndustries} />
            <Toggles label="Company size" all={HEADCOUNT_BANDS} on={bands} onChange={setBands} />
            <div className="row-actions">
              <button
                type="button"
                className="btn small primary"
                disabled={industries.length === 0 || bands.length === 0}
                onClick={() => void decide('accepted', { industries, headcount_bands: bands }).then((ok) => ok && setEditing(false))}
              >
                Accept as adjusted
              </button>
              <button type="button" className="link" onClick={() => setEditing(false)}>
                cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="expansion-actions">
        {x.status === 'proposed' ? (
          !editing && (
            <>
              <button type="button" className="btn small primary" onClick={() => void decide('accepted')}>
                Accept
              </button>
              <button type="button" className="btn small" onClick={() => setEditing(true)}>
                Adjust
              </button>
              <button type="button" className="btn small" onClick={() => void decide('dismissed')}>
                Dismiss
              </button>
            </>
          )
        ) : (
          <>
            <span className={`tag ${x.status === 'accepted' ? 'good' : ''}`}>{x.status}</span>
            <button type="button" className="link" onClick={() => void decide('proposed')}>
              undo
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function weightDiff(v: IcpVersion, parent: IcpVersion | undefined) {
  if (!parent) return [];
  return Object.keys(v.weights)
    .filter((k) => v.weights[k] !== parent.weights[k])
    .map((k) => ({ label: SIGNALS[k as keyof typeof SIGNALS]?.label ?? k, from: parent.weights[k], to: v.weights[k] }));
}

export function Intake() {
  const { snap, act, go } = useUi();
  const [form, setForm] = useState<Profile>(snap.profile ?? BLANK);
  const [customers, setCustomers] = useState((snap.profile?.customers ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const icp = snap.icp;

  useEffect(() => {
    if (snap.profile) {
      setForm(snap.profile);
      setCustomers(snap.profile.customers.join(', '));
    }
  }, [snap.profile?.product_name, snap.profile?.description]);

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function loadExample() {
    const example = await call<Profile>('/example');
    setForm(example);
    setCustomers(example.customers.join(', '));
  }

  async function plan() {
    setBusy(true);
    await act('/intake', { ...form, customers });
    setBusy(false);
  }

  async function run() {
    if (await act('/run')) go('accounts');
  }

  const discovered = snap.leads.length > 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Intake &amp; ICP</h1>
          <p>Describe the product in plain language. The Planner turns it into an ideal customer profile, with a confidence on every field.</p>
        </div>
      </header>

      <div className="two-col">
        <Section
          title="Product"
          aside={
            <button type="button" className="link" onClick={() => void loadExample()}>
              Load the example
            </button>
          }
        >
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void plan();
            }}
          >
            <label>
              Product name
              <input value={form.product_name} onChange={(e) => set('product_name', e.target.value)} placeholder="Tollgate" required />
            </label>
            <label>
              What it does, and for whom
              <textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={5} placeholder="Two or three plain sentences." required />
            </label>
            <label>
              Existing customers <span className="hint">comma separated; used for warm intros and never contacted</span>
              <input value={customers} onChange={(e) => setCustomers(e.target.value)} placeholder="Lumen Cloud, Parsec AI" />
            </label>
            <label>
              Pricing
              <input value={form.pricing} onChange={(e) => set('pricing', e.target.value)} placeholder="$499 per month plus usage" />
            </label>
            <fieldset>
              <legend>Regions you cannot serve</legend>
              <div className="checks">
                {REGIONS.map((r) => (
                  <label key={r} className="check">
                    <input
                      type="checkbox"
                      checked={form.excluded_regions.includes(r)}
                      onChange={(e) => set('excluded_regions', e.target.checked ? [...form.excluded_regions, r] : form.excluded_regions.filter((x) => x !== r))}
                    />
                    {r}
                  </label>
                ))}
              </div>
            </fieldset>
            <label>
              Sender name <span className="hint">signs the emails and the approvals</span>
              <input value={form.sender} onChange={(e) => set('sender', e.target.value)} placeholder="Your name" />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn primary" disabled={busy || Boolean(snap.running)}>
                {busy ? 'Planning' : icp ? 'Plan again' : 'Plan the ICP'}
              </button>
            </div>
          </form>
        </Section>

        <div>
          {!icp ? (
            <Empty title="No ICP yet">Fill in the product on the left, or load the example, then plan the ICP.</Empty>
          ) : (
            <>
              <Section
                title={`ICP v${icp.version}`}
                aside={<span className="tag">{icp.planned_by === 'llm' ? 'model planner' : icp.planned_by === 'analyst' ? 'analyst' : 'keyword planner'}</span>}
              >
                <p className="rationale">{icp.rationale}</p>
                <div className="icp-grid">
                  <FieldRow
                    label="Industries"
                    items={icp.fields.industries}
                    render={(v) => {
                      const naics = icp.fields.naics?.find((n) => n.industry === v);
                      return naics ? `${v} · NAICS ${naics.code}` : v;
                    }}
                  />
                  <FieldRow label="Headcount" items={icp.fields.headcount_bands} />
                  {icp.fields.revenue_bands && <FieldRow label="Revenue (estimated)" items={icp.fields.revenue_bands} />}
                  <FieldRow label="Regions" items={icp.fields.regions} />
                  <FieldRow label="Personas" items={icp.fields.personas} />
                  {icp.fields.seniority && <FieldRow label="Seniority" items={icp.fields.seniority} />}
                  <FieldRow label="Trigger events" items={icp.fields.trigger_events} render={(v) => SIGNALS[v].label} />
                </div>
                {icp.fields.revenue_bands && (
                  <p className="muted small">
                    Revenue is the headcount restated at about $200,000 per employee, so it is less certain than the headcount it comes from. It describes the target; a
                    company only gets a revenue figure from a receipt.
                  </p>
                )}
                {icp.fields.excluded_regions.length > 0 && (
                  <p className="muted small">Excluded: {icp.fields.excluded_regions.join(', ')}. Accounts there are disqualified with the source shown.</p>
                )}
              </Section>

              <Section title="Adjacent segments">
                <p className="muted small">Outside the core ICP, but plausible. Accept one to widen the fit score, adjust it first if it is close but not right, or dismiss it and nothing changes.</p>
                <ul className="expansions">
                  {icp.expansions.map((x) => (
                    <Segment key={`${x.id}-${x.status}`} x={x} />
                  ))}
                </ul>
              </Section>

              <div className="cta">
                <div>
                  <strong>{discovered ? 'Discovery has run.' : 'Ready to find accounts.'}</strong>
                  <p>
                    The Researcher runs {icp.search_plan.length} searches, reads the sources and writes a receipt for every fact. Leads with no live reason are held
                    back.
                  </p>
                </div>
                <button type="button" className="btn primary" disabled={Boolean(snap.running)} onClick={() => void run()}>
                  {snap.running ? snap.running : discovered ? 'Run discovery again' : 'Run discovery'}
                </button>
              </div>

              <Section title="Version history">
                <ol className="versions">
                  {[...snap.icp_versions].reverse().map((v) => {
                    const parent = snap.icp_versions.find((p) => p.id === v.parent_id);
                    const diff = weightDiff(v, parent);
                    return (
                      <li key={v.id} className={v.id === icp.id ? 'current' : ''}>
                        <div className="version-head">
                          <strong>v{v.version}</strong>
                          <span className="muted small">{fmtDate(v.created_at)}</span>
                          {v.id === icp.id ? (
                            <span className="tag good">active</span>
                          ) : (
                            <button type="button" className="link" onClick={() => void act(`/icp/versions/${v.id}/activate`)}>
                              make active
                            </button>
                          )}
                        </div>
                        <p>{v.rationale}</p>
                        {diff.length > 0 && (
                          <ul className="diff">
                            {diff.map((d) => (
                              <li key={d.label}>
                                <span>{d.label} weight</span>
                                <del>{d.from}</del>
                                <ins>{d.to}</ins>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
