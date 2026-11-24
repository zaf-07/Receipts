import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReceiptView, RoomMessage } from '../../../../shared/types';
import { useUi } from '../../api';
import { fmtTime } from '../../components';
import { Avatar, Rich, SEATS, nameOf, type Seat } from './shared';

// The room: what the agents said to each other, in order. A handoff names the next agent, a
// review asks a person to decide, and the decision is made right here. When Band is connected
// the same lines are in the Band room, and a reply typed there shows up here.

const KIND: Record<RoomMessage['kind'], string> = {
  handoff: 'Handoff',
  review: 'Needs your decision',
  decision: 'Decision',
  note: 'Instruction',
  update: 'Update',
};

type Scope = 'all' | 'you';

function Decide({ draftId }: { draftId: string }) {
  const { act, reviewer } = useUi();
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState('');
  if (rejecting) {
    return (
      <form
        className="tm-decide"
        onSubmit={(e) => {
          e.preventDefault();
          void act(`/messages/${draftId}/reject`, { reviewer, note: why });
        }}
      >
        <input autoFocus value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why? The team learns from the reason" aria-label="Reason for rejecting" />
        <button type="submit" className="btn small danger">
          Reject
        </button>
        <button type="button" className="link" onClick={() => setRejecting(false)}>
          cancel
        </button>
      </form>
    );
  }
  return (
    <div className="tm-decide">
      <button type="button" className="btn small primary" onClick={() => void act(`/messages/${draftId}/approve`, { reviewer })}>
        Approve and send
      </button>
      <button type="button" className="btn small" onClick={() => setRejecting(true)}>
        Reject
      </button>
    </div>
  );
}

export function Conversation({ index, seat, onSeat, lead = '' }: { index: Map<string, ReceiptView>; seat: Seat | null; onSeat: (s: Seat | null) => void; lead?: string }) {
  const { snap, act, openLead, reviewer } = useUi();
  const [scope, setScope] = useState<Scope>('all');
  const [thread, setThread] = useState(lead);
  const [to, setTo] = useState<Seat>('writer');
  const [body, setBody] = useState('');
  const list = useRef<HTMLOListElement>(null);

  const all = snap.team.room.messages;
  const leads = useMemo(() => new Map(snap.leads.map((l) => [l.id, l])), [snap.leads]);
  const drafts = useMemo(() => new Map(snap.leads.flatMap((l) => l.messages.map((m) => [m.id, m] as const))), [snap.leads]);
  const threads = useMemo(() => [...new Set(all.map((m) => m.lead_id).filter((id): id is string => Boolean(id)))].map((id) => leads.get(id)).filter(Boolean), [all, leads]);

  const shown = all.filter(
    (m) =>
      (scope === 'all' || m.to === 'human' || m.from === 'human') &&
      (!thread || m.lead_id === thread) &&
      (!seat || m.from === seat || m.to === seat),
  );
  const waiting = all.filter((m) => m.kind === 'review' && m.draft_id && drafts.get(m.draft_id)?.status === 'pending_review').length;

  // Follow the conversation as it grows, unless the reader has scrolled up to read something.
  const count = shown.length;
  useEffect(() => {
    const box = list.current;
    if (!box) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 260) box.scrollTop = box.scrollHeight;
  }, [count]);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [scope, thread, seat]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    if (await act('/team/notes', { agent: to, body, author: reviewer })) setBody('');
  }

  return (
    <section className="tm-room" aria-label="Team conversation">
      <header className="tm-room-head">
        <div className="tm-seg" role="group" aria-label="Which messages to show">
          <button type="button" className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
            Everything <b>{all.length}</b>
          </button>
          <button type="button" className={scope === 'you' ? 'on' : ''} onClick={() => setScope('you')}>
            To and from you {waiting > 0 && <b className="hot">{waiting} waiting</b>}
          </button>
        </div>
        <label className="tm-pick">
          <span>Lead</span>
          <select value={thread} onChange={(e) => setThread(e.target.value)}>
            <option value="">All leads</option>
            {threads.map((l) => (
              <option key={l!.id} value={l!.id}>
                {l!.company.name}
              </option>
            ))}
          </select>
        </label>
        {seat && (
          <button type="button" className="tm-filter" onClick={() => onSeat(null)}>
            Only {nameOf(seat)} <span aria-hidden="true">×</span>
          </button>
        )}
      </header>

      {shown.length === 0 ? (
        <div className="tm-room-empty">
          <h3>{all.length === 0 ? 'Nothing has been said yet' : 'No messages match'}</h3>
          <p>
            {all.length === 0
              ? 'Start a goal above. As each agent finishes its part it hands the work to the next one here, with the receipts it relied on, and asks you before anything is sent.'
              : 'Clear the filters to see the whole conversation.'}
          </p>
        </div>
      ) : (
        <ol className="tm-msgs" ref={list}>
          {shown.map((m, i) => {
            const lead = m.lead_id ? leads.get(m.lead_id) : null;
            const draft = m.draft_id ? drafts.get(m.draft_id) : null;
            const open = m.kind === 'review' && draft?.status === 'pending_review';
            const prev = shown[i - 1];
            const newThread = lead && (!prev || prev.lead_id !== m.lead_id);
            return (
              <li key={m.id} className={`tm-msg kind-${m.kind} ${m.from === 'human' ? 'mine' : ''} ${open ? 'open' : ''}`}>
                {newThread && (
                  <button type="button" className="tm-thread" onClick={() => openLead(lead.id)} title="Open this lead">
                    {lead.company.name}
                  </button>
                )}
                <div className="tm-msg-row">
                  <Avatar who={m.from} person={m.author} />
                  <div className="tm-msg-body">
                    <header>
                      <b>{nameOf(m.from, m.author)}</b>
                      {m.to && (
                        <span className={`tm-mention agent-${m.to}`}>
                          @{m.to === 'human' ? (snap.team.band.human ?? 'you') : nameOf(m.to)}
                        </span>
                      )}
                      <span className={`tm-kind k-${m.kind}`}>{KIND[m.kind]}</span>
                      <time>{fmtTime(m.at)}</time>
                      {m.in_band && (
                        <span className="tm-inband" title="This message is also in the Band room">
                          in Band
                        </span>
                      )}
                    </header>
                    <p>
                      <Rich text={m.text} index={index} now={snap.now} onDraft={(id) => (drafts.get(id) ? openLead(drafts.get(id)!.lead_id) : undefined)} />
                    </p>
                    {open && <Decide draftId={m.draft_id!} />}
                    {m.kind === 'review' && draft && !open && <p className="tm-settled">This draft is now {draft.status.replace('_', ' ')}.</p>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <form className="tm-compose" onSubmit={(e) => void send(e)}>
        <label className="tm-pick">
          <span>Tell</span>
          <select value={to} onChange={(e) => setTo(e.target.value as Seat)}>
            {SEATS.filter((s) => s.id !== 'human').map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="how to work, for example: keep every email under sixty words" aria-label="Instruction for the agent" />
        <button type="submit" className="btn primary" disabled={!body.trim()}>
          Send
        </button>
      </form>
      <p className="tm-compose-hint">
        An instruction is kept for that agent and applies from its next run.
        {snap.team.band.connected ? ' In the Band room, mention an agent to do the same from there.' : ''}
      </p>
    </section>
  );
}
