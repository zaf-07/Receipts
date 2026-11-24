import type { ActivityEntry, AgentName } from '../../shared/types';
import { all, run } from '../db';
import { nowIso } from '../clock';
import { forwardHandoff } from '../integrations/band';

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

/** Append one line to the agent activity feed. This is also the audit trail of who did what. */
export function log(
  agent: AgentName,
  kind: ActivityEntry['kind'],
  message: string,
  extra: { lead_id?: string | null; ref?: string | null } = {},
): void {
  const at = nowIso();
  run(
    'INSERT INTO activity (at, agent, kind, message, lead_id, ref) VALUES (?, ?, ?, ?, ?, ?)',
    at,
    agent,
    kind,
    message,
    extra.lead_id ?? null,
    extra.ref ?? null,
  );
  const entry = all<ActivityEntry>('SELECT * FROM activity ORDER BY id DESC LIMIT 1')[0];
  for (const l of listeners) l({ type: 'activity', entry });
  if (kind === 'handoff' || kind === 'block') forwardHandoff(entry);
}

export function recentActivity(limit = 200): ActivityEntry[] {
  return all<ActivityEntry>('SELECT * FROM activity ORDER BY id DESC LIMIT ?', limit);
}
