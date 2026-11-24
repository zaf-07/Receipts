import { randomBytes } from 'node:crypto';
import type { TaskKind, TaskRun } from '../../shared/types';
import { taskScope } from '../services/context';
import { claim, complete, fail, getTask, heartbeat, reapExpired, requeueAffordable, settleRuns, type Outcome } from '../services/tasks';
import { changed } from '../services/activity';

// The worker pool. It leases ready tasks, runs each in its own scope, and reports back.
// It knows nothing about go-to-market: what a task does is the handler's business, and what
// happens next is the orchestrator's. That split is what keeps workers from managing the team.

export type Handler = (task: TaskRun) => Promise<Outcome>;

export interface PoolOptions {
  handlers: Partial<Record<TaskKind, Handler>>;
  concurrency: number;
  leaseMs: number;
  /** Called by the pool, outside any worker scope, after a task settles. `outcome` is null when it failed for good. */
  onSettled?: (task: TaskRun, outcome: Outcome | null) => void;
  /** Called once per scheduling pass with the tasks that could not start for lack of credits. */
  onBlocked?: (tasks: TaskRun[]) => void;
}

export interface Pool {
  /** Start as many ready tasks as there are free workers. Safe to call at any time. */
  kick: () => void;
  /** Resolves when nothing is running and nothing is ready to run. */
  idle: () => Promise<void>;
  busy: () => boolean;
  active: () => number;
}

export function createPool(opts: PoolOptions): Pool {
  const kinds = Object.keys(opts.handlers) as TaskKind[];
  let active = 0;
  let waiters: (() => void)[] = [];
  let kicking = false;

  function settleIdle(): void {
    if (active > 0) return;
    settleRuns();
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  }

  async function execute(task: TaskRun, owner: string): Promise<void> {
    const beat = setInterval(() => heartbeat(task.id, owner, opts.leaseMs), Math.max(50, Math.floor(opts.leaseMs / 3)));
    let outcome: Outcome | null = null;
    let settled: TaskRun | null = null;
    try {
      outcome = await taskScope.run({ task_id: task.id, run_id: task.run_id, agent: task.agent }, () => opts.handlers[task.kind]!(task));
      // A worker whose lease was taken back gets null here, and its result is dropped.
      settled = complete(task.id, owner, outcome);
    } catch (err) {
      outcome = null;
      settled = fail(task.id, owner, err instanceof Error ? err.message : String(err));
    } finally {
      clearInterval(beat);
      active--;
    }
    // Planning happens here, in the orchestrator's hands, never inside the worker's scope.
    if (settled && settled.status !== 'queued') {
      try {
        opts.onSettled?.(settled, settled.status === 'failed' ? null : outcome);
      } catch (err) {
        console.error('[orchestrator] planning after a task failed:', err);
      }
    }
    changed();
    kick();
  }

  function kick(): void {
    if (kicking) return;
    kicking = true;
    try {
      reapExpired();
      requeueAffordable();
      const blocked: TaskRun[] = [];
      while (active < opts.concurrency) {
        const owner = `w_${randomBytes(4).toString('hex')}`;
        const next = claim(owner, opts.leaseMs, kinds);
        blocked.push(...next.blocked);
        if (!next.task) break;
        active++;
        void execute(next.task, owner);
      }
      if (blocked.length) opts.onBlocked?.(blocked.map((t) => getTask(t.id)!));
    } finally {
      kicking = false;
    }
    settleIdle();
  }

  return {
    kick,
    idle: () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
        kick();
      }),
    busy: () => active > 0,
    active: () => active,
  };
}
