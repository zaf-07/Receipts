import type { AgentName, AgentTaskMessage, BlockerCode, PipelineRun, TaskKind, TaskRun, TaskStatus } from '../../shared/types';
import { all, get, newId, parse, run } from '../db';
import { config } from '../config';
import { changed, log } from './activity';
import { currentTask } from './context';
import { balance } from './ledger';

// The task model: the durable record of who is doing what.
//
// A task is one scoped unit of work for one agent. It is leased to a worker for a short time
// rather than owned by it, so a worker that dies does not take its task with it: the lease
// expires and the task is retried. A task settles exactly once, and only by the worker that
// holds its current lease, which is what makes retries and stale workers safe.
//
// Only the orchestrator creates tasks. A worker returns an outcome and nothing else.

/** Leases are measured on the real clock. The demo clock can jump months and must not expire them. */
let clock: () => number = () => Date.now();
export function setTaskClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}
const iso = (ms = clock()) => new Date(ms).toISOString();

const ASSIGNEES: AgentName[] = ['planner', 'researcher', 'enricher', 'writer', 'skeptic', 'analyst', 'human'];

type TaskRow = Omit<TaskRun, 'depends_on' | 'input' | 'input_receipt_ids' | 'output_receipt_ids' | 'output_message_ids'> & {
  depends_on: string;
  input: string;
  input_receipt_ids: string;
  output_receipt_ids: string;
  output_message_ids: string;
};

const toTask = (row: TaskRow): TaskRun => ({
  ...row,
  depends_on: parse<string[]>(row.depends_on, []),
  input: parse<Record<string, string>>(row.input, {}),
  input_receipt_ids: parse<string[]>(row.input_receipt_ids, []),
  output_receipt_ids: parse<string[]>(row.output_receipt_ids, []),
  output_message_ids: parse<string[]>(row.output_message_ids, []),
});

// ---------- runs ----------

export function createRun(kind: PipelineRun['kind'], label: string): PipelineRun {
  const id = newId('run');
  run('INSERT INTO runs (id, kind, label, status, created_at) VALUES (?, ?, ?, ?, ?)', id, kind, label, 'active', iso());
  return get<PipelineRun>('SELECT * FROM runs WHERE id = ?', id)!;
}

export function getRun(id: string): PipelineRun | null {
  return get<PipelineRun>('SELECT * FROM runs WHERE id = ?', id) ?? null;
}

export function listRuns(limit = 30): PipelineRun[] {
  return all<PipelineRun>('SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?', limit);
}

export function setRunPhase(id: string, phase: string): void {
  run('UPDATE runs SET phase = ? WHERE id = ?', phase, id);
}

/** A run is done once none of its tasks is queued or running. Waiting on a person or a blocker does not hold it open. */
export function settleRuns(): void {
  for (const r of all<PipelineRun>("SELECT * FROM runs WHERE status = 'active'")) {
    const open = get<{ n: number }>("SELECT COUNT(*) AS n FROM task_runs WHERE run_id = ? AND status IN ('queued', 'running')", r.id)?.n ?? 0;
    if (open === 0) run("UPDATE runs SET status = 'done', finished_at = ? WHERE id = ?", iso(), r.id);
  }
}

// ---------- reading ----------

export function getTask(id: string): TaskRun | null {
  const row = get<TaskRow>('SELECT * FROM task_runs WHERE id = ?', id);
  return row ? toTask(row) : null;
}

export function listTasks(limit = 600): TaskRun[] {
  return all<TaskRow>('SELECT * FROM task_runs ORDER BY created_at DESC, rowid DESC LIMIT ?', limit).map(toTask);
}

export function tasksWhere(where: string, ...params: unknown[]): TaskRun[] {
  return all<TaskRow>(`SELECT * FROM task_runs WHERE ${where} ORDER BY priority DESC, created_at, rowid`, ...params).map(toTask);
}

