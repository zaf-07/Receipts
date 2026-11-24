import { useMemo, useState } from 'react';
import type { AgentName, ReceiptView, Snapshot, TaskKind, TaskRun, TaskStatus } from '../../../shared/types';
import { useUi } from '../api';
import { Chip, Empty, fmtTime } from '../components';

// The team, as the orchestrator sees it: every scoped task, who holds it, what it was given,
// what it produced, and what is stopping it. This screen only renders. The task records are
// the model, and the activity stream is the log.

const LANES: { id: TaskStatus; label: string; hint: string }[] = [
  { id: 'queued', label: 'Queued', hint: 'Waiting for a dependency or a free worker' },
  { id: 'running', label: 'Running', hint: 'Leased to a worker' },
  { id: 'blocked', label: 'Blocked', hint: 'Cannot proceed, with the reason named' },
  { id: 'review', label: 'Review', hint: 'Waiting for a person' },
  { id: 'done', label: 'Done', hint: 'Settled' },
  { id: 'failed', label: 'Failed', hint: 'Every attempt was used' },
];

const SHAPE: { agent: AgentName; label: string; scope: string }[] = [
  { agent: 'planner', label: 'Planner', scope: 'one ICP run' },
  { agent: 'researcher', label: 'Researcher', scope: 'one task per account' },
  { agent: 'enricher', label: 'Enricher', scope: 'one task per lead' },
  { agent: 'writer', label: 'Writer', scope: 'one task per enriched lead' },
  { agent: 'skeptic', label: 'Skeptic', scope: 'one task per draft' },
  { agent: 'security', label: 'Security', scope: 'one scan per draft' },
  { agent: 'human', label: 'Human gate', scope: 'one decision per draft' },
  { agent: 'analyst', label: 'Analyst', scope: 'one task per outcome' },
];

export const KIND_LABEL: Record<TaskKind, string> = {
  plan: 'Plan',
  search: 'Search',
  read: 'Read account',
  recheck: 'Re-check',
  enrich: 'Enrich',
  write: 'Draft',
  verify: 'Verify',
  scan: 'Security scan',
  approve: 'Human gate',
  learn: 'Learn',
  manual: 'Manual',
};

const CAP = 10;

/** Every receipt in the snapshot by id, so a task's input and output ids can be shown as chips. */
export function receiptIndex(snap: Snapshot): Map<string, ReceiptView> {
  const index = new Map<string, ReceiptView>();
  for (const lead of snap.leads) for (const r of lead.receipts) index.set(r.id, r);
  for (const rival of snap.competitors) for (const r of rival.receipts) index.set(r.id, r);
  return index;
}

function seconds(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return ms < 1000 ? `${Math.max(1, ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A short name for a card. The full title, with the lead and the contact, is in the detail panel. */
function shortTitle(task: TaskRun): string {
  if (task.kind === 'read') return `Read ${task.input.name ?? 'account'}`;
  if (task.kind === 'enrich') return 'Find the contact';
  if (task.kind === 'write') return 'Draft outreach';
  const what = task.input.channel === 'linkedin' ? 'LinkedIn note' : (task.input.channel ?? 'draft');
  if (task.kind === 'verify') return `Verify the ${what}`;
  if (task.kind === 'scan') return `Scan the ${what}`;
  if (task.kind === 'approve') return `Decide on the ${what}`;
  if (task.kind === 'learn') return 'Learn from the reply';
  return task.title;
}

function TaskCard({ task, selected, onSelect, sub }: { task: TaskRun; selected: boolean; onSelect: () => void; sub: string | null }) {
  return (
    <button type="button" className={`task-card status-${task.status} ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <span className="task-card-top">
        <span className={`agent agent-${task.agent}`}>{task.agent}</span>
        {task.attempt > 1 && <span className="tag t-old">attempt {task.attempt}</span>}
      </span>
      <strong title={task.title}>{shortTitle(task)}</strong>
      {sub && <small>{sub}</small>}
    </button>
  );
}

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

