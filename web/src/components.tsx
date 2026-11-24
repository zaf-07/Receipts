import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { LeadView, Message, ReceiptView, Sentence } from '../../shared/types';
import { SIGNALS } from '../../shared/constants';

const DAY = 86_400_000;

export function fmtDate(iso?: string | null): string {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / DAY);
}

export function age(iso: string | null | undefined, nowIso: string): string {
  if (!iso) return '';
  const d = daysBetween(iso, nowIso);
  if (d <= 0) return 'today';
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

export function pct(n: number | null | undefined): string {
  return n == null ? 'n/a' : `${Math.round(n * 100)}%`;
}

function receiptTone(r: ReceiptView): 'bad' | 'old' | 'good' | 'plain' {
  if (r.status === 'failed') return 'bad';
  if (r.expired) return 'old';
  if (r.status === 'verified') return 'good';
  return 'plain';
}

function receiptStatus(r: ReceiptView): string {
  if (r.status === 'failed') return `Failed re-verification: ${r.fail_reason ?? 'source could not be confirmed'}`;
  if (r.status === 'verified') return `Verified by the Skeptic, ${fmtDate(r.verified_at)} ${r.verified_at ? fmtTime(r.verified_at) : ''}`;
  return 'Unverified. Read once by the Researcher; not yet re-checked.';
}

/** The paper receipt behind a chip: the claim, the exact words, the source, and when it stops counting. */
export function ReceiptCard({ r, now }: { r: ReceiptView; now: string }) {
  let source = r.source_url;
  try {
    const u = new URL(r.source_url);
    source = `${u.host}${u.pathname}`;
  } catch {
    // Keep the raw string.
  }
  const left = r.expires_at ? daysBetween(now, r.expires_at) : null;
  return (
    <div className={`receipt tone-${receiptTone(r)}`}>
      <div className="receipt-head">
        <span>Receipt</span>
        <span>{r.id}</span>
      </div>
      <p className="receipt-claim">{r.claim}</p>
      <blockquote className="receipt-snippet">{r.snippet}</blockquote>
      <dl className="receipt-rows">
        <dt>Source</dt>
        <dd>
          <a href={r.source_url} target="_blank" rel="noreferrer">
            {source}
          </a>
        </dd>
        <dt>Signal</dt>
        <dd>
          {SIGNALS[r.signal_type].label}, {r.sign}
        </dd>
        <dt>Dated</dt>
        <dd>
          {r.event_at ? `${fmtDate(r.event_at)} on the page` : 'no date on the page'}; found {fmtDate(r.seen_at)}
        </dd>
        <dt>Expires</dt>
        <dd>
          {r.expires_at == null
            ? 'Does not expire'
            : left != null && left > 0
              ? `${fmtDate(r.expires_at)} (${left} day${left === 1 ? '' : 's'} left)`
              : `Expired ${fmtDate(r.expires_at)}`}
        </dd>
        <dt>Status</dt>
        <dd className="receipt-status">{receiptStatus(r)}</dd>
        <dt>Confidence</dt>
        <dd>{pct(r.confidence)} from extraction</dd>
      </dl>
    </div>
  );
}

/** A receipt id you can click. Every fact in the product is one of these away from its source. */
export function Chip({ r, now, label }: { r: ReceiptView; now: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const width = 380;
    const height = card.current?.offsetHeight ?? 320;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const below = rect.bottom + 8;
    const top = below + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 8) : below;
    setPos({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // One receipt open at a time: opening another chip closes this one.
    window.dispatchEvent(new Event('receipt-open'));
    const close = (e: MouseEvent) => {
      if (card.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const scroll = (e: Event) => {
      if (!card.current?.contains(e.target as Node)) setOpen(false);
    };
    const other = () => setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    const t = window.setTimeout(() => window.addEventListener('receipt-open', other), 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('receipt-open', other);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`chip tone-${receiptTone(r)}`}
        aria-expanded={open}
        title={`${r.claim}\n"${r.snippet}"`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <i />
        {label ?? r.id}
      </button>
      {open && (
        <div
          ref={card}
          className="popover"
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label={`Receipt ${r.id}`}
        >
          <ReceiptCard r={r} now={now} />
        </div>
      )}
    </>
  );
}

export function Tier({ tier }: { tier: string }) {
  return <span className={`tier tier-${tier}`}>{tier}</span>;
}

const STATE_LABEL: Record<string, string> = { active: 'Active', not_yet: 'Not yet', disqualified: 'Disqualified' };

export function StateBadge({ state }: { state: string }) {
  return <span className={`state state-${state}`}>{STATE_LABEL[state] ?? state}</span>;
}

export function Bar({ value, tone = 'ink' }: { value: number; tone?: string }) {
  return (
    <span className={`bar bar-${tone}`} role="img" aria-label={pct(value)}>
      <i style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

function SentenceView({ s, lead, now }: { s: Sentence; lead: LeadView; now: string }) {
  if (s.kind === 'connective') return <span className="sent">{s.text} </span>;
  const receipts = s.receipt_ids.map((id) => lead.receipts.find((r) => r.id === id)).filter((r): r is ReceiptView => Boolean(r));
  if (s.status === 'struck') {
    return (
      <span className="sent struck">
        <s>{s.text}</s>
        <span className="strike-note">
          Struck by the Skeptic: {s.strike_reason ?? 'source failed'}
          {receipts.map((r) => (
            <Chip key={r.id} r={r} now={now} />
          ))}
        </span>{' '}
      </span>
    );
  }
  return (
    <span className="sent claim" title={receipts.map((r) => `"${r.snippet}"`).join('\n')}>
      {s.text}
      {s.edited && <em className="edited">edited</em>}
      {receipts.map((r) => (
        <Chip key={r.id} r={r} now={now} />
      ))}{' '}
    </span>
  );
}

/** A draft, sentence by sentence. Claims carry their receipts; struck sentences stay visible. */
export function DraftBody({ message, lead, now }: { message: Message; lead: LeadView; now: string }) {
  const s = message.sentences;
  const greeting = s[0]?.kind === 'connective' && /,$/.test(s[0].text) ? s[0] : null;
  const last = s[s.length - 1];
  const signoff = last && last.kind === 'connective' && last.text.length < 40 && !/[.?!]$/.test(last.text) ? last : null;
  const body = s.slice(greeting ? 1 : 0, signoff ? -1 : undefined);
  return (
    <div className="draft">
      <div className="draft-meta">
        <span>To</span>
        <b>
          {lead.person?.name ?? 'No contact'}{' '}
          {message.channel === 'linkedin' ? (
            lead.person?.linkedin_url ? (
              <span className="mono">{lead.person.linkedin_url.replace(/^https?:\/\//, '')}</span>
            ) : (
              lead.person && <span className="muted small">no LinkedIn profile published, so this one is sent by hand</span>
            )
          ) : (
            lead.person?.email && <span className="mono">&lt;{lead.person.email}&gt;</span>
          )}
        </b>
        <span>Subject</span>
        <b>{message.subject}</b>
      </div>
      <div className="draft-text">
        {greeting && <p>{greeting.text}</p>}
        <p>
          {body.map((x, i) => (
            <SentenceView key={i} s={x} lead={lead} now={now} />
          ))}
        </p>
        {signoff && <p>{signoff.text}</p>}
      </div>
    </div>
  );
}

export function claimCounts(message: Message): { ok: number; struck: number } {
  const claims = message.sentences.filter((s) => s.kind === 'claim');
  return { ok: claims.filter((s) => s.status === 'ok').length, struck: claims.filter((s) => s.status === 'struck').length };
}

/** The value in a grid cell with the receipt that backs it, or a plain statement that nothing does. */
export function Fact({ value, receipt, now, missing = 'unknown' }: { value: ReactNode; receipt?: ReceiptView; now: string; missing?: string }) {
  if (value == null || value === '') return <span className="muted">{missing}</span>;
  return (
    <span className="fact">
      <span>{value}</span>
      {receipt ? <Chip r={receipt} now={now} /> : <span className="no-receipt">no receipt</span>}
    </span>
  );
}

export function latest(receipts: ReceiptView[], entityId: string | undefined, field: string): ReceiptView | undefined {
  return receipts.filter((r) => r.entity_id === entityId && r.field === field && r.sign === 'positive').pop();
}