export function taskByKey(key: string): TaskRun | null {
  const row = get<TaskRow>('SELECT * FROM task_runs WHERE idempotency_key = ?', key);
  return row ? toTask(row) : null;
}

// ---------- creating ----------

export interface TaskSpec {
  run_id: string;
  kind: TaskKind;
  agent: AgentName;
  title: string;
  detail?: string;
  lead_id?: string | null;
  depends_on?: string[];
  priority?: number;
  input?: Record<string, string>;
  input_receipt_ids?: string[];
  /** The same key always returns the same task, so planning twice never does the work twice. */
  key?: string;
  /** A task for a person starts in review. Everything else starts queued. */
  status?: 'queued' | 'review';
  max_attempts?: number;
  reserved_credits?: number;
}

/**
 * Create a task. Idempotent on `key`. Refuses to run from inside a worker:
 * workers do scoped work, and only the orchestrator decides what happens next.
 */
export function enqueue(spec: TaskSpec): TaskRun {
  if (currentTask()) throw new Error('A worker cannot create tasks. Return an outcome and let the orchestrator plan the next step.');
  if (spec.key) {
    const existing = taskByKey(spec.key);
    if (existing) return existing;
  }
  const id = newId('task');
  const at = iso();
  run(
    `INSERT INTO task_runs (id, run_id, lead_id, agent, kind, title, detail, status, depends_on, priority, max_attempts,
       reserved_credits, input, input_receipt_ids, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    spec.run_id,
    spec.lead_id ?? null,
    spec.agent,
    spec.kind,
    spec.title.slice(0, 200),
    (spec.detail ?? '').slice(0, 1200),
    spec.status ?? 'queued',
    [...new Set(spec.depends_on ?? [])],
    spec.priority ?? 0,
    spec.max_attempts ?? 3,
    spec.reserved_credits ?? 0,
    spec.input ?? {},
    spec.input_receipt_ids ?? [],
    spec.key ?? null,
    at,
    at,
  );
  return getTask(id)!;
}

// ---------- leasing ----------

/** Credits a task of this kind must be able to hold before it starts. Enrichment holds the draft's cost too. */
export function creditNeed(kind: TaskKind): number {
  if (kind === 'enrich') return config.costs.enrich + config.costs.draft;
  if (kind === 'write') return config.costs.draft;
  return 0;
}

/** Balance that is not already promised to a queued or running task. */
export function availableCredits(exceptTaskId?: string): number {
  const held =
    get<{ total: number | null }>(
      "SELECT SUM(reserved_credits) AS total FROM task_runs WHERE status IN ('queued', 'running') AND id != ?",
      exceptTaskId ?? '',
    )?.total ?? 0;
  return balance() - held;
}

function set(id: string, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  run(`UPDATE task_runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => patch[k]), iso(), id);
}

export interface Claim {
  task: TaskRun | null;
  /** Tasks that could not start in this pass because the balance cannot cover them. */
  blocked: TaskRun[];
}

/**
 * Lease the next task that is ready: queued, every dependency done, highest priority first.
 * Runs synchronously, so two workers can never be handed the same task.
 */
