import type { Company, Message, Person, Receipt } from '../../shared/types';

// The Security agent reviews a draft before it can reach the human gate. It looks for what a
// fact-checker does not: links that go somewhere unverified, internal identifiers or secrets
// leaking into the copy, another prospect's name, and a recipient outside the target company.
// It is a pure check. It cannot send, approve or edit, and a blocking finding stops the draft.

export interface Finding {
  severity: 'block' | 'warn';
  code: string;
  message: string;
}

export interface ScanContext {
  company: Company | null;
  person: Person | null;
  /** Receipts the draft cites. Their sources are the only outside hosts a draft may link to. */
  cited: Receipt[];
  /** Names of other accounts in the pipeline. One prospect's email must never name another. */
  otherAccounts: string[];
}

const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'lnkd.in']);
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/;
const INTERNAL_ID = /\b(?:r|m|l|c|k|p|w|task|run|icp)_[0-9a-f]{6,8}\b/;
const URL_RE = /\bhttps?:\/\/[^\s<>")\]]+|\bwww\.[^\s<>")\]]+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

function isInternalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^\[?::1\]?$/.test(host)
  );
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** Review the words that would actually be sent: the subject and every sentence that was not struck. */
export function scanDraft(message: Message, ctx: ScanContext): Finding[] {
  const findings: Finding[] = [];
  const block = (code: string, text: string) => findings.push({ severity: 'block', code, message: text });
  const warn = (code: string, text: string) => findings.push({ severity: 'warn', code, message: text });
  const copy = [message.subject, ...message.sentences.filter((s) => s.status === 'ok').map((s) => s.text)].join('\n');

  // Outbound links.
  const allowed = new Set<string>();
  if (ctx.company?.domain) allowed.add(ctx.company.domain.toLowerCase());
  for (const r of ctx.cited) {
    const host = hostOf(r.source_url);
    if (host) allowed.add(host);
  }
  for (const raw of copy.match(URL_RE) ?? []) {
    const host = hostOf(raw);
    if (!host) block('malformed_link', `The copy contains a link that cannot be parsed: ${raw}`);
    else if (isInternalHost(host)) block('internal_link', `The copy links to an internal address (${host}), which would expose it to the recipient.`);
    else if (SHORTENERS.has(host)) block('shortened_link', `The copy uses a link shortener (${host}), which hides where the link goes.`);
    else if (![...allowed].some((a) => host === a || host.endsWith(`.${a}`))) block('unverified_link', `The copy links to ${host}, which no cited receipt vouches for.`);
    else if (raw.toLowerCase().startsWith('http://')) warn('insecure_link', `The link to ${host} is not HTTPS.`);
  }

  // Data exposure.
  if (SECRET.test(copy)) block('secret', 'The copy contains something that looks like a credential or token.');
  const internal = copy.match(INTERNAL_ID)?.[0];
  if (internal) block('internal_id', `The copy contains an internal record id (${internal}).`);
  const recipient = ctx.person?.email?.toLowerCase() ?? null;
  for (const address of copy.match(EMAIL_RE) ?? []) {
    if (address.toLowerCase() !== recipient) block('third_party_email', `The copy contains an email address that is not the recipient's (${address}).`);
  }
  const mine = ctx.company?.name.toLowerCase() ?? '';
  for (const name of ctx.otherAccounts) {
    if (name.length < 4 || name.toLowerCase() === mine) continue;
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(copy)) {
      block('other_prospect', `The copy names another account in the pipeline (${name}).`);
    }
  }

  // The recipient.
  if (!ctx.person?.email) {
    block('no_recipient', 'There is no recipient address.');
  } else if (ctx.company?.domain) {
    const domain = ctx.person.email.split('@')[1]?.toLowerCase() ?? '';
    const target = ctx.company.domain.toLowerCase();
    if (domain !== target && !domain.endsWith(`.${target}`)) block('recipient_domain', `The recipient's address is at ${domain}, not at ${target}.`);
    else if (ctx.person.email_status === 'guessed') warn('guessed_recipient', 'The recipient address is a pattern guess with no receipt.');
    // Checked whatever the domain is: mail to a domain with no mail server only bounces.
    if (ctx.person.mail_check === 'no_mail_server') block('undeliverable_recipient', ctx.person.mail_note ?? `${domain} publishes no mail server.`);
  }

  // A LinkedIn note needs somewhere to go. Without a published profile a person has to find it by hand.
  if (message.channel === 'linkedin' && ctx.person && !ctx.person.linkedin_url) {
    warn('no_linkedin_profile', "The company's pages link no LinkedIn profile for this person, and none was guessed.");
  }

  // Sources behind the claims.
  for (const r of ctx.cited) {
    if (!/^https?:\/\//i.test(r.source_url)) block('bad_source', `A cited source is not a web address: ${r.source_url}`);
  }
  return findings;
}

export function summarise(findings: Finding[]): string {
  const blocks = findings.filter((f) => f.severity === 'block');
  const warns = findings.filter((f) => f.severity === 'warn');
  if (blocks.length) return `Blocked: ${blocks.map((f) => f.message).join(' ')}`;
  if (warns.length) return `Cleared with ${warns.length} warning${warns.length === 1 ? '' : 's'}: ${warns.map((f) => f.message).join(' ')}`;
  return 'Cleared. No outbound links, no internal data, recipient is at the target company.';
}
