import { z } from 'zod';
import type { Company, IcpVersion, Lead, Message, Person, Profile, Receipt, Sentence, SignalType } from '../../shared/types';
import { SIGNALS } from '../../shared/constants';
import { now } from '../clock';
import { isLive, isTrigger } from '../domain/state';
import { freshness } from '../domain/scoring';
import { extractNumbers, firstName, normalize } from '../domain/text';
import { structured } from '../services/llm';
import { charge } from '../services/ledger';
import { log } from '../services/activity';
import { createMessage, getCompany, getPerson, leadReceipts } from '../services/store';

// The Writer builds an email as a list of sentences. Each sentence is a claim or a connective,
// and each claim lists the receipts it rests on. It stops when no uncited factual sentence remains.

export interface Draft {
  subject: string;
  sentences: Sentence[];
}

interface Context {
  company: Company;
  person: Person;
  profile: Profile;
  /** Live positive triggers, strongest first. */
  triggers: Receipt[];
  /** A receipt showing the contact used to work at one of our customers. */
  warm: Receipt | null;
}

const TOPIC: Partial<Record<SignalType, string>> = {
  job_posting: 'your open role',
  funding: 'what comes after the round',
  exec_hire: 'the new leadership seat',
  tech_change: 'the pricing change',
};

const BRIDGE: Partial<Record<SignalType, string>> = {
  job_posting: 'A hire like that usually means the work has outgrown side-project status.',
  funding: 'New capital tends to turn the things you patched together into things you have to get right.',
  exec_hire: 'A new leader in that seat usually means the stack is about to be reviewed.',
  tech_change: 'That kind of change is where home-built systems start to creak.',
};

/** A subject line that points at the reason without stating a fact of its own. */
export function subjectFor(first: string, type: SignalType | null): string {
  return `${first}, a thought on ${(type && TOPIC[type]) || 'timing'}`;
}

function claimText(r: Receipt, ctx: Context): string {
  const c = ctx.company.name;
  const d = r.data;
  if (r.signal_type === 'job_posting' && d.role) return `I saw that ${c} has an open ${d.role} role.`;
  if (r.signal_type === 'funding' && d.amount && d.round) return `Congratulations on the ${d.amount} ${d.round}.`;
  if (r.signal_type === 'exec_hire' && d.person && d.title) {
    return d.person === ctx.person.name ? `Congratulations on joining ${c} as ${d.title}.` : `I saw that ${c} appointed ${d.person} as ${d.title}.`;
  }
  if (r.signal_type === 'tech_change' && d.change) return `I read that ${c} is ${d.change}.`;
  // No structured detail: restate the receipt's own claim rather than embroider it.
  return `I noticed that ${r.claim.replace(/\.$/, '')}.`;
}

const claim = (text: string, ids: string[]): Sentence => ({ text, kind: 'claim', receipt_ids: ids, status: 'ok' });
const connective = (text: string): Sentence => ({ text, kind: 'connective', receipt_ids: [], status: 'ok' });

/** The deterministic writer. Every factual sentence is generated from a receipt, so none can be uncited. */
export function templateDraft(ctx: Context): Draft {
  const first = firstName(ctx.person.name);
  const top = ctx.triggers.slice(0, 2);
  const sentences: Sentence[] = [connective(`Hi ${first},`)];
  for (const r of top) sentences.push(claim(claimText(r, ctx), [r.id]));
  const bridge = top[0] && BRIDGE[top[0].signal_type];
  if (bridge) sentences.push(connective(bridge));
  if (ctx.warm?.data.company) {
    sentences.push(claim(`You were at ${ctx.warm.data.company} before ${ctx.company.name}, and ${ctx.warm.data.company} runs on ${ctx.profile.product_name}.`, [ctx.warm.id]));
  }
  sentences.push(connective(ctx.profile.description.split(/(?<=[.!?])\s+/)[0] ?? ctx.profile.description));
  sentences.push(connective('Worth a 15-minute look next week?'));
  sentences.push(connective(ctx.profile.sender || ctx.profile.product_name));
  return { subject: subjectFor(first, top[0]?.signal_type ?? null), sentences };
}

/** Numbers in a claim that none of its cited receipts contain. An invented figure shows up here. */
export function unsupportedFigures(text: string, cited: Receipt[]): string[] {
  const support = cited.flatMap((r) => [...extractNumbers(r.snippet), ...extractNumbers(r.claim)]);
  return extractNumbers(text).filter((n) => !support.includes(n));
}

/** Check a draft against the sentence format. Returns the problems, or an empty list. */
export function validateDraft(draft: Draft, allowed: Map<string, Receipt>): string[] {
  const errors: string[] = [];
  if (!draft.subject.trim()) errors.push('The subject is empty.');
  if (/\$|\d{2,}|%/.test(draft.subject)) errors.push('The subject must not state figures.');
  if (draft.sentences.length === 0 || draft.sentences.length > 10) errors.push('Use between 1 and 10 sentences.');
  const claims = draft.sentences.filter((s) => s.kind === 'claim');
  if (claims.length === 0) errors.push('There is no claim sentence. At least one sentence must rest on a receipt.');
  draft.sentences.forEach((s, i) => {
    const n = i + 1;
    if (!s.text.trim()) errors.push(`Sentence ${n} is empty.`);
    if (s.kind === 'claim') {
      if (s.receipt_ids.length === 0) errors.push(`Sentence ${n} is a claim with no receipt id.`);
      const unknown = s.receipt_ids.filter((id) => !allowed.has(id));
      if (unknown.length) errors.push(`Sentence ${n} cites receipts that are not available for this lead: ${unknown.join(', ')}.`);
      const cited = s.receipt_ids.map((id) => allowed.get(id)).filter((r): r is Receipt => Boolean(r));
      const loose = unsupportedFigures(s.text, cited);
      if (cited.length && loose.length) errors.push(`Sentence ${n} states figures its receipts do not contain: ${loose.join(', ')}.`);
    } else if (/\$\s?\d|\d\s?%|\b(?:million|billion|series [a-f])\b/i.test(s.text)) {
      errors.push(`Sentence ${n} is marked connective but states a fact. Make it a claim with a receipt, or remove it.`);
    }
  });
  return errors;
}