export function claim(owner: string, leaseMs: number, kinds: TaskKind[]): Claim {
  const blocked: TaskRun[] = [];
  const candidates = tasksWhere("status = 'queued'").filter((t) => kinds.includes(t.kind));
  for (const task of candidates) {
    const deps = task.depends_on.map(getTask);
    if (deps.some((d) => !d || d.status === 'failed')) {
      const failed = deps.find((d) => d?.status === 'failed');
      set(task.id, { status: 'blocked', blocker: failed ? `Waiting on a task that failed: ${failed.title}` : 'A dependency no longer exists.', blocker_code: 'dependency' });
      continue;
    }
    if (deps.some((d) => d!.status !== 'done')) continue;

    const need = creditNeed(task.kind);
    if (need > task.reserved_credits) {
      if (availableCredits(task.id) < need) {
        // A running task may still hand its hold back (an unresolved contact costs nothing).
        // Until those are settled the shortfall is not certain, so this task simply waits its turn.
        const pending = get<{ total: number | null }>("SELECT SUM(reserved_credits) AS total FROM task_runs WHERE status = 'running' AND id != ?", task.id)?.total ?? 0;
        if (pending > 0) continue;
        set(task.id, {
          status: 'blocked',
          reserved_credits: 0,
          blocker: `Needs ${need} credits and only ${Math.max(0, availableCredits(task.id))} are free.`,
          blocker_code: 'credits',
        });
        blocked.push(getTask(task.id)!);
        continue;
      }
      set(task.id, { reserved_credits: need });
    }

    set(task.id, {
      status: 'running',
      attempt: task.attempt + 1,
      lease_owner: owner,
      lease_expires_at: iso(clock() + leaseMs),
      started_at: task.started_at ?? iso(),
      blocker: null,
      blocker_code: null,
      error: null,
    });
    return { task: getTask(task.id)!, blocked };
  }
  return { task: null, blocked };
}

/** Extend a lease the worker still holds. False means the lease was lost and the work should be abandoned. */
export function heartbeat(id: string, owner: string, leaseMs: number): boolean {
  const task = getTask(id);
  if (!task || task.status !== 'running' || task.lease_owner !== owner) return false;
  set(id, { lease_expires_at: iso(clock() + leaseMs) });
  return true;
}

export interface Outcome {
  status: 'done' | 'blocked' | 'review';
  /** One line a person can read: what happened. */
  result: string;
  blocker?: string;
  blocker_code?: BlockerCode;
  receipts?: string[];
  messages?: string[];
  inputs?: string[];
  /** Facts for the orchestrator to plan with. Never shown, never persisted. */
  data?: Record<string, unknown>;
}

/**
 * Settle a task. Only the worker holding the current lease can do this, so a worker whose
 * lease expired and was handed to someone else cannot overwrite the newer result.
 */
export function complete(id: string, owner: string, outcome: Outcome): TaskRun | null {
  const task = getTask(id);
  if (!task || task.status !== 'running' || task.lease_owner !== owner) return null;
  set(id, {
    status: outcome.status,
    result: outcome.result,
    blocker: outcome.status === 'blocked' ? (outcome.blocker ?? outcome.result) : null,
    blocker_code: outcome.status === 'blocked' ? (outcome.blocker_code ?? null) : null,
    output_receipt_ids: [...new Set(outcome.receipts ?? [])],
    output_message_ids: [...new Set(outcome.messages ?? [])],
    ...(outcome.inputs ? { input_receipt_ids: [...new Set(outcome.inputs)] } : {}),
    reserved_credits: 0,
    lease_owner: null,
    lease_expires_at: null,
    finished_at: outcome.status === 'done' ? iso() : null,
  });
  return getTask(id);
}

/** A worker threw. Retry while attempts remain, otherwise the task fails for good. */
export function fail(id: string, owner: string, error: string): TaskRun | null {
  const task = getTask(id);
  if (!task || task.status !== 'running' || task.lease_owner !== owner) return null;
  const retry = task.attempt < task.max_attempts;
  set(id, {
    status: retry ? 'queued' : 'failed',
    error: error.slice(0, 500),
    lease_owner: null,
    lease_expires_at: null,
    reserved_credits: retry ? task.reserved_credits : 0,
    finished_at: retry ? null : iso(),
  });
  const after = getTask(id)!;
  log(
    task.agent,
    retry ? 'warn' : 'block',
    retry
      ? `"${task.title}" failed on attempt ${task.attempt} of ${task.max_attempts}: ${error}. Retrying.`
      : `"${task.title}" failed after ${task.attempt} attempts: ${error}.`,
    { lead_id: task.lead_id, task_id: task.id, run_id: task.run_id },
  );
  return after;
}

