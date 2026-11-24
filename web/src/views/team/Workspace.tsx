import { useState } from 'react';
import type { ReceiptView, TaskRun } from '../../../../shared/types';
import { useUi } from '../../api';
import { Chip, fmtTime } from '../../components';
import { Avatar, KIND_LABEL, Rich, SEATS, nameOf, shortTitle, took, type Seat } from './shared';

// One agent's desk: what it is for, what it is doing this second, what it was told, and every
// piece of work it has done with what went in, what it did, and what came out.

const STATUS: Record<TaskRun['status'], string> = {
  queued: 'Up next',
  running: 'Working',
  blocked: 'Stopped',
  review: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
};

function Receipts({ ids, index, now, empty }: { ids: string[]; index: Map<string, ReceiptView>; now: string; empty: string }) {
  if (ids.length === 0) return <span className="muted small">{empty}</span>;
  const known = ids.map((id) => index.get(id)).filter((r): r is ReceiptView => Boolean(r));
  return (
    <span className="chips">
      {known.slice(0, 14).map((r) => (
        <Chip key={r.id} r={r} now={now} />
      ))}
      {ids.length > 14 && <span className="muted small">and {ids.length - 14} more</span>}
      {known.length === 0 && <span className="mono small muted">{ids.slice(0, 6).join(', ')}</span>}
    </span>
  );
}

