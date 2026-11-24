import type { ActivityEntry, AgentName } from '../../shared/types';
import { all, run } from '../db';
import { nowIso } from '../clock';
import { forwardHandoff } from '../integrations/band';
import { currentTask } from './context';
import { redactSensitive } from './security';

type Listener = (event: { type: 'activity'; entry: ActivityEntry } | { type: 'changed' }) => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tell connected clients that the store changed and they should refetch. */
export function changed(): void {
  for (const l of listeners) l({ type: 'changed' });
}

/**
 * Append one event to the activity stream. This is the durable handoff log: collection only.
 * A line written from inside a task is linked to that task automatically, so the feed can show
 * the task's inputs, outcome and blocker next to it without the agent having to repeat them.
 */
export function log(
  agent: AgentName,
  kind: ActivityEntry['kind'],
  message: string,
  extra: { lead_id?: string | null; ref?: string | null; task_id?: string | null; run_id?: string | null } = {},
): void {
  const at = nowIso();
  const scope = currentTask();
  run(
    'INSERT INTO activity (at, agent, kind, message, lead_id, ref, task_id, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    at,
    agent,
    kind,
    redactSensitive(message),
    extra.lead_id ?? null,
    extra.ref ?? null,
    extra.task_id ?? scope?.task_id ?? null,
    extra.run_id ?? scope?.run_id ?? null,
  );
  const entry = all<ActivityEntry>('SELECT * FROM activity ORDER BY id DESC LIMIT 1')[0];
  for (const l of listeners) l({ type: 'activity', entry });
  if (kind === 'handoff' || kind === 'block') forwardHandoff(entry);
}

export function recentActivity(limit = 300): ActivityEntry[] {
  return all<ActivityEntry>('SELECT * FROM activity ORDER BY id DESC LIMIT ?', limit);
}
