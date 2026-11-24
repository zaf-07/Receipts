import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { initDb } from '../server/db';
import { taskScope } from '../server/services/context';
import { DeliveryRefused, deliver } from '../server/services/delivery';
import { updateMessage } from '../server/services/store';
import { createRun, enqueue, setTaskClock } from '../server/services/tasks';

// Only the human-gated send can trigger delivery. These tests attack that from the inside:
// they call the delivery function the way a misbehaving agent or a careless change would.

let runId = '';
beforeEach(() => {
  initDb(':memory:');
  setTaskClock(null);
  runId = createRun('discovery', 'test run').id;
});

const gateFor = (messageId: string) =>
  enqueue({ run_id: runId, kind: 'approve', agent: 'human', status: 'review', title: 'Approve the email', input: { message_id: messageId } });

test('delivery is refused without an open human approval for that exact draft', () => {
  assert.throws(() => deliver('m_1', 'task_that_does_not_exist', 'Dana'), DeliveryRefused);

  const agentTask = enqueue({ run_id: runId, kind: 'verify', agent: 'skeptic', title: 'Verify', input: { message_id: 'm_1' } });
  assert.throws(() => deliver('m_1', agentTask.id, 'Dana'), /no open human approval/, 'an agent task is not an approval');

  const otherDraft = gateFor('m_2');
  assert.throws(() => deliver('m_1', otherDraft.id, 'Dana'), /no open human approval/, 'an approval for another draft does not count');

  const spoofed = enqueue({ run_id: runId, kind: 'approve', agent: 'writer', status: 'review', title: 'Self-approve', input: { message_id: 'm_1' } });
  assert.throws(() => deliver('m_1', spoofed.id, 'Dana'), /no open human approval/, 'an approval task assigned to an agent does not count');

  assert.throws(() => deliver('m_1', gateFor('m_1').id, '   '), /needs the name of the person/);
});

test('delivery is refused from inside any agent task, even with a real approval open', () => {
  const gate = gateFor('m_1');
  for (const agent of ['writer', 'skeptic', 'analyst'] as const) {
    assert.throws(
      () => taskScope.run({ task_id: 'task_x', run_id: runId, agent }, () => deliver('m_1', gate.id, 'Dana')),
      /an agent task cannot send/,
      `the ${agent} cannot send`,
    );
  }
});

test('a message cannot be marked sent by an ordinary update', () => {
  assert.throws(() => updateMessage('m_1', { status: 'sent' }), /only by the delivery service/);
  assert.throws(() => updateMessage('m_1', { sent_at: new Date().toISOString() }), /only by the delivery service/);
});

test('in the source, exactly one module can mark a message sent, and only the human gate calls it', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  const source = files('server').map((path) => ({ path: path.replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }));
  const using = (pattern: RegExp) =>
    source
      .filter((f) => pattern.test(f.text))
      .map((f) => f.path)
      .sort();

  assert.deepEqual(using(/status = 'sent'/), ['server/services/store.ts'], 'one SQL statement writes the sent status');
  assert.deepEqual(using(/\bmarkSent\b/), ['server/services/delivery.ts', 'server/services/store.ts'], 'only the delivery service uses it');
  assert.deepEqual(using(/\bdeliver\(/), ['server/agents/orchestrator.ts', 'server/services/delivery.ts'], 'only the orchestrator asks for delivery');

  const orchestrator = source.find((f) => f.path.endsWith('agents/orchestrator.ts'))!.text;
  assert.equal(orchestrator.match(/\bdeliver\(/g)!.length, 1, 'and it does so in one place');
  const approve = orchestrator.slice(orchestrator.indexOf('export function approve('), orchestrator.indexOf('export function reject('));
  assert.match(approve, /\bdeliver\(/, 'which is the approve command a person triggers');

  for (const agent of ['planner', 'researcher', 'enricher', 'writer', 'skeptic', 'analyst', 'pool', 'extractor']) {
    const text = source.find((f) => f.path.endsWith(`agents/${agent}.ts`))!.text;
    assert.doesNotMatch(text, /delivery|markSent|moveStage/, `${agent}.ts has no way to send or to move a deal`);
  }
});
