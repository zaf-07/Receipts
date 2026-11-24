import type { ActivityEntry, AgentName } from '../../shared/types';
import { config } from '../config';

// Band is the room where the Receipts agents hand work to each other and where a person makes
// the call. This module speaks Band's Agent API (docs.band.ai):
//
//   - Each Receipts role can be its own Band remote agent, with its own API key.
//   - A handoff is a message that @mentions the next agent, as Band requires for routing.
//   - A verified, security-cleared draft is put to a named human with an attention event, and
//     that human's reply in the room ("approve m_ab12cd") is what releases the send.
//   - A person can also @mention an agent with an instruction, which is kept as a note for it.
//
// Band is never a dependency: every call is best-effort, and the pipeline runs the same without it.
// A reply is only ever acted on when Band says a User sent it. An agent cannot approve anything.

/**
 * Agent roles and their stop conditions, in the order work is handed off.
 * This is the crew a Band room hosts. The human is a role like the others.
 */
export const AGENT_ROLES = [
  { role: 'planner', job: 'Turns the product description into an ICP and a search plan', stops_when: 'ICP fields carry confidence scores', hands_off_to: 'researcher' },
  { role: 'researcher', job: 'Finds accounts and signals; writes receipts with sources', stops_when: 'Every lead has a live receipt or a dormant reason', hands_off_to: 'enricher' },
  { role: 'enricher', job: 'Resolves the contact, email and deliverability status', stops_when: 'Contact resolved, or marked unverified at low confidence', hands_off_to: 'writer' },
  { role: 'writer', job: 'Drafts outreach; every factual sentence carries receipt ids', stops_when: 'No uncited factual sentence remains', hands_off_to: 'skeptic' },
  { role: 'skeptic', job: 'Re-opens each source and tries to disprove each claim', stops_when: 'Every claim is verified or struck', hands_off_to: 'security' },
  { role: 'security', job: 'Scans a verified draft for unverified links, leaked internal data and a wrong recipient', stops_when: 'The draft is cleared or blocked with the finding named', hands_off_to: 'human' },
  { role: 'human', job: 'Approves, edits or rejects', stops_when: 'Nothing sends without this decision', hands_off_to: 'analyst' },
  { role: 'analyst', job: 'Reads outcomes, reweights signal types, proposes the next ICP version', stops_when: 'A diff is ready for review', hands_off_to: 'planner' },
] as const;

export type Speaker = AgentName | 'orchestrator';

interface Identity {
  role: Speaker;
  key: string;
  id: string;
  handle: string;
  name: string;
}

interface Participant {
  id: string;
  type: 'User' | 'Agent';
  handle: string | null;
  name: string | null;
  role: string;
}

interface InboundMessage {
  id: string;
  content: string;
  sender_id: string;
  sender_type: 'User' | 'Agent';
  sender_name?: string | null;
}

export interface BandDecision {
  action: 'approve' | 'reject';
  messageId: string;
  reviewer: string;
  note: string;
}

const state = {
  ready: false,
  base: '',
  identities: new Map<Speaker, Identity>(),
  human: null as Participant | null,
  lastError: null as string | null,
  sent: 0,
  received: 0,
  /** Open review requests in the room, by draft id, so the decision can resolve them. */
  reviews: new Map<string, string>(),
  handled: new Set<string>(),
};

let onDecision: (d: BandDecision) => string = () => 'No one is listening for decisions.';
let onNote: (role: AgentName, text: string, author: string) => string = () => 'Noted.';
let queue: Promise<unknown> = Promise.resolve();

export function bandEnabled(): boolean {
  return Boolean(config.band.apiKey && config.band.chatId);
}

export function onBandDecision(handler: (d: BandDecision) => string): void {
  onDecision = handler;
}

export function onBandNote(handler: (role: AgentName, text: string, author: string) => string): void {
  onNote = handler;
}

export function bandStatus() {
  return {
    configured: bandEnabled(),
    connected: state.ready,
    base: state.base || null,
    agents: [...state.identities.values()].map((i) => ({ role: i.role, handle: i.handle, name: i.name })),
    human: state.human ? (state.human.handle ?? state.human.name) : null,
    messages_sent: state.sent,
    messages_received: state.received,
    last_error: state.lastError,
  };
}

/** Resolves once every queued Band call has been made. */
export function bandIdle(): Promise<void> {
  return queue.then(() => undefined);
}

// ---------- HTTP ----------

interface Reply {
  ok: boolean;
  status: number;
  data: unknown;
}

