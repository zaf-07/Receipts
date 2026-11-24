import type { IcpVersion, Lead } from '../../shared/types';
import { config } from '../config';
import { containsSnippet, links } from '../domain/text';
import { fetchPage, type FetchedPage } from '../services/fetcher';
import { charge } from '../services/ledger';
import { checkMailDomain } from '../services/deliverability';
import { log } from '../services/activity';
import { addReceipt, createPerson, getCompany, updateLead } from '../services/store';
import { isWorldUrl } from '../world/world';
import { llmReadPeople, mainText, rulePeople, type PersonHit } from './extractor';

// The Enricher resolves one contact per active lead and records how sure it is.
// It stops when the contact is resolved, or marked unverified at low confidence.
// An unresolved contact is shown as unresolved. It is never hidden and never invented.

const TITLE_WORDS = /\b(vp|vice|president|head|chief|cto|ceo|cfo|cro|ciso|director|lead|engineering|platform|finance|revenue|sales|marketing|operations|people|product|growth|technology|officer)\b/g;
const SYNONYMS: Record<string, string[]> = {
  cto: ['chief', 'technology', 'engineering'],
  cro: ['chief', 'revenue'],
  cfo: ['chief', 'finance'],
  ceo: ['chief', 'executive'],
  ciso: ['chief', 'security'],
  vp: ['vice', 'president'],
};

function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>(title.toLowerCase().match(TITLE_WORDS) ?? []);
  for (const t of [...tokens]) for (const s of SYNONYMS[t] ?? []) tokens.add(s);
  return tokens;
}

/** How well a title matches the ICP personas, weighted by each persona's confidence. */
export function personaScore(title: string, icp: IcpVersion): number {
  const have = titleTokens(title);
  let best = 0;
  for (const persona of icp.fields.personas) {
    const want = titleTokens(persona.value);
    if (want.size === 0) continue;
    const overlap = [...want].filter((t) => have.has(t)).length / want.size;
    best = Math.max(best, overlap * persona.confidence);
  }
  return best;
}

async function findTeamPage(siteUrl: string): Promise<FetchedPage | null> {
  if (isWorldUrl(siteUrl)) {
    const index = await fetchPage(siteUrl);
    if (!index.ok) return null;
    const candidate = links(index.html, siteUrl).find((u) => u.startsWith(siteUrl) && /\/(team|leadership|people)\/?$/.test(u));
    if (!candidate) return null;
    const page = await fetchPage(candidate);
    return page.ok ? page : null;
  }
  for (const path of ['team', 'about', 'company', 'about-us', 'leadership']) {
    const page = await fetchPage(new URL(path, siteUrl).toString(), 6000);
    if (page.ok && page.text.length > 200) return page;
  }
  return null;
}

function guessEmail(name: string, domain: string): string {
  const parts = name.toLowerCase().replace(/[^a-z\s-]/g, '').split(/\s+/).filter(Boolean);
  return `${parts[0]}.${parts.slice(1).join('')}@${domain}`;
}

export type EnrichResult = 'resolved' | 'low_confidence' | 'unresolved' | 'blocked_credits';

/** Resolve the contact for one lead. Metered: a resolved contact costs credits, and the gate can refuse. */
export async function enrichLead(lead: Lead, icp: IcpVersion): Promise<EnrichResult> {
  const company = getCompany(lead.company_id);
  if (!company) return 'unresolved';

  // Found on a third-party page, with no website of its own on record: there is nowhere to read a contact from.
  if (!company.domain) {
    const note = "The company's own website is not known yet, so no contact could be read.";
    updateLead(lead.id, { enrich_status: 'unresolved', enrich_note: note });
    log('enricher', 'warn', `${company.name}: contact unresolved. ${note}`, { lead_id: lead.id });
    return 'unresolved';
  }
  const page = await findTeamPage(company.site_url);
  const people: PersonHit[] = page
    ? isWorldUrl(page.url)
      ? rulePeople(mainText(page.html))
      : await llmReadPeople(page.text, company.name)
    : [];

  if (!page || people.length === 0) {
    const note = page ? 'The team page names nobody we could read.' : 'No public team page found.';
    updateLead(lead.id, { enrich_status: 'unresolved', enrich_note: note });
    log('enricher', 'warn', `${company.name}: contact unresolved. ${note} Shown as unresolved, not guessed.`, { lead_id: lead.id });
    return 'unresolved';
  }

  // One enrichment per lead, ever: a retried task finds the charge already made and does not pay again.
  if (!charge('enrich', lead.id, `Enriching ${company.name}`, lead.id, true)) {
    updateLead(lead.id, {
      enrich_status: 'blocked_credits',
      enrich_note: `Enrichment needs ${config.costs.enrich} credits. Top up to continue.`,
    });
    return 'blocked_credits';
  }

  const pick = people.map((p) => ({ p, score: personaScore(p.title, icp) })).sort((a, b) => b.score - a.score)[0];
  const hit = pick.p;
  const onPage = hit.email != null && containsSnippet(page.text, hit.email);
  const email = onPage ? hit.email : guessEmail(hit.name, company.domain);
  const status = onPage ? 'verified' : 'guessed';
  // One lookup the Enricher can do itself: does the domain take mail at all? It says nothing about the mailbox.
  const mail = await checkMailDomain(email);
  const dead = mail.check === 'no_mail_server';
  const confidence = dead ? 0.05 : onPage ? (pick.score > 0 ? 0.9 : 0.7) : 0.35;

  const person = createPerson({
    company_id: company.id,
    name: hit.name,
    title: hit.title,
    email,
    email_status: status,
    mail_check: mail.check,
    mail_note: mail.note,
    previous_companies: hit.previous,
    confidence,
  });

  const base = { entity_type: 'person' as const, entity_id: person.id, source_url: page.url, signal_type: 'contact' as const, sign: 'positive' as const };
  addReceipt({ ...base, field: 'contact', claim: `${hit.name} is ${hit.title} at ${company.name}.`, snippet: hit.snippet, confidence: 0.85 });
  if (onPage) addReceipt({ ...base, field: 'email', claim: `${hit.name}'s published email is ${hit.email}.`, snippet: hit.email!, confidence: 0.9 });
  for (const prev of hit.previous) {
    addReceipt({ ...base, field: 'previous_company', claim: `${hit.name} previously worked at ${prev}.`, snippet: hit.snippet, confidence: 0.8, data: { company: prev } });
  }

  if (dead) {
    const note = `${mail.note} ${onPage ? 'The address is printed on the team page all the same.' : `${email} was a pattern guess.`}`;
    updateLead(lead.id, { person_id: person.id, enrich_status: 'low_confidence', enrich_note: note });
    log('enricher', 'warn', `${company.name}: ${hit.name}, ${hit.title}. ${note} Nothing can be sent to it.`, { lead_id: lead.id });
    return 'low_confidence';
  }
  if (onPage) {
    updateLead(lead.id, { person_id: person.id, enrich_status: 'resolved', enrich_note: null });
    log('enricher', 'done', `${company.name}: ${hit.name}, ${hit.title}. Email found on the team page.`, { lead_id: lead.id });
    return 'resolved';
  }
  const note = `Email not published. ${email} is a pattern guess and has no receipt.${mail.check === 'accepts_mail' ? ' Its domain does accept mail.' : ''}`;
  updateLead(lead.id, { person_id: person.id, enrich_status: 'low_confidence', enrich_note: note });
  log('enricher', 'warn', `${company.name}: ${hit.name}, ${hit.title}. ${note} Marked low confidence.`, { lead_id: lead.id });
  return 'low_confidence';
}
