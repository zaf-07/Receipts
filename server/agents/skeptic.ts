import type { Message, Receipt, Sentence } from '../../shared/types';
import { now } from '../clock';
import { isExpired } from '../domain/state';
import { containsSnippet, firstName } from '../domain/text';
import { fetchPage } from '../services/fetcher';
import { log } from '../services/activity';
import { recomputeLead } from '../services/leads';
import { allReceipts, getCompany, getLead, getMessage, getPerson, getReceipt, recordVerification, updateMessage } from '../services/store';
import { subjectFor, unsupportedFigures } from './writer';

// The Skeptic re-opens each source and tries to disprove each claim.
// A claim is struck if the page is gone, unreachable, or no longer contains the snippet.
// It stops when every claim is verified or struck. A draft with no surviving claim is blocked.

export interface Check {
  ok: boolean;
  reason: string | null;
}

/**
 * Re-open one receipt's source and confirm the snippet is still there.
 * Unreachable counts as failed: we cannot stand behind a source we cannot open.
 */
export async function checkReceipt(receipt: Receipt, cache = new Map<string, Promise<Awaited<ReturnType<typeof fetchPage>>>>()): Promise<Check> {
  let pending = cache.get(receipt.source_url);
  if (!pending) {
    pending = fetchPage(receipt.source_url);
    cache.set(receipt.source_url, pending);
  }
  const page = await pending;
  if (!page.ok) return { ok: false, reason: page.error ?? 'page is unreachable' };
  if (!containsSnippet(page.text, receipt.snippet)) return { ok: false, reason: 'the page no longer contains the quoted text' };
  return { ok: true, reason: null };
}

/** Verify one receipt and record the verdict on it. A receipt that already failed stays failed. */
async function verify(receipt: Receipt, cache: Map<string, Promise<Awaited<ReturnType<typeof fetchPage>>>>): Promise<Check> {
  if (receipt.status === 'failed') return { ok: false, reason: receipt.fail_reason ?? 'failed an earlier check' };
  const check = await checkReceipt(receipt, cache);
  recordVerification(receipt.id, check.ok, check.reason);
  return check;
}

/**
 * Review a draft before a human sees it. Every cited receipt is re-fetched.
 * Sentences whose evidence fails are struck and stay visible, with the reason.
 */
export async function reviewDraft(messageId: string): Promise<Message | null> {
  const message = getMessage(messageId);
  if (!message || message.status === 'sent' || message.status === 'rejected') return message;
  const lead = getLead(message.lead_id);
  const company = lead ? getCompany(lead.company_id) : null;
  if (!lead || !company) return message;

  const cache = new Map<string, Promise<Awaited<ReturnType<typeof fetchPage>>>>();
  const at = now();
  const sentences: Sentence[] = [];
  let struck = 0;
  let verified = 0;

  for (const s of message.sentences) {
    if (s.kind !== 'claim' || s.status === 'struck') {
      if (s.kind === 'claim') struck++;
      sentences.push(s);
      continue;
    }
    let reason: string | null = null;
    const cited: Receipt[] = [];
    if (s.receipt_ids.length === 0) reason = 'no receipt is attached to this sentence';
    for (const id of s.receipt_ids) {
      const receipt = getReceipt(id);
      if (!receipt) {
        reason = `receipt ${id} does not exist`;
        break;
      }
      cited.push(receipt);
      const check = await verify(receipt, cache);
      if (!check.ok) {
        reason = check.reason;
        log('skeptic', 'warn', `Struck: "${s.text}" Source check failed: ${check.reason}.`, { lead_id: lead.id, ref: receipt.id });
        break;
      }
      if (isExpired(receipt, at)) {
        reason = 'the receipt has expired';
        break;
      }
    }
    if (!reason) {
      const loose = unsupportedFigures(s.text, cited);
      if (loose.length) {
        reason = `the sources do not contain ${loose.join(', ')}`;
        log('skeptic', 'warn', `Struck: "${s.text}" The figure ${loose.join(', ')} is not in any cited source.`, { lead_id: lead.id });
      }
    }
    if (reason) {
      struck++;
      sentences.push({ ...s, status: 'struck', strike_reason: reason });
    } else {
      verified++;
      sentences.push({ ...s, status: 'ok', strike_reason: null });
    }
  }

  // Failed receipts change what the lead is allowed to do, so the state rules run before the verdict.
  recomputeLead(lead.id, { keepDraft: true });
  const after = getLead(lead.id)!;

  const surviving = sentences.filter((s) => s.kind === 'claim' && s.status === 'ok');
  let subject = message.subject;
  if (message.writer === 'template' && surviving.length > 0) {
    const person = getPerson(lead.person_id);
    const top = getReceipt(surviving[0].receipt_ids[0]);
    if (person && top) subject = subjectFor(firstName(person.name), top.field === 'signal' ? top.signal_type : null);
  }

  // The Skeptic's verdict is a new version of the draft. The Writer's version stays in the history.
  const verdict = { author: 'skeptic' as const, note: `Re-verified: ${verified} claim${verified === 1 ? ' stands' : 's stand'}, ${struck} struck` };
  if (surviving.length === 0) {
    updateMessage(message.id, { sentences, subject, status: 'blocked', block_reason: 'No claim survived re-verification, so there is nothing true left to send.' }, verdict);
    log('skeptic', 'block', `Draft for ${company.name} blocked: no claim survived re-verification.`, { lead_id: lead.id, ref: message.id });
  } else if (after.state !== 'active') {
    updateMessage(message.id, { sentences, subject, status: 'blocked', block_reason: after.dormant_reason ?? 'The lead has no live reason to contact.' }, verdict);
  } else {
    updateMessage(message.id, { sentences, subject, status: 'pending_review', block_reason: null }, verdict);
    log(
      'skeptic',
      'handoff',
      `${company.name}: ${verified} claim${verified === 1 ? '' : 's'} verified against the live page${struck ? `, ${struck} struck` : ''}. Handing to the Security agent.`,
      { lead_id: lead.id, ref: message.id },
    );
  }
  return getMessage(message.id);
}

/**
 * Re-check live negative receipts. Holding a lead back is also a claim, and it can go stale too.
 * Returns how many were disproved.
 */
export async function recheckNegatives(): Promise<number> {
  const at = now();
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof fetchPage>>>>();
  let disproved = 0;
  for (const receipt of allReceipts()) {
    if (receipt.sign !== 'negative' || receipt.status === 'failed' || isExpired(receipt, at)) continue;
    const check = await verify(receipt, cache);
    if (!check.ok) {
      disproved++;
      log('skeptic', 'info', `A reason to hold back no longer checks out: "${receipt.claim}" (${check.reason}).`, { ref: receipt.id });
    }
  }
  return disproved;
}
