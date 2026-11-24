import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initDb } from '../server/db';
import { addTaskMessage, ensurePipelineTasks, listTaskMessages, listTasks, setTaskStatus } from '../server/services/tasks';

test('team plan enforces dependencies and preserves task messages', () => {
  initDb(':memory:');
  ensurePipelineTasks();
  ensurePipelineTasks();

  const tasks = listTasks();
  assert.equal(tasks.length, 6, 'starter plan is idempotent');
  const planner = tasks.find((task) => task.agent === 'planner')!;
  const researcher = tasks.find((task) => task.agent === 'researcher')!;
  const enricher = tasks.find((task) => task.agent === 'enricher')!;
  assert.equal(planner.status, 'done');
  assert.throws(() => setTaskStatus(enricher.id, 'doing'), /Wait for/);

  setTaskStatus(researcher.id, 'doing');
  addTaskMessage(researcher.id, { author: 'QA', body: 'Prioritize fresh pricing signals.' });
  setTaskStatus(researcher.id, 'done');
  assert.equal(setTaskStatus(enricher.id, 'doing').status, 'doing');
  assert.deepEqual(
    listTaskMessages().map((message) => [message.task_id, message.author, message.body]),
    [[researcher.id, 'QA', 'Prioritize fresh pricing signals.']],
  );
});