/** Take back every lease that has run out. The task goes back in the queue, or fails if it is out of attempts. */
export function reapExpired(): TaskRun[] {
  const stale = tasksWhere("status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?", iso());
  for (const task of stale) {
    const retry = task.attempt < task.max_attempts;
    set(task.id, {
      status: retry ? 'queued' : 'failed',
      error: 'The worker stopped responding and its lease expired.',
      lease_owner: null,
      lease_expires_at: null,
      reserved_credits: retry ? task.reserved_credits : 0,
      finished_at: retry ? null : iso(),
    });
    log(
      'system',
      retry ? 'warn' : 'block',
      retry
        ? `The lease on "${task.title}" expired on attempt ${task.attempt}. Taken back and queued again.`
        : `"${task.title}" failed: its lease expired on the last of ${task.max_attempts} attempts.`,
      { lead_id: task.lead_id, task_id: task.id, run_id: task.run_id },
    );
  }
  return stale.map((t) => getTask(t.id)!);
}

/**
 * Put credit-blocked tasks back in the queue as soon as the balance can cover them, highest
 * priority first. Each one takes its hold immediately, so the next cannot count the same credits.
 */
export function requeueAffordable(): TaskRun[] {
  const waiting = tasksWhere("status = 'blocked' AND blocker_code = 'credits'");
  if (waiting.length === 0) return [];
  let free = availableCredits();
  const back: TaskRun[] = [];
  for (const task of waiting) {
    const need = creditNeed(task.kind);
    if (need > free) continue;
    set(task.id, { status: 'queued', reserved_credits: need, blocker: null, blocker_code: null });
    free -= need;
    back.push(getTask(task.id)!);
  }
  return back;
}

// ---------- transitions made by the orchestrator or a person ----------

/** Put blocked tasks back in the queue once their blocker is gone. */
export function unblock(code: BlockerCode): TaskRun[] {
  const tasks = tasksWhere("status = 'blocked' AND blocker_code = ?", code);
  for (const task of tasks) set(task.id, { status: 'queued', blocker: null, blocker_code: null });
  return tasks.map((t) => getTask(t.id)!);
}

/** Close a task that was waiting for a person. Refuses to run from inside a worker. */
export function resolveReview(id: string, result: string, messages: string[] = []): TaskRun {
  if (currentTask()) throw new Error('Only a person or the orchestrator can close a review task.');
  const task = getTask(id);
  if (!task || task.status !== 'review') throw new Error('That task is not waiting for review.');
  set(id, { status: 'done', result, output_message_ids: messages.length ? messages : task.output_message_ids, finished_at: iso() });
  return getTask(id)!;
}

/** A person asks for another go at a task that failed or is blocked. */
export function retryTask(id: string): TaskRun {
  const task = getTask(id);
  if (!task) throw new Error('Unknown task.');
  if (task.kind === 'manual') throw new Error('A manual task has no worker to retry it. Move it yourself.');
  if (task.status !== 'failed' && task.status !== 'blocked') throw new Error('Only a failed or blocked task can be retried.');
  set(id, { status: 'queued', blocker: null, blocker_code: null, error: null, finished_at: null, max_attempts: Math.max(task.max_attempts, task.attempt + 1) });
  log('human', 'info', `Retry requested for "${task.title}".`, { lead_id: task.lead_id, task_id: id, run_id: task.run_id });
  changed();
  return getTask(id)!;
}

// ---------- manual tasks and notes: the operator's own board ----------