const DraftSchema = z.object({
  subject: z.string().describe('Short. Must not state any fact or figure about the prospect.'),
  sentences: z.array(
    z.object({
      text: z.string(),
      kind: z.enum(['claim', 'connective']),
      receipt_ids: z.array(z.string()).describe('Receipt ids this sentence rests on. Required for claims, empty for connectives.'),
    }),
  ),
});

async function llmDraft(ctx: Context, allowed: Map<string, Receipt>): Promise<Draft | null> {
  const receipts = [...allowed.values()]
    .map((r) => `- id ${r.id} [${SIGNALS[r.signal_type].label}] claim: ${r.claim}\n  source text: "${r.snippet}"`)
    .join('\n');
  const system = `You are the Writer in a go-to-market pipeline. You write one short, plain cold email.

The email is a list of sentences. Each sentence is one of:
- claim: states a fact about the prospect, their company, or our relationship to them. A claim MUST list the receipt ids it rests on, and may only say what those receipts' source text says. Never add a number, name, date or detail that is not in the source text.
- connective: greeting, transition, our own product pitch, the ask, the sign-off. A connective must not state any fact about the prospect.

If you want to say something about the prospect and no receipt supports it, leave it out. An email with one true sentence beats one with three impressive ones.
Keep it under 90 words. No exclamation marks, no flattery, no "I hope this finds you well". End with a low-pressure question and then the sender's name as its own sentence.`;
  const user = `Our product: ${ctx.profile.product_name}. ${ctx.profile.description}
Sender: ${ctx.profile.sender || ctx.profile.product_name}
Recipient: ${ctx.person.name}, ${ctx.person.title} at ${ctx.company.name}
${ctx.warm?.data.company ? `Note: ${ctx.warm.data.company} is an existing customer of ours (you may say so in a claim that cites receipt ${ctx.warm.id}).\n` : ''}
Receipts you may cite:
${receipts}`;

  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await structured(
      'writer',
      DraftSchema,
      system,
      attempt === 0 ? user : `${user}\n\nYour previous draft was rejected by the format check:\n${errors.map((e) => `- ${e}`).join('\n')}\nFix every problem.`,
      'medium',
    );
    if (!out) return null;
    const draft: Draft = {
      subject: out.subject.trim(),
      sentences: out.sentences.map((s) => ({
        text: s.text.trim(),
        kind: s.kind,
        receipt_ids: s.kind === 'claim' ? [...new Set(s.receipt_ids)] : [],
        status: 'ok' as const,
      })),
    };
    errors = validateDraft(draft, allowed);
    if (errors.length === 0) return draft;
  }
  log('writer', 'warn', `Model draft failed the sentence format twice (${errors[0]}). Falling back to the template writer.`);
  return null;
}

/** Customers named in the profile that the contact used to work at. This is the warm-intro edge. */
export function warmIntro(receipts: Receipt[], profile: Profile): Receipt | null {
  const customers = new Set(profile.customers.map((c) => normalize(c)));
  return receipts.find((r) => r.field === 'previous_company' && r.data.company && customers.has(normalize(r.data.company))) ?? null;
}

/** Draft outreach for one lead. Metered. Returns null when there is nothing to say or the credit gate refuses. */
export async function writeDraft(lead: Lead, icp: IcpVersion, profile: Profile): Promise<Message | 'blocked_credits' | null> {
  const company = getCompany(lead.company_id);
  const person = getPerson(lead.person_id);
  if (!company || !person) return null;

  const at = now();
  const receipts = leadReceipts(lead);
  const strength = (r: Receipt) =>
    (icp.weights[r.signal_type] ?? SIGNALS[r.signal_type].weight) * freshness(r, at, icp.windows[r.signal_type] ?? SIGNALS[r.signal_type].window ?? 90);
  const triggers = receipts.filter((r) => r.sign === 'positive' && isTrigger(r) && isLive(r, at)).sort((a, b) => strength(b) - strength(a));
  if (triggers.length === 0) return null;

  if (!charge('draft', lead.id, `Drafting for ${company.name}`, lead.id)) return 'blocked_credits';

  const warm = warmIntro(receipts, profile);
  const ctx: Context = { company, person, profile, triggers, warm };
  const allowed = new Map<string, Receipt>(triggers.map((r) => [r.id, r]));
  if (warm) allowed.set(warm.id, warm);

  const fromModel = await llmDraft(ctx, allowed);
  const draft = fromModel ?? templateDraft(ctx);
  const message = createMessage({ lead_id: lead.id, subject: draft.subject, sentences: draft.sentences, writer: fromModel ? 'llm' : 'template' });
  const claims = draft.sentences.filter((s) => s.kind === 'claim').length;
  log('writer', 'handoff', `Draft for ${person.name} at ${company.name}: ${claims} claim${claims === 1 ? '' : 's'}, each with receipt ids. Handing off to the Skeptic.`, {
    lead_id: lead.id,
    ref: message.id,
  });
  return message;
}