function Detail({ task, index }: { task: TaskRun; index: Map<string, ReceiptView> }) {
  const { snap, act, openLead, openTask } = useUi();
  const [body, setBody] = useState('');
  const run = snap.runs.find((r) => r.id === task.run_id);
  const lead = snap.leads.find((l) => l.id === task.lead_id);
  const deps = task.depends_on.map((id) => snap.tasks.find((t) => t.id === id)).filter((t): t is TaskRun => Boolean(t));
  const next = snap.tasks.filter((t) => t.depends_on.includes(task.id));
  const events = snap.activity.filter((a) => a.task_id === task.id).reverse();
  const notes = snap.task_messages.filter((m) => m.task_id === task.id);
  const draftIds = [...new Set([task.input.message_id, ...task.output_message_ids].filter(Boolean))];
  const drafts = snap.leads.flatMap((l) => l.messages).filter((m) => draftIds.includes(m.id));
  const took = seconds(task.started_at, task.finished_at);

  async function send() {
    if (!body.trim()) return;
    if (await act(`/tasks/${task.id}/messages`, { author: snap.profile?.sender || 'Human', body })) setBody('');
  }

  return (
    <aside className="task-detail">
      <header>
        <span className="task-card-top">
          <span className={`agent agent-${task.agent}`}>{task.agent}</span>
          <span className="tag">{KIND_LABEL[task.kind]}</span>
          <span className={`task-status status-${task.status}`}>{task.status}</span>
        </span>
        <h2>{task.title}</h2>
        {task.detail && <p>{task.detail}</p>}
      </header>

      {task.status === 'blocked' && (
        <p className="warning bad">
          <b>Blocked.</b> {task.blocker}
        </p>
      )}
      {task.status === 'failed' && (
        <p className="warning bad">
          <b>Failed after {task.attempt} attempts.</b> {task.error}
        </p>
      )}
      {task.status === 'queued' && task.error && <p className="warning">Last attempt failed: {task.error} It will be tried again.</p>}
      {task.result && <p className="task-result">{task.result}</p>}

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

      <dl className="task-facts">
        <dt>Run</dt>
        <dd>{run ? run.label : task.run_id}</dd>
        {lead && (
          <>
            <dt>Lead</dt>
            <dd>
              <button type="button" className="link" onClick={() => openLead(lead.id)}>
                {lead.company.name}
              </button>
            </dd>
          </>
        )}
        <dt>Attempt</dt>
        <dd>
          {task.attempt} of {task.max_attempts}
          {took && <span className="muted"> · took {took}</span>}
        </dd>
        {task.status === 'running' && (
          <>
            <dt>Lease</dt>
            <dd className="mono">
              {task.lease_owner}, until {task.lease_expires_at ? fmtTime(task.lease_expires_at) : 'unknown'}
            </dd>
          </>
        )}
        {task.reserved_credits > 0 && (
          <>
            <dt>Credits held</dt>
            <dd>{task.reserved_credits}</dd>
          </>
        )}
        <dt>Waits on</dt>
        <dd>
          {deps.length === 0
            ? 'Nothing'
            : deps.map((d) => (
                <button key={d.id} type="button" className="link dep" onClick={() => openTask(d.id)}>
                  {d.title} <span className={`task-status status-${d.status}`}>{d.status}</span>
                </button>
              ))}
        </dd>
        {next.length > 0 && (
          <>
            <dt>Hands off to</dt>
            <dd>
              {next.slice(0, 4).map((d) => (
                <button key={d.id} type="button" className="link dep" onClick={() => openTask(d.id)}>
                  {d.title} <span className={`task-status status-${d.status}`}>{d.status}</span>
                </button>
              ))}
              {next.length > 4 && <span className="muted small">and {next.length - 4} more</span>}
            </dd>
          </>
        )}
        <dt>Receipts in</dt>
        <dd>
          <Receipts ids={task.input_receipt_ids} index={index} now={snap.now} empty="None" />
        </dd>
        <dt>Receipts out</dt>
        <dd>
          <Receipts ids={task.output_receipt_ids} index={index} now={snap.now} empty={task.status === 'done' ? 'None written' : 'Not yet'} />
        </dd>
        {drafts.length > 0 && (
          <>
            <dt>Drafts</dt>
            <dd className="task-drafts">
              {drafts.map((m) => (
                <div key={m.id}>
                  <button type="button" className="link" onClick={() => openLead(m.lead_id)}>
                    {m.channel} {m.variant}
                  </button>
                  <span className="tag">{m.status.replace('_', ' ')}</span>
                  <ol>
                    {snap.draft_versions
                      .filter((v) => v.message_id === m.id)
                      .map((v) => (
                        <li key={v.id}>
                          <span className={`agent agent-${v.author}`}>{v.author}</span> v{v.version} · {v.note} ·{' '}
                          {v.struck ? `${v.struck} of ${v.claims} claims struck` : `${v.claims} claim${v.claims === 1 ? '' : 's'}`}
                        </li>
                      ))}
                  </ol>
                </div>
              ))}
            </dd>
          </>
        )}
      </dl>

      {task.kind === 'manual' && (
        <div className="task-actions" aria-label="Task status">
          {LANES.filter((l) => l.id !== 'failed').map((lane) => (
            <button key={lane.id} type="button" className={`btn small ${task.status === lane.id ? 'primary' : ''}`} onClick={() => void act(`/tasks/${task.id}/status`, { status: lane.id })}>
              {lane.label}
            </button>
          ))}
        </div>
      )}

      <h4>Events</h4>
      {events.length === 0 ? (
        <p className="muted small">Nothing logged for this task.</p>
      ) : (
        <ol className="task-events">
          {events.map((e) => (
            <li key={e.id} className={`kind-${e.kind}`}>
              <time>{fmtTime(e.at)}</time>
              <span>{e.message}</span>
            </li>
          ))}
        </ol>
      )}

      <h4>Notes for the {task.agent}</h4>
      <ol className="task-messages" aria-label="Task notes">
        {notes.map((m) => (
          <li key={m.id}>
            <header>
              <b>{m.author}</b>
              <time>{fmtTime(m.created_at)}</time>
            </header>
            <p>{m.body}</p>
          </li>
        ))}
      </ol>
      <div className="task-compose">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder={`Leave an instruction for the ${task.agent}`} />
        <button type="button" className="btn small" onClick={() => void send()}>
          Send note
        </button>
      </div>
    </aside>
  );
}

