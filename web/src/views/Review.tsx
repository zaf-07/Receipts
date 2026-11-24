import { useState } from 'react';
import type { LeadView, Message } from '../../../shared/types';
import { useUi } from '../api';
import { DraftBody, Empty, Tier, claimCounts } from '../components';

function Editor({ message, onDone }: { message: Message; onDone: () => void }) {
  const { act, reviewer } = useUi();
  const [subject, setSubject] = useState(message.subject);
  const [rows, setRows] = useState(message.sentences.map((s, index) => ({ index, text: s.text, keep: true, kind: s.kind, struck: s.status === 'struck' })));

  async function save() {
    const sentences = rows.filter((r) => r.keep).map((r) => ({ index: r.index, text: r.text }));
    if (await act(`/messages/${message.id}/edit`, { subject, sentences, reviewer })) onDone();
  }

  return (
    <div className="editor">
      <label>
        Subject
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <ol>
        {rows.map((r, i) => (
          <li key={r.index} className={`${r.keep ? '' : 'removed'} ${r.struck ? 'is-struck' : ''}`}>
            <span className={`tag ${r.kind === 'claim' ? 'good' : ''}`}>{r.struck ? 'struck' : r.kind}</span>
            <textarea
              rows={2}
              value={r.text}
              disabled={r.struck || !r.keep}
              onChange={(e) => setRows((all) => all.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
            />
            {!r.struck && (
              <button type="button" className="link" onClick={() => setRows((all) => all.map((x, j) => (j === i ? { ...x, keep: !x.keep } : x)))}>
                {r.keep ? 'remove' : 'restore'}
              </button>
            )}
          </li>
        ))}
      </ol>
      <p className="muted small">
        A claim keeps its receipts when you reword it, and the Skeptic checks it again. A connective cannot state a fact: figures and funding rounds need a receipt.
      </p>
      <div className="row-actions">
        <button type="button" className="btn primary" onClick={() => void save()}>
          Save and re-verify
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ReviewCard({ lead, compact = false }: { lead: LeadView; compact?: boolean }) {
  const { snap, act, openLead, reviewer } = useUi();
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const message = lead.message!;
  const counts = claimCounts(message);
  const pending = message.status === 'pending_review';

  return (
    <article className={`review-card status-${message.status}`}>
      <header>
        <div>
          <button type="button" className="link strong" onClick={() => openLead(lead.id)}>
            {lead.company.name}
          </button>
          <Tier tier={lead.tier} />
          <span className="muted small">score {lead.score}</span>
        </div>
        <div className="verdict">
          <span className="tag good">{counts.ok} verified</span>
          {counts.struck > 0 && <span className="tag bad">{counts.struck} struck</span>}
          <span className="tag">{message.writer === 'llm' ? 'model writer' : 'template writer'}</span>
        </div>
      </header>

      {editing ? <Editor message={message} onDone={() => setEditing(false)} /> : <DraftBody message={message} lead={lead} now={snap.now} />}

      {lead.person?.email_status === 'guessed' && pending && (
        <p className="warning">The email address is a pattern guess with no receipt. {lead.enrich_note}</p>
      )}
      {lead.person?.email_status === 'verified' && lead.person.mail_check === 'accepts_mail' && pending && <p className="muted small">Mail server check: {lead.person.mail_note}</p>}
      {message.status === 'blocked' && <p className="warning bad">Blocked before review: {message.block_reason}</p>}
      {message.status === 'rejected' && <p className="warning">Rejected by {message.reviewer}: {message.block_reason}</p>}
      {message.status === 'sent' && (
        <p className="warning good">
          Approved by {message.reviewer}. Send logged {message.sent_at ? new Date(message.sent_at).toLocaleString('en-GB') : ''}. Delivery is simulated.
        </p>
      )}

      {pending && !editing && !compact && (
        <footer className="row-actions">
          <button type="button" className="btn primary" onClick={() => void act(`/messages/${message.id}/approve`, { reviewer })}>
            Approve and send
          </button>
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="btn" onClick={() => setRejecting((v) => !v)}>
            Reject
          </button>
          <button type="button" className="btn ghost" onClick={() => void act(`/leads/${lead.id}/verify`)} title="Re-open every cited source now">
            Re-verify sources
          </button>
        </footer>
      )}
      {rejecting && pending && (
        <div className="reject">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why? (optional)" autoFocus />
          <button
            type="button"
            className="btn"
            onClick={async () => {
              if (await act(`/messages/${message.id}/reject`, { reviewer, note })) setRejecting(false);
            }}
          >
            Confirm reject
          </button>
        </div>
      )}
    </article>
  );
}

export function Review() {
  const { snap } = useUi();
  const withDraft = snap.leads.filter((l) => l.message);
  const pending = withDraft.filter((l) => l.message!.status === 'pending_review');
  const blocked = withDraft.filter((l) => l.message!.status === 'blocked');
  const done = withDraft.filter((l) => l.message!.status === 'sent' || l.message!.status === 'rejected');

  return (
    <div className="page narrow">
      <header className="page-head">
        <div>
          <h1>Review queue</h1>
          <p>
            Before a draft reaches you, the Skeptic re-opens every source and strikes what it cannot confirm. Struck sentences stay visible. Nothing sends without
            your click.
          </p>
        </div>
      </header>

      {withDraft.length === 0 && <Empty title="No drafts yet">Drafts appear here once discovery has found accounts with a live reason and a resolved contact.</Empty>}

      {pending.length > 0 && <h2 className="group">Waiting for you · {pending.length}</h2>}
      {pending.map((l) => (
        <ReviewCard key={l.id} lead={l} />
      ))}

      {blocked.length > 0 && <h2 className="group">Blocked by the Skeptic · {blocked.length}</h2>}
      {blocked.map((l) => (
        <ReviewCard key={l.id} lead={l} />
      ))}

      {done.length > 0 && <h2 className="group">Decided · {done.length}</h2>}
      {done.map((l) => (
        <ReviewCard key={l.id} lead={l} />
      ))}
    </div>
  );
}
