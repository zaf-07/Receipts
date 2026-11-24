import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { TaskKind, TaskRun } from '../shared/types';
import { all, initDb } from '../server/db';
import { createPool } from '../server/agents/pool';
import { credit } from '../server/services/ledger';
import {
  addTaskMessage,
  claim,
  complete,
  createManualTask,
  createRun,
  enqueue,
  getTask,
  heartbeat,
  listTaskMessages,
  listTasks,
  reapExpired,
  requeueAffordable,
  resolveReview,
  setManualStatus,
  setTaskClock,
  taskBrief,
} from '../server/services/tasks';

// The scheduler on its own: dependencies, parallelism, retries, leases, idempotency, credit holds.
// No agents are involved. Handlers here are stand-ins, which is the point: the task model has to
// be correct whatever the work is.

const KINDS: TaskKind[] = ['read', 'verify', 'enrich', 'write'];
let runId = '';
let fakeNow = 0;

beforeEach(() => {
  initDb(':memory:');
  fakeNow = Date.parse('2026-11-24T12:00:00Z');
  setTaskClock(() => fakeNow);
  runId = createRun('discovery', 'test run').id;
});

const add = (title: string, extra: Partial<Parameters<typeof enqueue>[0]> = {}) =>
  enqueue({ run_id: runId, kind: 'read', agent: 'researcher', title, ...extra });
const done = (result = 'ok') => ({ status: 'done' as const, result });

// ---------- dependencies and idempotency ----------

test('a task is leased only after everything it depends on is done', () => {
  const first = add('first');
  const second = add('second', { depends_on: [first.id] });

  const a = claim('w1', 1000, KINDS).task!;
  assert.equal(a.id, first.id);
  assert.equal(a.status, 'running');
  assert.equal(claim('w2', 1000, KINDS).task, null, 'the dependant is not ready while its dependency runs');

  complete(first.id, 'w1', done());
  assert.equal(claim('w2', 1000, KINDS).task?.id, second.id);
});

test('creating a task with the same key twice returns the same task', () => {
  const a = add('read acme', { key: 'read:run:acme' });
  const b = add('read acme again', { key: 'read:run:acme' });
  assert.equal(a.id, b.id);
  assert.equal(listTasks().length, 1);

  complete(claim('w1', 1000, KINDS).task!.id, 'w1', done());
  assert.equal(add('and again', { key: 'read:run:acme' }).status, 'done', 'a finished task is not created again');
  assert.equal(claim('w1', 1000, KINDS).task, null, 'and it is not run again');
});

// ---------- parallelism ----------

test('the pool runs tasks in parallel, never above its limit, and each exactly once', async () => {
  const runs = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;
  const pool = createPool({
    concurrency: 3,
    leaseMs: 5000,
    handlers: {
      read: async (task) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        runs.set(task.id, (runs.get(task.id) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        return done();
      },
    },
  });
  setTaskClock(null);
  const tasks = Array.from({ length: 12 }, (_, i) => add(`account ${i}`));
  await pool.idle();

  assert.equal(peak, 3, 'three workers were busy at once');
  assert.deepEqual([...runs.values()], Array(12).fill(1), 'no task ran twice');
  for (const t of tasks) assert.equal(getTask(t.id)!.status, 'done');
  const [{ status }] = all<{ status: string }>('SELECT status FROM runs WHERE id = ?', runId);
  assert.equal(status, 'done', 'the run settles when its tasks do');
});

test('higher priority tasks are leased first', () => {
  add('low', { priority: 10 });
  add('high', { priority: 90 });
  add('mid', { priority: 50 });
  const order = [1, 2, 3].map(() => claim('w', 1000, KINDS).task!.title);
  assert.deepEqual(order, ['high', 'mid', 'low']);
});

// ---------- retries ----------

test('a failing task is retried, attempts are counted, and it settles once it succeeds', async () => {
  let calls = 0;
  const settled: string[] = [];
  const pool = createPool({
    concurrency: 2,
    leaseMs: 5000,
    handlers: {
      read: async () => {
        if (++calls < 3) throw new Error('page timed out');
        return done('third time lucky');
      },
    },
    onSettled: (task) => settled.push(task.status),
  });
  setTaskClock(null);
  const task = add('flaky', { max_attempts: 3 });
  await pool.idle();

  const after = getTask(task.id)!;
  assert.equal(after.status, 'done');
  assert.equal(after.attempt, 3);
  assert.equal(after.result, 'third time lucky');
  assert.deepEqual(settled, ['done'], 'the orchestrator hears about the task once, when it settles');
});

test('a task that fails every attempt ends failed, and what depends on it is blocked with the reason', async () => {
  const pool = createPool({
    concurrency: 2,
    leaseMs: 5000,
    handlers: {
      read: async () => {
        throw new Error('site is down');
      },
      verify: async () => done(),
    },
  });
  setTaskClock(null);
  const broken = add('broken', { max_attempts: 2 });
  const downstream = add('downstream', { kind: 'verify', agent: 'skeptic', depends_on: [broken.id] });
  await pool.idle();

  assert.equal(getTask(broken.id)!.status, 'failed');
  assert.equal(getTask(broken.id)!.attempt, 2);
  assert.match(getTask(broken.id)!.error!, /site is down/);
  const blocked = getTask(downstream.id)!;
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocker_code, 'dependency');
  assert.match(blocked.blocker!, /broken/);
});

// ---------- leases ----------

