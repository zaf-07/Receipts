import { useMemo, useState } from 'react';
import type { AgentName, AgentTask, AgentTaskStatus } from '../../../shared/types';
import { useUi } from '../api';
import { Empty, fmtTime } from '../components';

const LANES: { id: AgentTaskStatus; label: string }[] = [
  { id: 'todo', label: 'Queued' },
  { id: 'doing', label: 'Working' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

const AGENTS: AgentName[] = ['planner', 'researcher', 'enricher', 'writer', 'skeptic', 'analyst', 'human'];

function TaskCard({ task, selected, onSelect }: { task: AgentTask; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`task-card ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <span className={`agent agent-${task.agent}`}>{task.agent}</span>
      <strong>{task.title}</strong>
      {task.depends_on.length > 0 && <small>waits on {task.depends_on.length} task{task.depends_on.length === 1 ? '' : 's'}</small>}
    </button>
  );
}

export function Team() {
  const { snap, act } = useUi();
  const [selected, setSelected] = useState<string | null>(snap.tasks[0]?.id ?? null);
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState<AgentName>('researcher');
  const [body, setBody] = useState('');
  const task = snap.tasks.find((item) => item.id === selected) ?? null;
  const taskMessages = useMemo(() => (task ? snap.task_messages.filter((message) => message.task_id === task.id) : []), [snap.task_messages, task]);

  async function addTask(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    if (await act('/tasks', { title, agent })) setTitle('');
  }

  async function send() {
    if (!task || !body.trim()) return;
    if (await act(`/tasks/${task.id}/messages`, { author: snap.profile?.sender || 'Human', body })) setBody('');
  }

  return (
    <div className="page team-page">
      <header className="page-head">
        <div>
          <h1>Agent team</h1>
          <p>Assign bounded work, make dependencies explicit, and leave instructions on the task that owns the outcome.</p>
        </div>
      </header>

      <div className="team-layout">
        <section className="task-board" aria-label="Agent task board">
          {LANES.map((lane) => {
            const tasks = snap.tasks.filter((item) => item.status === lane.id);
            return (
              <section className="task-lane" key={lane.id}>
                <header>
                  <h3>{lane.label}</h3>
                  <b>{tasks.length}</b>
                </header>
                {tasks.map((item) => <TaskCard key={item.id} task={item} selected={item.id === selected} onSelect={() => setSelected(item.id)} />)}
              </section>
            );
          })}
        </section>

        <aside className="task-detail">
          {task ? (
            <>
              <header>
                <span className={`agent agent-${task.agent}`}>{task.agent}</span>
                <h2>{task.title}</h2>
                {task.detail && <p>{task.detail}</p>}
              </header>
              <div className="task-actions" aria-label="Task status">
                {LANES.map((lane) => (
                  <button key={lane.id} type="button" className={`btn small ${task.status === lane.id ? 'primary' : ''}`} onClick={() => void act(`/tasks/${task.id}/status`, { status: lane.id })}>
                    {lane.label}
                  </button>
                ))}
              </div>
              <ol className="task-messages" aria-label="Task messages">
                {taskMessages.map((message) => (
                  <li key={message.id}>
                    <header><b>{message.author}</b><time>{fmtTime(message.created_at)}</time></header>
                    <p>{message.body}</p>
                  </li>
                ))}
              </ol>
              <div className="task-compose">
                <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} placeholder={`Message the ${task.agent}…`} />
                <button type="button" className="btn primary" onClick={() => void send()}>Send note</button>
              </div>
            </>
          ) : (
            <Empty title="No task selected">Select a task to communicate with its assigned agent.</Empty>
          )}
        </aside>
      </div>

      <form className="task-new" onSubmit={(event) => void addTask(event)}>
        <label>New task<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Re-check Northbeam’s pricing page" /></label>
        <label>Assign to<select value={agent} onChange={(event) => setAgent(event.target.value as AgentName)}>{AGENTS.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <button type="submit" className="btn">Assign task</button>
      </form>
    </div>
  );
}