export function Team() {
  const { snap, act, openTask, taskId } = useUi();
  const [runId, setRunId] = useState<string>('all');
  const [agent, setAgent] = useState<AgentName | null>(null);
  const [expanded, setExpanded] = useState<TaskStatus | null>(null);
  const [title, setTitle] = useState('');
  const index = useMemo(() => receiptIndex(snap), [snap]);

  const inRun = snap.tasks.filter((t) => runId === 'all' || t.run_id === runId);
  const visible = inRun.filter((t) => !agent || t.agent === agent);
  const selected = snap.tasks.find((t) => t.id === taskId) ?? visible.find((t) => t.status === 'blocked' || t.status === 'review') ?? visible[0] ?? null;
  const leadName = (t: TaskRun) => snap.leads.find((l) => l.id === t.lead_id)?.company.name ?? null;
  const order = (status: TaskStatus) => (a: TaskRun, b: TaskRun) =>
    status === 'done' || status === 'failed' ? (b.finished_at ?? b.updated_at).localeCompare(a.finished_at ?? a.updated_at) : b.priority - a.priority || a.created_at.localeCompare(b.created_at);

  async function startGoal(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    if (await act('/goals', { goal: title })) setTitle('');
  }

  // The failed lane appears only when something has failed, so the board fits without scrolling.
  const lanes = LANES.filter((l) => l.id !== 'failed' || visible.some((t) => t.status === 'failed'));
  const count = (who: AgentName, status: TaskStatus) => inRun.filter((t) => t.agent === who && t.status === status).length;
  const working = inRun.filter((t) => t.status === 'queued' || t.status === 'running').length;
  const needsYou = inRun.filter((t) => t.status === 'review' || t.status === 'blocked' || t.status === 'failed').length;
  const complete = inRun.filter((t) => t.status === 'done').length;
  const suggestions = [
    'Find SaaS companies with fresh pricing changes and prepare verified outreach.',
    'Find cybersecurity companies hiring security leaders. Exclude layoffs and hiring freezes.',
    'Research B2B fintech companies with new funding or billing-platform signals.',
  ];

  return (
    <div className="page team-page">
      <header className="page-head">
        <div>
          <h1>Agent team</h1>
          <p>Describe the result you want. The team plans the work, checks the evidence, and brings only safe drafts back to you.</p>
        </div>
        <div className="head-actions">
          <label className="run-pick">
            Run
            <select value={runId} onChange={(e) => setRunId(e.target.value)}>
              <option value="all">All runs ({snap.tasks.length} tasks)</option>
              {snap.runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} · {fmtTime(r.created_at)} · {snap.tasks.filter((t) => t.run_id === r.id).length} tasks
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <section className="team-command" aria-label="Start a new agent goal">
        <div className="team-command-copy">
          <span className="eyebrow">Start a goal</span>
          <h2>What would you like the team to accomplish?</h2>
          <p>You set the outcome. The orchestrator assigns the specialists and keeps every claim tied to evidence.</p>
        </div>
        <form className="task-new" onSubmit={(event) => void startGoal(event)}>
          <label>
            Desired outcome
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Find 10 SaaS companies with recent pricing changes and prepare verified outreach" />
          </label>
          <button type="submit" className="btn primary">Start agents</button>
        </form>
        <div className="goal-suggestions" aria-label="Goal examples">
          <span>Try an example:</span>
          {suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => setTitle(suggestion)}>{suggestion}</button>)}
        </div>
      </section>

      <section className="team-overview" aria-label="Team status">
        <div className={`overview-stat ${snap.running ? 'is-working' : ''}`}>
          <span>Team status</span><strong>{snap.running ?? (working ? 'Working through tasks' : 'Ready when you are')}</strong>
          <small>{working ? `${working} task${working === 1 ? '' : 's'} in progress` : 'Start with a plain-language goal above.'}</small>
        </div>
        <div className={`overview-stat ${needsYou ? 'needs-action' : ''}`}>
          <span>Needs attention</span><strong>{needsYou}</strong><small>{needsYou ? 'Review, blocked, or failed tasks.' : 'Nothing needs a decision right now.'}</small>
        </div>
        <div className="overview-stat"><span>Completed</span><strong>{complete}</strong><small>Evidence checks and work steps finished.</small></div>
        <div className="team-meta"><span>{snap.team.concurrency} workers in parallel</span><span>{snap.team.usage.calls ? `${snap.team.usage.calls} model calls` : 'Evidence-first mode'}</span>{snap.team.band.connected && <span className="band-status on">Band connected</span>}</div>
      </section>

      {snap.tasks.length === 0 ? (
        <section className="team-empty-state"><span className="eyebrow">Your first run</span><h2>Start with an outcome, not a job list.</h2><ol><li>Describe the accounts or signals you care about.</li><li>The Planner turns that into research tasks.</li><li>You review only evidence-backed drafts at the Human gate.</li></ol></section>
      ) : (
        <>
          <section className="team-shape" aria-label="Team shape">
            <div className="team-lead">
              <b>How the team works</b>
              <span>The orchestrator routes work automatically. Select a role below to filter its tasks.</span>
            </div>
            <ol>
              {SHAPE.map((s) => {
                const running = count(s.agent, 'running');
                const blocked = count(s.agent, 'blocked') + count(s.agent, 'failed');
                return (
                  <li key={s.agent} className={`${agent === s.agent ? 'on' : ''} ${running ? 'is-running' : ''}`}>
                    <button type="button" onClick={() => setAgent(agent === s.agent ? null : s.agent)} aria-pressed={agent === s.agent}>
                      <span className={`agent agent-${s.agent}`}>{s.label}</span>
                      <small>{s.scope}</small>
                      <span className="shape-counts">
                        {running > 0 && <b className="c-running">{running} running</b>}
                        {count(s.agent, 'queued') > 0 && <b>{count(s.agent, 'queued')} queued</b>}
                        {count(s.agent, 'review') > 0 && <b className="c-review">{count(s.agent, 'review')} in review</b>}
                        {blocked > 0 && <b className="c-blocked">{blocked} blocked</b>}
                        {count(s.agent, 'done') > 0 && <b className="c-done">{count(s.agent, 'done')} done</b>}
                        {inRun.every((t) => t.agent !== s.agent) && <b>no tasks yet</b>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>

          <div className="team-layout">
            <section className="task-board-wrap" aria-label="Task board">
              <header className="board-head"><div><span className="eyebrow">Workflow</span><h2>{agent ? `${SHAPE.find((role) => role.agent === agent)?.label} tasks` : 'All work'}</h2></div>{agent && <button type="button" className="link" onClick={() => setAgent(null)}>Clear filter</button>}</header>
              <div className="task-board" style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(118px, 1fr))` }}>
              {lanes.map((lane) => {
                const tasks = visible.filter((t) => t.status === lane.id).sort(order(lane.id));
                const shown = expanded === lane.id ? tasks : tasks.slice(0, CAP);
                return (
                  <section className={`task-lane lane-${lane.id}`} key={lane.id}>
                    <header title={lane.hint}>
                      <h3>{lane.label}</h3>
                      <b>{tasks.length}</b>
                    </header>
                    {shown.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        selected={t.id === selected?.id}
                        onSelect={() => openTask(t.id)}
                        sub={[leadName(t), t.status === 'blocked' ? t.blocker : t.status === 'failed' ? t.error : leadName(t) ? null : t.result].filter(Boolean).join(' · ') || null}
                      />
                    ))}
                    {tasks.length > CAP && (
                      <button type="button" className="link more" onClick={() => setExpanded(expanded === lane.id ? null : lane.id)}>
                        {expanded === lane.id ? 'show fewer' : `show ${tasks.length - CAP} more`}
                      </button>
                    )}
                  </section>
                );
              })}
              </div>
            </section>

            {selected ? <Detail key={selected.id} task={selected} index={index} /> : <Empty title="No task selected">Select a task to see what it was given and what it produced.</Empty>}
          </div>
        </>
      )}

    </div>
  );
}
