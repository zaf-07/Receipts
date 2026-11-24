import type { ActivityEntry } from '../../shared/types';
import { config } from '../config';

/**
 * Agent roles and their stop conditions, in the order work is handed off.
 * This is the map an external orchestrator (Band, or anything else) needs to host the same team.
 * The human is a role like the others: nothing is dispatched without its approval.
 */
export const AGENT_ROLES = [
  { role: 'planner', job: 'Turns the product description into an ICP and a search plan', stops_when: 'ICP fields carry confidence scores', hands_off_to: 'researcher' },
  { role: 'researcher', job: 'Finds accounts and signals; writes receipts with sources', stops_when: 'Every lead has a live receipt or a dormant reason', hands_off_to: 'enricher' },
  { role: 'enricher', job: 'Resolves the contact, email and deliverability status', stops_when: 'Contact resolved, or marked unverified at low confidence', hands_off_to: 'writer' },
  { role: 'writer', job: 'Drafts outreach; every factual sentence carries receipt ids', stops_when: 'No uncited factual sentence remains', hands_off_to: 'skeptic' },
  { role: 'skeptic', job: 'Re-opens each source and tries to disprove each claim', stops_when: 'Every claim is verified or struck', hands_off_to: 'human' },
  { role: 'human', job: 'Approves, edits or rejects', stops_when: 'Nothing sends without this click', hands_off_to: 'analyst' },
  { role: 'analyst', job: 'Reads outcomes, reweights signal types, proposes the next ICP version', stops_when: 'A diff is ready for review', hands_off_to: 'planner' },
] as const;

export function bandEnabled(): boolean {
  return Boolean(config.band.apiKey && config.band.chatId);
}

/**
 * Write a Receipts handoff to Band's Agent API as a room event.
 *
 * Events are deliberately used instead of text messages: Band text messages must
 * mention a concrete room participant and route work to that participant. Receipts
 * remains the executor of its deterministic pipeline, while the Band room gives the
 * human an auditable, real-time view of each specialised role and its blocks.
 */
export function forwardToBand(entry: ActivityEntry): void {
  if (!bandEnabled()) return;

  const messageType = entry.kind === 'block' ? 'error' : 'task';
  void fetch(`${config.band.baseUrl}/agent/chats/${encodeURIComponent(config.band.chatId)}/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.band.apiKey,
    },
    body: JSON.stringify({
      event: {
        content: `[${entry.agent}] ${entry.message}`,
        message_type: messageType,
        metadata: {
          source: 'receipts',
          type: entry.kind === 'block' ? 'agent.blocked' : 'agent.handoff',
          agent: entry.agent,
          activity_id: entry.id,
          lead_id: entry.lead_id,
          ref: entry.ref,
          occurred_at: entry.at,
        },
      },
    }),
    signal: AbortSignal.timeout(4000),
  }).catch(() => {
    // Band is observability, never a dependency for the prospecting workflow.
  });
}

/**
 * Forward a handoff to an external orchestrator. Off unless AGENT_EVENTS_WEBHOOK_URL is set.
 * Kept for generic non-Band integrations and backwards compatibility.
 */
export function forwardHandoff(entry: ActivityEntry): void {
  forwardToBand(entry);
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
        ref: entry.ref,
        at: entry.at,
      }),
      signal: AbortSignal.timeout(4000),
    }).catch(() => {
      // An orchestrator being down must not stop the pipeline.
    });
  }
}