/** A task a person writes for an agent. No worker executes it; it carries instructions and is moved by hand. */
export function createManualTask(input: { title: string; detail?: string; agent: string; depends_on?: string[]; lead_id?: string | null }): TaskRun {
  const title = input.title.trim().slice(0, 160);
  if (!title) throw new Error('A task needs a title.');
  if (!ASSIGNEES.includes(input.agent as AgentName)) throw new Error('Choose one of the listed specialist agents.');
  const depends = [...new Set((input.depends_on ?? []).filter(Boolean).slice(0, 12))];
  if (depends.some((id) => !getTask(id))) throw new Error('A dependency does not exist.');
  const runRow = createRun('manual', title);
  const task = enqueue({
    run_id: runRow.id,
    kind: 'manual',
    agent: input.agent as AgentName,
    title,
    detail: input.detail?.trim().slice(0, 1200),
    depends_on: depends,
    lead_id: input.lead_id ?? null,
  });
  log('human', 'handoff', `Assigned "${task.title}" to the ${task.agent}.`, { lead_id: task.lead_id, task_id: task.id, run_id: task.run_id });
  changed();
  return task;
}

const MANUAL_STATUSES: TaskStatus[] = ['queued', 'running', 'blocked', 'review', 'done'];
const LEGACY: Record<string, TaskStatus> = { todo: 'queued', doing: 'running' };

/** Move a manual task by hand. Pipeline tasks are moved only by their workers and the orchestrator. */
export function setManualStatus(id: string, value: string): TaskRun {
  const task = getTask(id);
  if (!task) throw new Error('Unknown task.');
  if (task.kind !== 'manual') throw new Error('This task belongs to the pipeline. Its status follows the work; use retry if it is stuck.');
  const status = LEGACY[value] ?? (value as TaskStatus);
  if (!MANUAL_STATUSES.includes(status)) throw new Error('Unknown task status.');
  if (status === 'running') {
    const pending = task.depends_on.map(getTask).find((d) => d?.status !== 'done');
    if (pending) throw new Error(`Wait for "${pending.title}" before starting this task.`);
  }
  set(id, {
    status,
    blocker: status === 'blocked' ? 'Marked blocked by the operator.' : null,
    blocker_code: status === 'blocked' ? 'operator' : null,
    finished_at: status === 'done' ? iso() : null,
  });
  log(task.agent, status === 'blocked' ? 'block' : status === 'done' ? 'done' : 'info', `"${task.title}" is ${status}.`, {
    lead_id: task.lead_id,
    task_id: id,
    run_id: task.run_id,
  });
  settleRuns();
  changed();
  return getTask(id)!;
}

export function listTaskMessages(limit = 300): AgentTaskMessage[] {
  return all<AgentTaskMessage>('SELECT * FROM agent_task_messages ORDER BY created_at ASC, id ASC LIMIT ?', limit);
}

export function addTaskMessage(id: string, input: { author: string; body: string }): AgentTaskMessage {
  const task = getTask(id);
  if (!task) throw new Error('Unknown task.');
  const body = input.body.trim().slice(0, 1600);
  if (!body) throw new Error('Write a message before sending it.');
  const author = input.author.trim().slice(0, 80) || 'Human';
  run('INSERT INTO agent_task_messages (task_id, author, body, created_at) VALUES (?, ?, ?, ?)', id, author, body, iso());
  const message = all<AgentTaskMessage>('SELECT * FROM agent_task_messages WHERE task_id = ? ORDER BY id DESC LIMIT 1', id)[0];
  log('human', 'info', `${author} left a note for the ${task.agent} on "${task.title}".`, { lead_id: task.lead_id, task_id: id, run_id: task.run_id });
  changed();
  return message;
}

/**
 * Operator notes for an agent, for the next model-backed run. They are bounded and treated as
 * untrusted intent: the prompts that include them say to follow them only within the evidence rules.
 */
export function taskBrief(agent: AgentName): string {
  const open = new Set(tasksWhere("agent = ? AND status NOT IN ('done', 'failed')", agent).map((t) => t.id));
  if (open.size === 0) return '';
  const notes = listTaskMessages()
    .filter((m) => open.has(m.task_id))
    .slice(-6);
  return notes.map((m) => `- ${m.author}: ${m.body}`).join('\n');
}
