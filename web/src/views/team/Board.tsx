import { useState } from 'react';
import type { CardStatus, ReceiptView, RoomCard, RoomSpeaker } from '../../../../shared/types';
import { useUi } from '../../api';
import { Tier, fmtTime } from '../../components';
import { Avatar, Rich, nameOf } from './shared';

// The board: one card per lead, and on each card the same five steps. Every agent reports its
// own step, so a glance says how far a lead has come and, when it stopped, who stopped it and why.

const STAGES: { id: RoomSpeaker; label: string }[] = [
  { id: 'enricher', label: 'Contact' },
  { id: 'writer', label: 'Draft' },
  { id: 'skeptic', label: 'Verify' },
  { id: 'security', label: 'Scan' },
  { id: 'human', label: 'You' },
];

type Column = 'working' | 'you' | 'stopped' | 'done';

const COLUMNS: { id: Column; label: string; hint: string }[] = [
  { id: 'working', label: 'In progress', hint: 'An agent is working on it' },
  { id: 'you', label: 'Needs you', hint: 'Verified and cleared. Waiting for your decision' },
  { id: 'stopped', label: 'Stopped', hint: 'An agent stopped, and says why' },
  { id: 'done', label: 'Done', hint: 'Decided' },
];

type StepState = 'todo' | 'doing' | 'done' | 'stopped' | 'you';

function read(card: RoomCard) {
  const latest = new Map<RoomSpeaker, CardStatus>();
  for (const s of card.steps) latest.set(s.agent, s.status);
  const security = latest.get('security');
  const stopped = [...latest.values()].some((s) => s === 'blocked' || s === 'failed');
  const column: Column = security === 'in_review' ? 'you' : stopped ? 'stopped' : security === 'completed' ? 'done' : 'working';
  const state = (id: RoomSpeaker): StepState => {
    if (id === 'human') return security === 'in_review' ? 'you' : security === 'completed' ? 'done' : 'todo';
    const s = latest.get(id);
    if (!s) return 'todo';
    if (s === 'blocked' || s === 'failed') return 'stopped';
    if (s === 'completed' || (id === 'security' && s === 'in_review')) return 'done';
    return 'doing';
  };
  const last = [...card.steps].reverse().find((s) => s.comment || s.doing);
  return { column, state, last };
}

const STATUS_WORD: Record<CardStatus, string> = {
  pending: 'waiting',
  in_progress: 'started',
  blocked: 'stopped',
  in_review: 'asked for a decision',
  failed: 'failed',
  completed: 'finished',
};

function Card({ card, index, onTalk }: { card: RoomCard; index: Map<string, ReceiptView>; onTalk: (leadId: string) => void }) {
  const { snap, openLead } = useUi();
  const [open, setOpen] = useState(false);
  const lead = snap.leads.find((l) => l.id === card.lead_id);
  const { state, last, column } = read(card);
  const name = card.subject.replace(/^Outreach to /, '');
  return (
    <article className={`tm-card col-${column} ${open ? 'open' : ''}`}>
      <button type="button" className="tm-card-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tm-card-title">
          <strong>{name}</strong>
          {lead && <Tier tier={lead.tier} />}
        </span>
        <ol className="tm-steps" aria-label="Progress">
          {STAGES.map((s) => (
            <li key={s.id} className={`s-${state(s.id)}`} title={`${s.label}: ${state(s.id)}`}>
              <i aria-hidden="true" />
              <span>{s.label}</span>
            </li>
          ))}
        </ol>
        {last && (
          <span className="tm-card-last">
            <b>{nameOf(last.agent)}:</b> {last.comment ?? last.doing}
          </span>
        )}
      </button>
      {open && (
        <div className="tm-card-more">
          <ol className="tm-history">
            {card.steps.map((s, i) => (
              <li key={i} className={`h-${s.status}`}>
                <Avatar who={s.agent} size="sm" />
                <div>
                  <header>
                    <b>{nameOf(s.agent)}</b> {STATUS_WORD[s.status]}
                    <time>{fmtTime(s.at)}</time>
                  </header>
                  {(s.comment ?? s.doing) && (
                    <p>
                      <Rich text={(s.comment ?? s.doing)!} index={index} now={snap.now} />
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="row-actions">
            {lead && (
              <button type="button" className="btn small" onClick={() => openLead(lead.id)}>
                Open the lead
              </button>
            )}
            {card.lead_id && (
              <button type="button" className="btn small ghost" onClick={() => onTalk(card.lead_id!)}>
                Show the conversation
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

export function Board({ index, onTalk }: { index: Map<string, ReceiptView>; onTalk: (leadId: string) => void }) {
  const { snap } = useUi();
  const cards = snap.team.room.cards;
  if (cards.length === 0) {
    return (
      <div className="tm-room-empty">
        <h3>No leads on the board yet</h3>
        <p>A lead gets a card when it has a live reason to contact. The card then moves through five steps: contact, draft, verify, scan, and your decision.</p>
      </div>
    );
  }
  const byColumn = (id: Column) => cards.filter((c) => read(c).column === id).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return (
    <section className="tm-board" aria-label="Work board">
      {COLUMNS.map((col) => {
        const mine = byColumn(col.id);
        return (
          <div className={`tm-col col-${col.id}`} key={col.id}>
            <header title={col.hint}>
              <h3>{col.label}</h3>
              <b>{mine.length}</b>
            </header>
            <p className="tm-col-hint">{col.hint}</p>
            {mine.map((c) => (
              <Card key={c.subject} card={c} index={index} onTalk={onTalk} />
            ))}
            {mine.length === 0 && <p className="tm-col-none">None</p>}
          </div>
        );
      })}
    </section>
  );
}

/** How many cards are waiting for a person, for the tab label. */
export function cardsWaiting(cards: RoomCard[]): number {
  return cards.filter((c) => read(c).column === 'you').length;
}
