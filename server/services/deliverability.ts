import { resolveMx } from 'node:dns/promises';
import type { MailCheck } from '../../shared/types';

// Can this address receive mail at all?
//
// A DNS lookup answers the first half of that question for free: a domain that publishes no mail
// server cannot receive an email, whatever the mailbox is called. It does not answer the second
// half. A domain that accepts mail may still have no such mailbox, and only the receiving server
// knows. So a passing check is reported as "the domain accepts mail", never as "the address is
// valid", and a pattern-guessed address stays a guess.

export interface MailResult {
  check: MailCheck;
  note: string;
}

type MxRecord = { exchange: string; priority: number };
type Resolver = (domain: string) => Promise<MxRecord[]>;

let resolver: Resolver = resolveMx;

/** Tests swap the resolver so they never depend on real DNS. */
export function setMxResolver(next: Resolver | null): void {
  resolver = next ?? resolveMx;
  cache.clear();
}

// Reserved names that never resolve (RFC 2606, RFC 6761). The seeded demo world lives on .example.
const RESERVED = /\.(example|test|invalid|localhost)$|^(example\.(com|net|org)|localhost)$/;
const NOT_THERE = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);
const cache = new Map<string, MailResult>();

export async function checkMailDomain(email: string | null, timeoutMs = 4000): Promise<MailResult> {
  const domain = email?.split('@')[1]?.trim().toLowerCase().replace(/\.$/, '') ?? '';
  if (!domain || !domain.includes('.')) return { check: 'unchecked', note: 'No domain to check.' };
  if (RESERVED.test(domain)) return { check: 'unchecked', note: `${domain} is a reserved demo domain, so there is no mail server to look up.` };
  const known = cache.get(domain);
  if (known) return known;

  let result: MailResult;
  try {
    const records = await Promise.race([
      resolver(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), timeoutMs).unref()),
    ]);
    // A single record pointing at "." is a null MX (RFC 7505): the domain says it takes no mail.
    const servers = records.filter((r) => r.exchange && r.exchange !== '.').sort((a, b) => a.priority - b.priority);
    result = servers.length
      ? { check: 'accepts_mail', note: `${domain} accepts mail (${servers[0].exchange}). The mailbox itself is not confirmed.` }
      : { check: 'no_mail_server', note: `${domain} states that it accepts no mail.` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    // "No such record" is an answer. A timeout or a refused query is not, and is not held against the address.
    if (NOT_THERE.has(code)) result = { check: 'no_mail_server', note: `${domain} publishes no mail server, so mail to it cannot be delivered.` };
    else return { check: 'unchecked', note: `The mail server lookup for ${domain} did not answer (${code || 'error'}).` };
  }
  cache.set(domain, result);
  return result;
}