test('an expired lease is taken back, and the stale worker cannot settle the task', () => {
  const task = add('slow');
  assert.equal(claim('w1', 1000, KINDS).task!.attempt, 1);

  fakeNow += 2000;
  assert.deepEqual(reapExpired().map((t) => [t.id, t.status]), [[task.id, 'queued']]);

  const again = claim('w2', 1000, KINDS).task!;
  assert.equal(again.id, task.id);
  assert.equal(again.attempt, 2);
  assert.equal(again.lease_owner, 'w2');

  assert.equal(heartbeat(task.id, 'w1', 1000), false, 'the first worker has lost its lease');
  assert.equal(complete(task.id, 'w1', done('stale result')), null, 'and its late result is dropped');
  assert.equal(getTask(task.id)!.status, 'running');

  assert.equal(complete(task.id, 'w2', done('fresh result'))!.result, 'fresh result');
});

test('a heartbeat keeps the lease of a task that is still being worked on', () => {
  const task = add('long');
  claim('w1', 1000, KINDS);
  fakeNow += 800;
  assert.equal(heartbeat(task.id, 'w1', 1000), true);
  fakeNow += 800;
  assert.deepEqual(reapExpired(), [], 'the lease was extended, so nothing is taken back');
  assert.equal(getTask(task.id)!.status, 'running');
});

test('a lease that expires on the last attempt fails the task', () => {
  const task = add('doomed', { max_attempts: 1 });
  claim('w1', 1000, KINDS);
  fakeNow += 2000;
  reapExpired();
  assert.equal(getTask(task.id)!.status, 'failed');
  assert.match(getTask(task.id)!.error!, /lease expired/);
});

// ---------- credits ----------

test('credits are held in priority order, and a blocked task comes back when it can be afforded', () => {
  credit(10, 'grant', 'test');
  const lead = (name: string, priority: number) => add(name, { kind: 'enrich', agent: 'enricher', priority });
  const top = lead('top', 90);
  const mid = lead('mid', 50);
  const low = lead('low', 10);

  const first = claim('w1', 1000, KINDS);
  assert.equal(first.task!.id, top.id);
  assert.equal(first.task!.reserved_credits, 7, 'enrichment holds its own cost and the draft that follows');

  // While the first task is running it might still hand its hold back, so nothing is decided yet.
  const early = claim('w2', 1000, KINDS);
  assert.equal(early.task, null);
  assert.deepEqual(early.blocked, []);
  assert.equal(getTask(mid.id)!.status, 'queued');

  // The first task spends what it held. Now the shortfall is certain.
  credit(-7, 'enrich', 'spent by the first task');
  complete(top.id, 'w1', done());
  const second = claim('w2', 1000, KINDS);
  assert.equal(second.task, null);
  assert.deepEqual(second.blocked.map((t) => t.title), ['mid', 'low'], 'three credits are free, so both wait');
  assert.equal(getTask(mid.id)!.blocker_code, 'credits');

  credit(7, 'topup', 'test');
  assert.deepEqual(requeueAffordable().map((t) => t.title), ['mid'], 'the higher priority one gets the new credits');
  assert.equal(getTask(mid.id)!.reserved_credits, 7);
  assert.equal(getTask(low.id)!.status, 'blocked');
});

// ---------- who may do what ----------

test('a worker cannot create tasks or close a review: only the orchestrator and people can', async () => {
  const gate = add('approve the email', { kind: 'approve', agent: 'human', status: 'review' });
  const errors: string[] = [];
  const attempt = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      errors.push((err as Error).message);
    }
  };
  const pool = createPool({
    concurrency: 1,
    leaseMs: 5000,
    handlers: {
      read: async () => {
        attempt(() => add('a task the worker made up'));
        attempt(() => resolveReview(gate.id, 'approved by the worker'));
        return done();
      },
    },
  });
  setTaskClock(null);
  add('ordinary work');
  await pool.idle();

  assert.match(errors[0], /worker cannot create tasks/);
  assert.match(errors[1], /Only a person or the orchestrator/);
  assert.equal(listTasks().length, 2, 'nothing extra was created');
  assert.equal(getTask(gate.id)!.status, 'review', 'the gate is still closed');
  assert.equal(claim('w', 1000, ['approve']).task, null, 'a review task is never leased to a worker');
});

// ---------- the operator's own board ----------

test('manual tasks respect dependencies, and notes on a task reach its agent', () => {
  const first = createManualTask({ title: 'Prioritise pricing signals', agent: 'researcher' });
  const second = createManualTask({ title: 'Tighten the opening line', agent: 'writer', depends_on: [first.id] });
  assert.throws(() => setManualStatus(second.id, 'running'), /Wait for/);
  assert.throws(() => createManualTask({ title: 'x', agent: 'nobody' }), /listed specialist agents/);

  addTaskMessage(first.id, { author: 'QA', body: 'Prioritize fresh pricing signals.' });
  assert.equal(taskBrief('researcher'), '- QA: Prioritize fresh pricing signals.');
  assert.equal(taskBrief('writer'), '');

  setManualStatus(first.id, 'doing');
  assert.equal(getTask(first.id)!.status, 'running', 'the older status names still work');
  setManualStatus(first.id, 'done');
  assert.equal(setManualStatus(second.id, 'running').status, 'running');
  assert.equal(taskBrief('researcher'), '', 'notes on a finished task are no longer sent');
  assert.deepEqual(listTaskMessages().map((m) => [m.task_id, m.author]), [[first.id, 'QA']]);

  const pipeline = add('pipeline work');
  assert.throws(() => setManualStatus(pipeline.id, 'done'), /belongs to the pipeline/);
  assert.equal(claim('w', 1000, KINDS).task!.id, pipeline.id, 'manual tasks are never leased to a worker');
  assert.equal((getTask(pipeline.id) as TaskRun).attempt, 1);
});
