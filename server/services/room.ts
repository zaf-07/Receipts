import type { RoomCard, RoomCardStep, RoomMessage } from '../../shared/types';
import { nowIso } from '../clock';
import { all, get, parse, run } from '../db';

// The team's room, kept locally.
//
// Every handoff between agents, every request put to a person, every decision and every card on
// the board is written here first. Band, when it is connected, is sent the same thing. So the
// Agent team screen shows the conversation and the board whether or not a Band room exists, and
// what it shows is what the room was told, not a second account of it.

type MessageRow = Omit<RoomMessage, 'in_band'> & { in_band: number };
type CardRow = Omit<RoomCard, 'steps'> & { steps: string };

export interface NewRoomMessage {
  from: RoomMessage['from'];
  to: RoomMessage['to'];
  kind: RoomMessage['kind'];
  text: string;
  /** The person's name, when a person wrote it. */
  author?: string | null;
  lead_id?: string | null;
  draft_id?: string | null;
  in_band?: boolean;
}

export function recordMessage(m: NewRoomMessage): number {
  const row = get<{ id: number }>(
    'INSERT INTO room_messages (at, sender, author, recipient, kind, body, lead_id, draft_id, in_band) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    nowIso(),
    m.from,
    m.author ?? null,
    m.to,
    m.kind,
    m.text,
    m.lead_id ?? null,
    m.draft_id ?? null,
    m.in_band ? 1 : 0,
  );
  return row?.id ?? 0;
}

/** Band accepted the message, so the screen can say it is in the room. */
export function markInBand(id: number): void {
  run('UPDATE room_messages SET in_band = 1 WHERE id = ?', id);
}

export function listRoomMessages(limit = 500): RoomMessage[] {
  return all<MessageRow & { sender: RoomMessage['from']; recipient: RoomMessage['to']; body: string }>(
    'SELECT * FROM (SELECT * FROM room_messages ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
    limit,
  ).map((r) => ({
    id: r.id,
    at: r.at,
    from: r.sender,
    author: r.author,
    to: r.recipient,
    kind: r.kind,
    text: r.body,
    lead_id: r.lead_id,
    draft_id: r.draft_id,
    in_band: Boolean(r.in_band),
  }));
}

/**
 * Move a card on the board. The card is created the first time it is mentioned, and every step
 * is appended: the card keeps its history, the way the task runs keep theirs.
 */
export function recordCard(subject: string, detail: string, leadId: string | null, steps: Omit<RoomCardStep, 'at'>[]): void {
  const at = nowIso();
  const row = get<CardRow>('SELECT * FROM room_cards WHERE subject = ?', subject);
  const history = [...parse<RoomCardStep[]>(row?.steps ?? '[]', []), ...steps.map((s) => ({ ...s, at }))];
  if (row) run('UPDATE room_cards SET steps = ?, updated_at = ?, lead_id = COALESCE(?, lead_id) WHERE subject = ?', JSON.stringify(history), at, leadId, subject);
  else run('INSERT INTO room_cards (subject, lead_id, detail, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', subject, leadId, detail, JSON.stringify(history), at, at);
}

export function listRoomCards(): RoomCard[] {
  return all<CardRow>('SELECT * FROM room_cards ORDER BY created_at ASC').map((r) => ({ ...r, steps: parse<RoomCardStep[]>(r.steps, []) }));
}
