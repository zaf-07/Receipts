import { now } from '../clock';
import { config } from '../config';
import { UserError } from '../errors';
import { isExpired } from '../domain/state';
import { log } from './activity';
import { currentTask } from './context';
import { balance, charge } from './ledger';
import { moveStage } from './leads';
import { getCompany, getLead, getMessage, getPerson, getReceipt, listCompanies, markSent } from './store';
import { getTask } from './tasks';
import { scanDraft } from '../agents/security';

// The one door out. Nothing else in the codebase can mark a message sent.
//
// Delivery needs an open human-approval task for this exact draft, and it refuses to run from
// inside any agent task. So a worker cannot send, whatever it is asked to do: not the Writer,
// not the Skeptic, not a task retried after a crash. The check is here, in the function that
// does the sending, and not in the callers.

/** Refused because of who or what is asking, as opposed to the state of the draft. */
export class DeliveryRefused extends Error {}

/**
 * Log the send for an approved draft. Delivery itself is simulated in this build: the send is
 * recorded, charged and attributed, and nothing leaves the machine.
 */
export function deliver(messageId: string, gateTaskId: string, reviewer: string): void {
  if (currentTask()) throw new DeliveryRefused('Delivery refused: an agent task cannot send. Only a person at the human gate can.');
  const gate = getTask(gateTaskId);
  if (!gate || gate.kind !== 'approve' || gate.agent !== 'human' || gate.status !== 'review' || gate.input.message_id !== messageId) {
    throw new DeliveryRefused('Delivery refused: there is no open human approval for this draft.');
  }
  if (!reviewer.trim()) throw new DeliveryRefused('Delivery refused: an approval needs the name of the person who gave it.');

  const message = getMessage(messageId);
  if (!message) throw new UserError('Unknown draft.');
  if (message.status !== 'pending_review') throw new UserError(`This draft is ${message.status.replace('_', ' ')} and cannot be approved.`);
  const lead = getLead(message.lead_id)!;
  const company = getCompany(lead.company_id)!;
  const person = getPerson(lead.person_id);
  if (lead.state !== 'active') throw new UserError(`${company.name} no longer has a live reason to contact: ${lead.dormant_reason}`);
  if (!person?.email) throw new UserError('There is no email address to send to.');

  // The evidence is checked one last time at the moment of sending.
  const at = now();
  for (const s of message.sentences) {
    if (s.kind !== 'claim' || s.status !== 'ok') continue;
    for (const id of s.receipt_ids) {
      const r = getReceipt(id);
      if (!r || r.status === 'failed' || isExpired(r, at)) {
        throw new UserError(`A receipt behind "${s.text}" is no longer live. Re-verify the draft before sending.`);
      }
    }
  }
  // The Security agent's check is repeated here, at the door, so a draft cannot go out around it.
  const cited = message.sentences
    .filter((s) => s.kind === 'claim' && s.status === 'ok')
    .flatMap((s) => s.receipt_ids)
    .map((id) => getReceipt(id))
    .filter((r) => r !== null);
  const stop = scanDraft(message, { company, person, cited, otherAccounts: listCompanies('prospect').map((c) => c.name) }).find((f) => f.severity === 'block');
  if (stop) throw new UserError(`Security check failed: ${stop.message}`);

  if (!charge('send', message.id, `Sending to ${company.name}`, lead.id)) {
    throw new UserError(`Sending needs ${config.costs.send} credit and the balance is ${balance()}. Top up to send.`);
  }

  markSent(message.id, reviewer, at.toISOString());
  moveStage(lead.id, 'Contacted', 'agent', 'Writer + Skeptic', `Approved by ${reviewer}. Send logged.`);
  log(
    'human',
    'done',
    `${reviewer} approved the ${message.channel === 'email' ? 'email' : 'LinkedIn note'} to ${person.name} at ${company.name}. Send logged (delivery is simulated) and the card moved to Contacted.`,
    { lead_id: lead.id, ref: message.id, task_id: gate.id, run_id: gate.run_id },
  );
}
