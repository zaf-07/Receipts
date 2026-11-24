import { useEffect, useMemo, useState } from 'react';
import { useUi } from '../api';
import { Board, cardsWaiting } from './team/Board';
import { Conversation } from './team/Conversation';
import { Workspace } from './team/Workspace';
import { Avatar, SEATS, receiptIndex, seatStatus, type Seat } from './team/shared';

export { KIND_LABEL, receiptIndex } from './team/shared';

// The agent team, in three views of the same work.
//
//   Conversation  what the agents said to each other, and what they asked you
//   Board         how far each lead has come, and who stopped it when it stopped
//   Workspace     one agent's desk: what it was given, what it did, what it produced
//
// The crew strip above them is always there, so there is always an answer to "what is each agent
// doing right now". Nothing here is a summary written for the screen: the conversation is the
// room log, the board is the cards the agents report on, and the workspace is the task records.

type Tab = 'talk' | 'board' | 'desk';

const EXAMPLES = [
  'Find SaaS companies with fresh pricing changes and prepare verified outreach.',
  'Find cybersecurity companies hiring security leaders. Exclude layoffs and hiring freezes.',
  'Research B2B fintech companies with new funding or billing-platform signals.',
];

export function Team() {
  const { snap, act, taskId, reviewer } = useUi();
  const [tab, setTab] = useState<Tab>('talk');
  const [seat, setSeat] = useState<Seat | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [talkLead, setTalkLead] = useState('');
  const index = useMemo(() => receiptIndex(snap), [snap]);

  // A task opened from the activity feed lands on its agent's desk, with that task open.
  useEffect(() => {
    const task = taskId ? snap.tasks.find((t) => t.id === taskId) : null;
    if (!task) return;
    const owner = SEATS.find((s) => s.id === task.agent);
    if (!owner) return;
    setSeat(owner.id);
    setTab('desk');
    setOpenId(task.id);
    window.setTimeout(() => document.getElementById(`task-${task.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
    // Only when a different task is asked for, not on every refresh of the snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const leadName = (id: string | null) => snap.leads.find((l) => l.id === id)?.company.name ?? null;
  const band = snap.team.band;
  const room = snap.team.room;
  const needYou = snap.tasks.filter((t) => t.status === 'review').length;
  const stopped = snap.tasks.filter((t) => t.status === 'blocked' || t.status === 'failed').length;
  const busy = snap.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
  const desk: Seat = seat ?? SEATS.find((s) => snap.tasks.some((t) => t.agent === s.id && t.status === 'running'))?.id ?? 'writer';

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!goal.trim()) return;
    if (await act('/goals', { goal })) setGoal('');
  }

  function pick(id: Seat) {
    if (tab === 'desk') return setSeat(id);
    setSeat(seat === id ? null : id);
  }

  return (
    <div className="page tm-page">
      <header className="page-head">
        <div>
          <h1>Agent team</h1>
          <p>Eight specialists pass each lead along a line. Every handoff carries its evidence, and nothing is sent until you say so.</p>
        </div>
        <div className={`tm-band ${band.connected ? 'on' : band.configured ? 'off' : ''}`}>
          <span className="tm-band-dot" aria-hidden="true" />
          {band.connected ? (
            <span>
              <b>Live in Band</b>
              {band.agents.length} agents in the room{band.human ? `, decisions go to @${band.human}` : ''}
            </span>
          ) : band.configured ? (
            <span>
              <b>Band is not reachable</b>
              {band.last_error ?? 'The team keeps working here'}
            </span>
          ) : (
            <span>
              <b>Local room</b>
              Add Band keys to mirror this room in Band
            </span>
          )}
        </div>
      </header>

      <form className="tm-goal" onSubmit={(e) => void start(e)}>
        <label htmlFor="tm-goal-input">Give the team a goal</label>
        <div className="tm-goal-row">
          <input id="tm-goal-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Find 10 SaaS companies with recent pricing changes and prepare verified outreach" />
          <button type="submit" className="btn primary" disabled={!goal.trim() || Boolean(snap.running)}>
            Start the team
          </button>
        </div>
        <div className="tm-examples">
          <span>Try:</span>
          {EXAMPLES.map((x) => (
            <button type="button" key={x} onClick={() => setGoal(x)}>
              {x}
            </button>
          ))}
        </div>
      </form>

      <section className="tm-crew-wrap" aria-label="The crew">
        <header className="tm-crew-head">
          <h3>The crew</h3>
          <p className={snap.running || busy ? 'live' : ''}>
            {snap.running ? snap.running : busy ? `${busy} task${busy === 1 ? '' : 's'} in hand` : snap.tasks.length ? 'Idle' : 'Waiting for a goal'}
            {needYou > 0 && <b className="you"> · {needYou} waiting for you</b>}
            {stopped > 0 && <b className="bad"> · {stopped} stopped</b>}
          </p>
        </header>
        <ol className="tm-crew">
          {SEATS.map((s) => {
            const status = seatStatus(snap.tasks, s.id, leadName);
            const on = (tab === 'desk' ? desk : seat) === s.id;
            return (
              <li key={s.id}>
                <button type="button" className={`tm-seat tone-${status.tone} ${on ? 'on' : ''}`} onClick={() => pick(s.id)} aria-pressed={on} title={s.does}>
                  <span className="tm-seat-top">
                    <Avatar who={s.id} person={s.id === 'human' ? reviewer : null} />
                    <span className="tm-seat-light" aria-hidden="true" />
                  </span>
                  <strong>{s.label}</strong>
                  <small>{status.line}</small>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="tm-crew-foot">
          Work moves left to right. Select an agent to {tab === 'desk' ? 'see its desk' : tab === 'talk' ? 'see only what it said and was told' : 'open its desk'}.
        </p>
      </section>

      <nav className="tm-tabs" aria-label="Views of the team">
        <button type="button" className={tab === 'talk' ? 'on' : ''} onClick={() => setTab('talk')}>
          Conversation <b>{room.messages.length}</b>
        </button>
        <button type="button" className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
          Board <b>{room.cards.length}</b>
          {cardsWaiting(room.cards) > 0 && <i>{cardsWaiting(room.cards)} need you</i>}
        </button>
        <button type="button" className={tab === 'desk' ? 'on' : ''} onClick={() => setTab('desk')}>
          Workspace
        </button>
      </nav>

      {tab === 'talk' && <Conversation key={talkLead} lead={talkLead} index={index} seat={seat} onSeat={setSeat} />}
      {tab === 'board' && (
        <Board
          index={index}
          onTalk={(leadId) => {
            setSeat(null);
            setTalkLead(leadId);
            setTab('talk');
          }}
        />
      )}
      {tab === 'desk' && <Workspace key={desk} seat={desk} index={index} openId={openId} onOpen={setOpenId} />}
    </div>
  );
}