/** Everything about one task, in the order it happened: given, did, produced. */
function TaskSheet({ task, index }: { task: TaskRun; index: Map<string, ReceiptView> }) {
  const { snap, act, openLead, openTask } = useUi();
  const deps = task.depends_on.map((id) => snap.tasks.find((t) => t.id === id)).filter((t): t is TaskRun => Boolean(t));
  const next = snap.tasks.filter((t) => t.depends_on.includes(task.id));
  const events = snap.activity.filter((a) => a.task_id === task.id).reverse();
  const draftIds = [...new Set([task.input.message_id, ...task.output_message_ids].filter(Boolean))];
  const drafts = snap.leads.flatMap((l) => l.messages).filter((m) => draftIds.includes(m.id));
  const run = snap.runs.find((r) => r.id === task.run_id);
  const duration = took(task.started_at, task.finished_at);

  return (
    <div className="tm-sheet">
      <p className="tm-sheet-title">{task.title}</p>
      {task.status === 'blocked' && (
        <p className="warning bad">
          <b>Stopped.</b> {task.blocker}
        </p>
      )}
      {task.status === 'failed' && (
        <p className="warning bad">
          <b>Failed after {task.attempt} attempts.</b> {task.error}
        </p>
      )}
      {task.status === 'queued' && task.error && <p className="warning">The last attempt failed: {task.error} It will be tried again.</p>}
      {(task.status === 'failed' || (task.status === 'blocked' && task.kind !== 'manual')) && (
        <div className="row-actions">
          <button type="button" className="btn small" onClick={() => void act(`/tasks/${task.id}/retry`)}>
            Try again
          </button>
          {task.blocker_code === 'credits' && (
            <button type="button" className="btn small primary" onClick={() => void act('/credits/topup', { amount: 50 })}>
              Top up 50 credits
            </button>
          )}
        </div>
      )}

      <div className="tm-flow">
        <section>
          <h4>
            <span>1</span> What it was given
          </h4>
          {task.detail && <p className="tm-brief">{task.detail}</p>}
          <Receipts ids={task.input_receipt_ids} index={index} now={snap.now} empty="No receipts. It started from the goal." />
          {deps.length > 0 && (
            <p className="tm-links">
              After{' '}
              {deps.map((d) => (
                <button key={d.id} type="button" className="link" onClick={() => openTask(d.id)}>
                  {nameOf(d.agent)}: {shortTitle(d)}
                </button>
              ))}
            </p>
          )}
        </section>

        <section>
          <h4>
            <span>2</span> What it did
          </h4>
          {events.length === 0 ? (
            <p className="muted small">{task.status === 'queued' ? 'Not started yet.' : 'Nothing was logged.'}</p>
          ) : (
            <ol className="tm-log">
              {events.map((e) => (
                <li key={e.id} className={`kind-${e.kind}`}>
                  <time>{fmtTime(e.at)}</time>
                  <span>
                    <Rich text={e.message} index={index} now={snap.now} />
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h4>
            <span>3</span> What it produced
          </h4>
          {task.result && <p className="tm-result">{task.result}</p>}
          <Receipts ids={task.output_receipt_ids} index={index} now={snap.now} empty={task.result || drafts.length ? '' : task.status === 'done' ? 'Nothing new.' : 'Not yet.'} />
          {drafts.map((m) => (
            <div key={m.id} className="tm-draft">
              <button type="button" className="link" onClick={() => openLead(m.lead_id)}>
                {m.channel === 'linkedin' ? 'LinkedIn note' : 'Email'} {m.variant}
              </button>
              <span className="tag">{m.status.replace('_', ' ')}</span>
              <ol>
                {snap.draft_versions
                  .filter((v) => v.message_id === m.id)
                  .map((v) => (
                    <li key={v.id}>
                      v{v.version} by {nameOf(v.author)}: {v.note}. {v.struck ? `${v.struck} of ${v.claims} claims struck` : `${v.claims} claim${v.claims === 1 ? '' : 's'}`}
                    </li>
                  ))}
              </ol>
            </div>
          ))}
          {next.length > 0 && (
            <p className="tm-links">
              Then{' '}
              {next.slice(0, 4).map((d) => (
                <button key={d.id} type="button" className="link" onClick={() => openTask(d.id)}>
                  {nameOf(d.agent)}: {shortTitle(d)}
                </button>
              ))}
              {next.length > 4 && <span className="muted small"> and {next.length - 4} more</span>}
            </p>
          )}
        </section>
      </div>

      <p className="tm-meta">
        {KIND_LABEL[task.kind]} · {run ? run.label : 'run'} · attempt {task.attempt} of {task.max_attempts}
        {duration && ` · took ${duration}`}
        {task.reserved_credits > 0 && ` · holding ${task.reserved_credits} credits`}
        {task.status === 'running' && task.lease_expires_at && ` · leased until ${fmtTime(task.lease_expires_at)}`}
      </p>
    </div>
  );
}

function Row({ task, index, open, onToggle }: { task: TaskRun; index: Map<string, ReceiptView>; open: boolean; onToggle: () => void }) {
  const { snap } = useUi();
  const lead = snap.leads.find((l) => l.id === task.lead_id);
  const line = task.status === 'blocked' ? task.blocker : task.status === 'failed' ? task.error : task.result;
  return (
    <li className={`tm-row st-${task.status} ${open ? 'open' : ''}`} id={`task-${task.id}`}>
      <button type="button" className="tm-row-head" onClick={onToggle} aria-expanded={open}>
        <span className={`tm-dot st-${task.status}`} aria-hidden="true" />
        <span className="tm-row-main">
          <strong>
            {shortTitle(task)}
            {lead && <em> · {lead.company.name}</em>}
          </strong>
          {line && <small>{line}</small>}
        </span>
        <span className="tm-row-side">
          <span className={`tm-state st-${task.status}`}>{STATUS[task.status]}</span>
          <time>{fmtTime(task.finished_at ?? task.started_at ?? task.created_at)}</time>
        </span>
      </button>
      {open && <TaskSheet task={task} index={index} />}
    </li>
  );
}

const ORDER: Record<TaskRun['status'], number> = { running: 0, review: 1, blocked: 2, failed: 2, queued: 3, done: 4 };
const CAP = 12;

export function Workspace({ seat, index, openId, onOpen }: { seat: Seat; index: Map<string, ReceiptView>; openId: string | null; onOpen: (id: string | null) => void }) {
  const { snap, act, reviewer, go } = useUi();
  const [body, setBody] = useState('');
  const [all, setAll] = useState(false);
  const info = SEATS.find((s) => s.id === seat)!;
  const role = snap.team.roles.find((r) => r.role === seat);
  const tasks = snap.tasks
    .filter((t) => t.agent === seat && t.kind !== 'manual')
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.finished_at ?? b.updated_at).localeCompare(a.finished_at ?? a.updated_at));
  const running = tasks.filter((t) => t.status === 'running');
  const live = snap.activity.filter((a) => running.some((t) => t.id === a.task_id)).slice(0, 6);
  const standing = snap.tasks.filter((t) => t.agent === seat && t.kind === 'manual').map((t) => t.id);
  const notes = snap.task_messages.filter((m) => standing.includes(m.task_id));
  const inbox = snap.team.room.messages.filter((m) => m.to === seat).slice(-4).reverse();
  const usage = snap.team.usage.by_agent.find((u) => u.agent === seat);
  const count = (s: TaskRun['status']) => tasks.filter((t) => t.status === s).length;
  const shown = all || (openId && tasks.findIndex((t) => t.id === openId) >= CAP) ? tasks : tasks.slice(0, CAP);
  const next = role && role.hands_off_to !== seat ? nameOf(role.hands_off_to) : null;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    if (await act('/team/notes', { agent: seat, body, author: reviewer })) setBody('');
  }

  return (
    <section className="tm-desk" aria-label={`${info.label} workspace`}>
      <aside className="tm-about">
        <header>
          <Avatar who={seat} person={seat === 'human' ? reviewer : null} size="lg" />
          <div>
            <h2>{seat === 'human' ? reviewer : info.label}</h2>
            <p>{role?.job ?? info.does}</p>
          </div>
        </header>
        <dl>
          <dt>Stops when</dt>
          <dd>{role?.stops_when ?? 'Its part is done'}</dd>
          {next && (
            <>
              <dt>Hands off to</dt>
              <dd>{next === 'You' ? 'You' : `the ${next}`}</dd>
            </>
          )}
        </dl>
        <ul className="tm-numbers">
          <li>
            <b>{count('done')}</b> done
          </li>
          <li>
            <b>{count('running') + count('queued')}</b> in hand
          </li>
          <li className={count('blocked') + count('failed') ? 'bad' : ''}>
            <b>{count('blocked') + count('failed')}</b> stopped
          </li>
        </ul>
        {usage && (
          <p className="tm-usage">
            {usage.calls} model call{usage.calls === 1 ? '' : 's'}, {usage.tokens.toLocaleString('en-GB')} tokens
            {usage.cost_usd != null && `, $${usage.cost_usd.toFixed(3)}`}
          </p>
        )}

        {seat === 'human' ? (
          <div className="tm-notes">
            <h4>Your part</h4>
            <p className="muted small">Every draft that survives the Skeptic and the Security scan stops here. Decide in the conversation, or open the review queue to read each draft in full.</p>
            <button type="button" className="btn small" onClick={() => go('review')}>
              Open the review queue
            </button>
          </div>
        ) : (
          <div className="tm-notes">
            <h4>Standing instructions</h4>
            {notes.length === 0 ? (
              <p className="muted small">None yet. Tell the {info.label} how you want it to work and it applies from the next run.</p>
            ) : (
              <ol>
                {notes.map((m) => (
                  <li key={m.id}>
                    <p>{m.body}</p>
                    <small>
                      {m.author}, {fmtTime(m.created_at)}
                    </small>
                  </li>
                ))}
              </ol>
            )}
            <form onSubmit={(e) => void send(e)}>
              <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={`Tell the ${info.label} how to work`} aria-label={`Instruction for the ${info.label}`} />
              <button type="submit" className="btn small" disabled={!body.trim()}>
                Save instruction
              </button>
            </form>
          </div>
        )}
      </aside>

      <div className="tm-work">
        <section className={`tm-now ${running.length ? 'live' : ''}`}>
          <h4>On the desk now</h4>
          {running.length === 0 ? (
            <p className="muted">{count('queued') ? `Nothing running. ${count('queued')} task${count('queued') === 1 ? ' is' : 's are'} up next.` : seat === 'human' ? (count('review') ? `${count('review')} draft${count('review') === 1 ? ' is' : 's are'} waiting for your decision.` : 'Nothing is waiting for you.') : 'Nothing right now.'}</p>
          ) : (
            <>
              <ul className="tm-running">
                {running.map((t) => (
                  <li key={t.id}>
                    <span className="tm-pulse" aria-hidden="true" />
                    {t.title}
                  </li>
                ))}
              </ul>
              {live.length > 0 && (
                <ol className="tm-log live">
                  {live.map((e) => (
                    <li key={e.id} className={`kind-${e.kind}`}>
                      <time>{fmtTime(e.at)}</time>
                      <span>
                        <Rich text={e.message} index={index} now={snap.now} />
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </section>

        {inbox.length > 0 && (
          <section className="tm-inbox">
            <h4>Last handed to {seat === 'human' ? 'you' : `the ${info.label}`}</h4>
            <ol>
              {inbox.map((m) => (
                <li key={m.id}>
                  <Avatar who={m.from} person={m.author} size="sm" />
                  <p>
                    <b>{nameOf(m.from, m.author)}</b> <time>{fmtTime(m.at)}</time>
                    <br />
                    <Rich text={m.text} index={index} now={snap.now} />
                  </p>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="tm-logbook">
          <h4>
            Work log <span>{tasks.length}</span>
          </h4>
          {tasks.length === 0 ? (
            <p className="muted">No work yet. The {info.label} starts when the step before it hands something over.</p>
          ) : (
            <ol className="tm-rows">
              {shown.map((t) => (
                <Row key={t.id} task={t} index={index} open={openId === t.id} onToggle={() => onOpen(openId === t.id ? null : t.id)} />
              ))}
            </ol>
          )}
          {tasks.length > CAP && !all && (
            <button type="button" className="link" onClick={() => setAll(true)}>
              Show all {tasks.length}
            </button>
          )}
        </section>
      </div>
    </section>
  );
}
