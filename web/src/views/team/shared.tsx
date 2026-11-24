import { Fragment, type ReactNode } from 'react';
import type { AgentName, ReceiptView, RoomSpeaker, Snapshot, TaskKind, TaskRun } from '../../../../shared/types';
import { Chip } from '../../components';

// What the Agent team screen shares between its tabs: who the agents are, how to name a task in
// a few words, and how to turn the ids in a message into things a person can click.

export type Seat = Exclude<AgentName, 'ledger' | 'system' | 'world'>;

/** The crew in the order work moves through it. */
export const SEATS: { id: Seat; label: string; mark: string; does: string }[] = [
  { id: 'planner', label: 'Planner', mark: 'PL', does: 'Turns your goal into an ideal customer and a search plan' },
  { id: 'researcher', label: 'Researcher', mark: 'RE', does: 'Reads each account and writes a receipt for every fact' },
  { id: 'enricher', label: 'Enricher', mark: 'EN', does: 'Finds the right person and says how sure it is' },
  { id: 'writer', label: 'Writer', mark: 'WR', does: 'Drafts outreach where every fact cites a receipt' },
  { id: 'skeptic', label: 'Skeptic', mark: 'SK', does: 'Re-opens every source and strikes what no longer holds' },
  { id: 'security', label: 'Security', mark: 'SE', does: 'Scans the draft for bad links, leaks and a wrong recipient' },
  { id: 'human', label: 'You', mark: 'YOU', does: 'Approve, edit or reject. Nothing sends without this' },
  { id: 'analyst', label: 'Analyst', mark: 'AN', does: 'Learns from replies and proposes the next ICP' },
];

const NAMES: Record<string, string> = { ...Object.fromEntries(SEATS.map((s) => [s.id, s.label])), orchestrator: 'Orchestrator', ledger: 'Ledger', system: 'System', world: 'World' };
const MARKS: Record<string, string> = { ...Object.fromEntries(SEATS.map((s) => [s.id, s.mark])), orchestrator: 'OR' };

export const nameOf = (who: RoomSpeaker | string, person?: string | null): string => (who === 'human' && person ? person : (NAMES[who] ?? who));

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || 'YOU';
}

/** A round badge for an agent, or the person's initials when a person spoke. */
export function Avatar({ who, person, size = 'md' }: { who: RoomSpeaker | string; person?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`tm-avatar tm-avatar-${size} agent-${who}`} aria-hidden="true">
      {who === 'human' && person ? initials(person) : (MARKS[who] ?? who.slice(0, 2).toUpperCase())}
    </span>
  );
}

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

/** Every receipt in the snapshot by id, so the ids in a task or a message can be shown as chips. */
export function receiptIndex(snap: Snapshot): Map<string, ReceiptView> {
  const index = new Map<string, ReceiptView>();
  for (const lead of snap.leads) for (const r of lead.receipts) index.set(r.id, r);
  for (const rival of snap.competitors) for (const r of rival.receipts) index.set(r.id, r);
  return index;
}

/** A task in a few words. The full title is shown when the task is opened. */
export function shortTitle(task: TaskRun): string {
  if (task.kind === 'plan') return 'Plan the search';
  if (task.kind === 'search') return 'Search for accounts';
  if (task.kind === 'read') return `Read ${task.input.name ?? 'an account'}`;
  if (task.kind === 'recheck') return 'Re-check a reason not to contact';
  if (task.kind === 'enrich') return 'Find the contact';
  if (task.kind === 'write') return 'Draft outreach';
  const what = task.input.channel === 'linkedin' ? 'LinkedIn note' : (task.input.channel ?? 'draft');
  if (task.kind === 'verify') return `Verify the ${what}`;
  if (task.kind === 'scan') return `Scan the ${what}`;
  if (task.kind === 'approve') return `Decide on the ${what}`;
  if (task.kind === 'learn') return 'Learn from the reply';
  return task.title;
}

export function took(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return ms < 1000 ? `${Math.max(1, ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const IDS = /\b(r_[0-9a-f]{6,8}|m_[0-9a-f]{4,12})\b/g;

/**
 * Message text with its ids made useful: a receipt id becomes the receipt chip, with the quoted
 * source behind it, and a draft id becomes a link to the draft.
 */
export function Rich({ text, index, now, onDraft }: { text: string; index: Map<string, ReceiptView>; now: string; onDraft?: (id: string) => void }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(IDS)) {
    const id = match[1];
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const receipt = id.startsWith('r_') ? index.get(id) : undefined;
    if (receipt) parts.push(<Chip key={`${id}-${at}`} r={receipt} now={now} />);
    else if (id.startsWith('m_') && onDraft)
      parts.push(
        <button key={`${id}-${at}`} type="button" className="tm-id" onClick={() => onDraft(id)} title="Open this draft">
          {id}
        </button>,
      );
    else parts.push(<code key={`${id}-${at}`} className="tm-id plain">{id}</code>);
    last = at + id.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  );
}

export type SeatTone = 'working' | 'you' | 'stopped' | 'queued' | 'done' | 'idle';

/** One plain sentence on what an agent is doing right now. */
export function seatStatus(tasks: TaskRun[], seat: Seat, leadName: (id: string | null) => string | null): { tone: SeatTone; line: string } {
  const mine = tasks.filter((t) => t.agent === seat);
  const n = (status: TaskRun['status']) => mine.filter((t) => t.status === status);
  const many = (count: number, one: string, more: string) => `${count} ${count === 1 ? one : more}`;
  const running = n('running');
  if (running.length) {
    const first = running[0];
    const about = leadName(first.lead_id);
    return { tone: 'working', line: `${shortTitle(first)}${about ? ` at ${about}` : ''}${running.length > 1 ? `, and ${running.length - 1} more` : ''}` };
  }
  const review = n('review');
  if (review.length) return { tone: 'you', line: seat === 'human' ? `${many(review.length, 'draft is', 'drafts are')} waiting for your decision` : `${many(review.length, 'task', 'tasks')} in review` };
  const stopped = n('blocked').length + n('failed').length;
  const queued = n('queued');
  if (queued.length) return { tone: 'queued', line: `${many(queued.length, 'task', 'tasks')} up next` };
  const done = n('done').length;
  if (stopped) return { tone: 'stopped', line: `${many(stopped, 'task', 'tasks')} stopped${done ? `, ${done} done` : ''}` };
  if (done) return { tone: 'done', line: `${many(done, 'task', 'tasks')} done` };
  return { tone: 'idle', line: seat === 'human' ? 'Nothing needs you yet' : 'No work yet' };
}
