import type { AgentName, AgentTask, AgentTaskMessage, AgentTaskStatus } from '../../shared/types';
import { all, get, newId, parse, run } from '../db';
import { nowIso } from '../clock';
import { changed, log } from './activity';

const ASSIGNEES: AgentName[] = ['planner', 'researcher', 'enricher', 'writer', 'skeptic', 'analyst', 'human'];
const STATUSES: AgentTaskStatus[] = ['todo', 'doing', 'blocked', 'review', 'done'];

type TaskRow = Omit<AgentTask, 'depends_on'> & { depends_on: string };
const toTask = (row: TaskRow): AgentTask => ({ ...row, depends_on: parse<string[]>(row.depends_on, []) });

export function listTasks(): AgentTask[] {
  return all<TaskRow>('SELECT * FROM agent_tasks ORDER BY updated_at DESC, rowid DESC').map(toTask);
}

export function listTaskMessages(limit = 300): AgentTaskMessage[] {
  return all<AgentTaskMessage>('SELECT * FROM agent_task_messages ORDER BY created_at ASC, id ASC LIMIT ?', limit);
}

/** Notes are injected as bounded, untrusted operator intent on the next model-backed run. */
export function taskBrief(agent: AgentName): string {
  const tasks = listTasks().filter((item) => item.agent === agent && item.status !== 'done');
  if (tasks.length === 0) return '';
  const ids = new Set(tasks.map((item) => item.id));
  const notes = listTaskMessages().filter((message) => ids.has(message.task_id)).slice(-6);
  if (notes.length === 0) return '';
  return notes.map((message) => `- ${message.author}: ${message.body}`).join('\n');
}

function task(id: string): AgentTask | null {
  const row = get<TaskRow>('SELECT * FROM agent_tasks WHERE id = ?', id);
  return row ? toTask(row) : null;
}

function requireAgent(agent: string): AgentName {
  if (!ASSIGNEES.includes(agent as AgentName)) throw new Error('Choose one of the listed specialist agents.');
  return agent as AgentName;
}

function requireStatus(status: string): AgentTaskStatus {
  if (!STATUSES.includes(status as AgentTaskStatus)) throw new Error('Unknown task status.');
  return status as AgentTaskStatus;
}

export function createTask(input: { title: string; detail?: string; agent: string; depends_on?: string[]; lead_id?: string | null }): AgentTask {
  const title = input.title.trim().slice(0, 160);
  if (!title) throw new Error('A task needs a title.');
  const dependencies = [...new Set((input.depends_on ?? []).filter(Boolean).slice(0, 12))];
  const known = new Set(listTasks().map((item) => item.id));
  if (dependencies.some((id) => !known.has(id))) throw new Error('A dependency does not exist.');
  const id = newId('task');
  const at = nowIso();
  run(
    `INSERT INTO agent_tasks (id, title, detail, agent, status, depends_on, lead_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?)`,
    id,
    title,
    input.detail?.trim().slice(0, 1200) ?? '',
    requireAgent(input.agent),
    dependencies,
    input.lead_id ?? null,
    at,
    at,
  );
  const created = task(id)!;
  log('human', 'handoff', `Assigned task "${created.title}" to ${created.agent}.`, { lead_id: created.lead_id, ref: created.id });
  changed();
  return created;
}

export function setTaskStatus(id: string, value: string): AgentTask {
  const current = task(id);
  if (!current) throw new Error('Unknown task.');
  const status = requireStatus(value);
  if (status === 'doing') {
    const dependencies = current.depends_on.map(task);
    const pending = dependencies.find((dependency) => dependency?.status !== 'done');
    if (pending) throw new Error(`Wait for "${pending.title}" before starting this task.`);
  }
  run('UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
  const updated = task(id)!;
  log(updated.agent, status === 'blocked' ? 'block' : status === 'done' ? 'done' : 'info', `Task "${updated.title}" is ${status.replace('_', ' ')}.`, {
    lead_id: updated.lead_id,
    ref: updated.id,
  });
  changed();
  return updated;
}

/** Keep the high-level pipeline plan in sync with real agent work without fabricating a separate run. */
export function markAgentTask(agent: AgentName, status: 'doing' | 'done'): void {
  const tasks = listTasks();
  const current = tasks.find((item) => item.agent === agent && item.status === 'doing');
  if (status === 'done') {
    if (!current) return;
    run('UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?', 'done', nowIso(), current.id);
    changed();
    return;
  }
  if (current) return;
  const next = tasks.find((item) => item.agent === agent && item.status === 'todo' && item.depends_on.every((id) => task(id)?.status === 'done'));
  if (!next) return;
  run('UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?', 'doing', nowIso(), next.id);
  changed();
}

export function addTaskMessage(id: string, input: { author: string; body: string }): AgentTaskMessage {
  const current = task(id);
  if (!current) throw new Error('Unknown task.');
  const body = input.body.trim().slice(0, 1600);
  if (!body) throw new Error('Write a message before sending it.');
  const author = input.author.trim().slice(0, 80) || 'Human';
  run('INSERT INTO agent_task_messages (task_id, author, body, created_at) VALUES (?, ?, ?, ?)', id, author, body, nowIso());
  run('UPDATE agent_tasks SET updated_at = ? WHERE id = ?', nowIso(), id);
  const message = all<AgentTaskMessage>('SELECT * FROM agent_task_messages WHERE task_id = ? ORDER BY id DESC LIMIT 1', id)[0];
  log('human', 'info', `${author} left a note for ${current.agent} on "${current.title}".`, { lead_id: current.lead_id, ref: id });
  changed();
  return message;
}

/** Create the initial, dependency-safe plan after an ICP exists. It is deliberately idempotent. */
export function ensurePipelineTasks(): void {
  if (listTasks().length > 0) return;
  const plan = createTask({ title: 'Plan the ICP and search strategy', detail: 'Turn the approved product description into a versioned ICP and search plan.', agent: 'planner' });
  setTaskStatus(plan.id, 'doing');
  setTaskStatus(plan.id, 'done');
  const research = createTask({ title: 'Find accounts with live signals', detail: 'Create source-backed receipts and separate active, dormant, and disqualified accounts.', agent: 'researcher', depends_on: [plan.id] });
  const enrich = createTask({ title: 'Resolve the best contact', detail: 'Find a matching persona and mark email confidence honestly.', agent: 'enricher', depends_on: [research.id] });
  const draft = createTask({ title: 'Write receipt-backed outreach', detail: 'Draft only factual sentences that cite live receipts.', agent: 'writer', depends_on: [enrich.id] });
  const verify = createTask({ title: 'Re-check every cited source', detail: 'Verify or strike each factual claim before human review.', agent: 'skeptic', depends_on: [draft.id] });
  createTask({ title: 'Approve, edit, or reject verified drafts', detail: 'Nothing is sent without a person approving it.', agent: 'human', depends_on: [verify.id] });
}