async function call(base: string, key: string, method: string, path: string, body?: unknown): Promise<Reply> {
  try {
    const res = await fetch(`${base}/agent${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    let json: unknown = null;
    if (res.status !== 204) {
      try {
        json = await res.json();
      } catch {
        // Empty or non-JSON body.
      }
    }
    if (!res.ok) state.lastError = `${method} ${path} returned HTTP ${res.status}`;
    return { ok: res.ok, status: res.status, data: (json as { data?: unknown } | null)?.data ?? json };
  } catch (err) {
    state.lastError = `${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, status: 0, data: null };
  }
}

const chat = () => `/chats/${encodeURIComponent(config.band.chatId)}`;

function later<T>(work: () => Promise<T>): Promise<T | undefined> {
  const next = queue.then(work).catch(() => undefined);
  queue = next;
  return next;
}

// ---------- connecting ----------

/**
 * Join the room: validate every key, make sure each role's agent is a participant, and find
 * the human who will make decisions. The docs name two API hosts, so both are tried.
 */
export async function connectBand(): Promise<string> {
  if (!bandEnabled()) return 'Band is not configured.';
  state.ready = false;
  state.identities.clear();

  const bases = [config.band.baseUrl];
  if (config.band.baseUrl.includes('app.band.ai')) bases.push(config.band.baseUrl.replace('app.band.ai', 'api.band.ai'));
  else if (config.band.baseUrl.includes('api.band.ai')) bases.push(config.band.baseUrl.replace('api.band.ai', 'app.band.ai'));

  let me: Reply | null = null;
  for (const base of bases) {
    me = await call(base, config.band.apiKey, 'GET', '/me');
    if (me.ok) {
      state.base = base;
      break;
    }
  }
  if (!me?.ok) return `Band rejected the orchestrator key (${state.lastError}).`;

  const identity = (role: Speaker, key: string, data: unknown): Identity => {
    const d = data as { id: string; handle?: string; name?: string };
    return { role, key, id: d.id, handle: d.handle ?? d.name ?? role, name: d.name ?? role };
  };
  state.identities.set('orchestrator', identity('orchestrator', config.band.apiKey, me.data));
  for (const [role, key] of Object.entries(config.band.roleKeys)) {
    if (!key) continue;
    const reply = await call(state.base, key, 'GET', '/me');
    if (reply.ok) state.identities.set(role as Speaker, identity(role as Speaker, key, reply.data));
  }

  const listed = await call(state.base, config.band.apiKey, 'GET', `${chat()}/participants`);
  if (!listed.ok) return `Band room ${config.band.chatId} could not be read (${state.lastError}).`;
  const participants = (listed.data as Participant[]) ?? [];

  // The roster is assembled at run time: the orchestrator brings its sibling agents into the room.
  let added = 0;
  for (const who of state.identities.values()) {
    if (participants.some((p) => p.id === who.id)) continue;
    const reply = await call(state.base, config.band.apiKey, 'POST', `${chat()}/participants`, { participant: { participant_id: who.id, role: 'member' } });
    if (reply.ok) added++;
  }

  const users = participants.filter((p) => p.type === 'User');
  state.human = users.find((p) => config.band.humanHandle && p.handle === config.band.humanHandle) ?? users.find((p) => p.role === 'owner') ?? users[0] ?? null;
  state.ready = true;
  state.lastError = null;
  const roles = [...state.identities.keys()].filter((r) => r !== 'orchestrator');
  return (
    `Band room connected at ${new URL(state.base).host}: ${state.identities.size} agent${state.identities.size === 1 ? '' : 's'}` +
    (roles.length ? ` (${roles.join(', ')} speak as themselves)` : '') +
    (added ? `, ${added} added to the room` : '') +
    (state.human ? `. Decisions go to @${state.human.handle ?? state.human.name}.` : '. No human is in the room yet, so decisions stay in Receipts.')
  );
}

// ---------- speaking ----------

const sender = (from: Speaker) => state.identities.get(from) ?? state.identities.get('orchestrator')!;
const tagged = (from: Speaker, who: Identity, text: string) => (who.role === from ? text : `[${from}] ${text}`);

async function postEvent(from: Speaker, type: 'task' | 'error' | 'thought' | 'attention', text: string, metadata?: Record<string, unknown>): Promise<string | null> {
  const who = sender(from);
  const reply = await call(state.base, who.key, 'POST', `${chat()}/events`, {
    event: { content: tagged(from, who, text).slice(0, 16000), message_type: type, ...(metadata ? { metadata } : {}) },
  });
  if (reply.ok) state.sent++;
  return reply.ok ? ((reply.data as { id?: string } | null)?.id ?? null) : null;
}

async function postMessage(from: Speaker, target: { id: string; handle: string | null; name: string | null }, text: string): Promise<boolean> {
  const who = sender(from);
  const handle = target.handle ?? target.name ?? 'there';
  const reply = await call(state.base, who.key, 'POST', `${chat()}/messages`, {
    message: {
      content: `@${handle} ${tagged(from, who, text)}`,
      mentions: [{ id: target.id, ...(target.handle ? { handle: target.handle } : {}), ...(target.name ? { name: target.name } : {}) }],
    },
  });
  if (reply.ok) state.sent++;
  return reply.ok;
}

/**
 * One agent hands work to another, in the room. Band routes a message only to whoever it
 * mentions, so a handoff mentions the next agent. When that role has no agent of its own in the
 * room there is nobody to mention, and the handoff is recorded as an event instead.
 */
export function say(from: Speaker, to: Speaker | 'human', text: string): void {
  if (!state.ready) return;
  void later(async () => {
    const me = sender(from);
    if (to === 'human') {
      if (state.human) await postMessage(from, state.human, text);
      else await postEvent(from, 'task', text);
      return;
    }
    const target = state.identities.get(to);
    if (target && target.id !== me.id) await postMessage(from, target, text);
    else await postEvent(from, 'task', `${text} (for the ${to})`);
  });
}

/** Put a draft to the human: a mention so it reaches them, and an attention event that blocks until resolved. */
export function requestDecision(from: Speaker, draftId: string, text: string): void {
  if (!state.ready) return;
  void later(async () => {
    const me = sender(from);
    const how = `Reply to @${me.handle} with "approve ${draftId}" or "reject ${draftId} <reason>".`;
    if (state.human) await postMessage(from, state.human, `${text} ${how}`);
    const id = await postEvent(from, 'attention', `${text} ${how}`, { kind: 'review', blocking: true, draft_id: draftId });
    if (id) state.reviews.set(draftId, id);
  });
}

/** The decision is made. Resolve the open review in the room and say what happened. */
export function resolveDecision(draftId: string, text: string): void {
  if (!state.ready) return;
  void later(async () => {
    const review = state.reviews.get(draftId);
    if (review) {
      await postEvent('orchestrator', 'task', text, { resolves: review, draft_id: draftId });
      state.reviews.delete(draftId);
    }
    if (state.human) await postMessage('orchestrator', state.human, text);
  });
}

// ---------- listening ----------

const COMMAND = /^(approve|reject)\s+(m_[0-9a-f]{4,12})\b\s*(.*)$/i;

function handle(message: InboundMessage, role: Speaker): string | null {
  // Only a person can decide or instruct. A message from any agent, ours or not, is not acted on.
  if (message.sender_type !== 'User') return null;
  state.received++;
  const author = message.sender_name?.trim() || 'Band user';
  const text = message.content.replace(/@[\w./-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const command = text.match(COMMAND);
  if (command) {
    return onDecision({ action: command[1].toLowerCase() as 'approve' | 'reject', messageId: command[2], reviewer: author, note: command[3].trim().slice(0, 400) });
  }
  if (role === 'orchestrator' || role === 'human') return 'To decide on a draft, reply "approve m_xxxxxx" or "reject m_xxxxxx <reason>". To instruct an agent, mention that agent.';
  return onNote(role as AgentName, text.slice(0, 1600), author);
}

/** Check each of our agents for a message addressed to it. Called on a timer while Band is connected. */
export async function pollBand(): Promise<void> {
  if (!state.ready) return;
  for (const who of [...state.identities.values()]) {
    const next = await call(state.base, who.key, 'GET', `${chat()}/messages/next`);
    if (!next.ok || next.status === 204 || !next.data) continue;
    const message = next.data as InboundMessage;
    if (!message.id || state.handled.has(message.id)) continue;
    state.handled.add(message.id);
    // Band delivers at least once. Marking the message is what stops it coming back.
    await call(state.base, who.key, 'POST', `${chat()}/messages/${message.id}/processing`);
    try {
      const answer = handle(message, who.role);
      if (answer) {
        const known = state.human?.id === message.sender_id ? state.human.handle : null;
        await postMessage(who.role, { id: message.sender_id, handle: known, name: message.sender_name ?? null }, answer);
      }
      await call(state.base, who.key, 'POST', `${chat()}/messages/${message.id}/processed`);
    } catch (err) {
      await call(state.base, who.key, 'POST', `${chat()}/messages/${message.id}/failed`, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ---------- the execution log ----------

/**
 * Mirror a handoff or a block from the activity stream into the room as an execution event,
 * and to the generic webhook when one is set. Events inform the people in the room; they do
 * not route work. The handoffs that route work are the mention messages above.
 */
export function forwardHandoff(entry: ActivityEntry): void {
  if (state.ready) {
    void later(() =>
      postEvent(entry.agent, entry.kind === 'block' ? 'error' : 'thought', entry.message, {
        source: 'receipts',
        activity_id: entry.id,
        lead_id: entry.lead_id,
        task_id: entry.task_id,
        ref: entry.ref,
      }),
    );
  }
  if (config.agentWebhook) {
    void fetch(config.agentWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'receipts',
        type: entry.kind === 'block' ? 'agent.blocked' : 'agent.handoff',
        agent: entry.agent,
        message: entry.message,
        lead_id: entry.lead_id,
        task_id: entry.task_id,
        ref: entry.ref,
        at: entry.at,
      }),
      signal: AbortSignal.timeout(4000),
    }).catch(() => {
      // An orchestrator being down must not stop the pipeline.
    });
  }
}
