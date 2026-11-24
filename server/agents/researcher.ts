import type { Company, IcpVersion, Profile } from '../../shared/types';
import { config, llmEnabled } from '../config';
import { containsSnippet, links, metaContent, pageDate } from '../domain/text';
import { fetchPage, type FetchedPage } from '../services/fetcher';
import { webSearch } from '../services/llm';
import { log } from '../services/activity';
import {
  addReceipt,
  createCompany,
  createLead,
  findCompany,
  getCompany,
  leadForCompany,
  listCompanies,
  receiptsFor,
  updateCompany,
  type NewReceipt,
} from '../services/store';
import { isWorldUrl, worldBase, worldSiteOf } from '../world/world';
import {
  llmReadPage,
  mainText,
  ruleFacts,
  rulePositioning,
  rulePricing,
  ruleSignals,
  type FactHit,
  type SignalHit,
} from './extractor';

// The Researcher finds accounts and signals and writes receipts with sources.
// A signal is accepted only if its snippet appears on the cited page.
//
// Its work is two kinds of task. One search task runs the search plan and returns the accounts
// worth reading. Then one read task per account runs in parallel: each reads a single company
// and appends that company's receipts. No read task touches another company's records.

/** What one task wrote. Ids are returned so the task run can record its outputs. */
interface Tally {
  receipts: string[];
  rejected: number;
}

export interface Target {
  url: string;
  name: string;
}

export interface SearchOutcome {
  targets: Target[];
  searches: number;
  competitors: number;
  receipts: string[];
  /** Why nothing could be searched, when that is the case. */
  blocker?: string;
}

export interface ReadOutcome {
  name: string;
  company_id: string | null;
  lead_id: string | null;
  receipts: string[];
  rejected: number;
  pages: number;
  /** Set when the account was read but deliberately not turned into a lead. */
  skipped?: string;
}

async function search(query: string): Promise<string[]> {
  if (config.source === 'live') return (await webSearch(query)).map((r) => r.url);
  try {
    const res = await fetch(`${worldBase()}/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json()) as { results: { url: string }[] };
    return body.results.map((r) => r.url);
  } catch {
    return [];
  }
}

/** Write a receipt only if the page really contains the snippet. */
function accept(page: FetchedPage, input: NewReceipt, tally: Tally): void {
  if (!containsSnippet(page.text, input.snippet)) {
    tally.rejected++;
    log('researcher', 'warn', `Rejected a claim with no matching text on the page: "${input.claim}"`, { ref: input.source_url });
    return;
  }
  const { receipt, created } = addReceipt(input);
  if (created) tally.receipts.push(receipt.id);
}

function applyFacts(company: Company, page: FetchedPage, facts: FactHit[], tally: Tally): void {
  const patch: Partial<Company> = {};
  for (const f of facts) {
    accept(
      page,
      { entity_type: 'company', entity_id: company.id, field: f.field, claim: f.claim, source_url: page.url, snippet: f.snippet, signal_type: 'firmographic', sign: 'positive', confidence: f.confidence },
      tally,
    );
    if (!containsSnippet(page.text, f.snippet)) continue;
    if (f.field === 'headcount') patch.headcount = Number(f.value);
    else patch[f.field] = f.value;
  }
  updateCompany(company.id, patch);
}

function applySignals(company: Company, page: FetchedPage, signals: SignalHit[], fallbackDate: string | null, tally: Tally): void {
  for (const s of signals) {
    accept(
      page,
      {
        entity_type: 'company',
        entity_id: company.id,
        field: 'signal',
        claim: s.claim,
        source_url: page.url,
        snippet: s.snippet,
        signal_type: s.signal_type,
        sign: s.sign,
        event_at: s.event_at ?? fallbackDate,
        confidence: s.confidence,
        data: s.data,
      },
      tally,
    );
  }
}

/** A serviceable-region exclusion is a negative receipt like any other: it suppresses, with its source shown. */
function applyRegionExclusion(companyId: string, icp: IcpVersion, tally: Tally): void {
  const company = getCompany(companyId);
  if (!company?.region || !icp.fields.excluded_regions.includes(company.region)) return;
  const basis = receiptsFor([company.id]).find((r) => r.field === 'region' && r.sign === 'positive');
  if (!basis) return;
  const { receipt, created } = addReceipt({
    entity_type: 'company',
    entity_id: company.id,
    field: 'region_exclusion',
    claim: `${company.name} is headquartered in ${company.hq ?? company.region}, outside the regions we serve.`,
    source_url: basis.source_url,
    snippet: basis.snippet,
    signal_type: 'firmographic',
    sign: 'negative',
    confidence: basis.confidence,
  });
  if (created) tally.receipts.push(receipt.id);
}

/** Find or create a company. Synchronous, so two parallel tasks cannot both create the same one. */
function ensureCompany(name: string, domain: string, siteUrl: string, kind: Company['kind']): Company {
  return findCompany(siteUrl, domain) ?? createCompany({ name, domain, site_url: siteUrl, kind });
}

// ---------- reading one site in the seeded world ----------

interface Site {
  url: string;
  name: string;
  domain: string;
  pages: FetchedPage[];
}

function siteIdentity(index: FetchedPage, siteUrl: string): { name: string; domain: string } {
  return {
    name: metaContent(index.html, 'og:site_name') ?? new URL(siteUrl).pathname.split('/').filter(Boolean).pop() ?? siteUrl,
    domain: index.text.match(/\b([a-z0-9-]+\.(?:example|test))\b/)?.[1] ?? new URL(siteUrl).host,
  };
}

async function crawlSite(siteUrl: string): Promise<Site | null> {
  const index = await fetchPage(siteUrl);
  if (!index.ok) return null;
  const urls = links(index.html, siteUrl).filter((u) => u.startsWith(siteUrl) && u !== siteUrl).slice(0, 16);
  const pages = (await Promise.all(urls.map((u) => fetchPage(u)))).filter((p) => p.ok);
  return { url: siteUrl, ...siteIdentity(index, siteUrl), pages };
}

const pageNamed = (site: Site, slug: string) => site.pages.find((p) => p.url.replace(/\/$/, '').endsWith(`/${slug}`));

/**
 * Does this description share our product category? Keywords are compared word by word, because
 * the model planner writes phrases ("usage-based billing") where the keyword planner writes single
 * words, and a rival rarely repeats a whole phrase. Two distinct category words are required.
 */
export function sharesCategory(description: string, keywords: string[]): boolean {
  const text = description.toLowerCase();
  const words = new Set(keywords.flatMap((k) => k.toLowerCase().split(/[^a-z0-9-]+/)).filter((w) => w.length >= 5));
  return [...words].filter((w) => text.includes(w)).length >= 2;
}

/** A site that sells in our category and publishes a price is a competitor, not a prospect. */
function isCompetitor(site: Site, icp: IcpVersion): boolean {
  const about = pageNamed(site, 'about');
  if (!about || !pageNamed(site, 'pricing')) return false;
  return sharesCategory(mainText(about.html), icp.fields.keywords);
}

function readCompetitor(site: Site, profile: Profile, tally: Tally): void {
  const company = ensureCompany(site.name, site.domain, site.url, 'competitor');
  const about = pageNamed(site, 'about')!;
  const pricing = pageNamed(site, 'pricing')!;
  applyFacts(company, about, ruleFacts(mainText(about.html), site.name), tally);
  const positioning = rulePositioning(mainText(about.html), site.name);
  if (positioning) {
    accept(about, { entity_type: 'competitor', entity_id: company.id, field: 'positioning', claim: `${site.name} positions itself as: ${positioning}`, source_url: about.url, snippet: positioning, signal_type: 'firmographic', sign: 'positive', confidence: 0.8 }, tally);
  }
  const price = rulePricing(mainText(pricing.html));
  if (price) {
    accept(pricing, { entity_type: 'competitor', entity_id: company.id, field: 'pricing', claim: `${site.name} publishes this price: ${price}`, source_url: pricing.url, snippet: price, signal_type: 'firmographic', sign: 'positive', confidence: 0.85 }, tally);
  }
  if (!company.differentiator) updateCompany(company.id, { differentiator: differentiator(profile, site.name, price) });
}

/** A plain side-by-side, built only from our own intake and the rival's receipted price. */
function differentiator(profile: Profile, rival: string, price: string | null): string {
  const sentences = profile.description.split(/(?<=[.!?])\s+/);
  const pitch = sentences[1] ?? sentences[0] ?? profile.description;
  const figure = (text: string) =>
    text
      .match(/\$\s?[\d,]+(?:\.\d+)?(?:\s?(?:per|a|\/)\s?\w+)?|\d+(?:\.\d+)?%(?:\s+of\s+[a-z]+(?:\s+[a-z]+)?)?/)?.[0]
      ?.replace(/[,.\s]+$/, '');
  const ours = figure(profile.pricing);
  const theirs = price ? figure(price) : null;
  const onPrice = ours && theirs ? ` On price: we start at ${ours}; ${rival} lists ${theirs}.` : '';
  return `${pitch}${onPrice}`;
}

// ---------- the search task ----------

/**
 * Run the search plan and decide which accounts are worth a read task.
 * Competitors are recognised and recorded here, because every read task needs their names
 * to spot a prospect that has already signed with one.
 */
export async function runSearch(icp: IcpVersion, profile: Profile, pass: 'discovery' | 'ingest'): Promise<SearchOutcome> {
  const out: SearchOutcome = { targets: [], searches: 0, competitors: 0, receipts: [] };
  if (config.source === 'live' && !llmEnabled()) {
    out.blocker = 'Live web mode needs model credentials. Set ANTHROPIC_API_KEY, or switch RECEIPTS_SOURCE back to world.';
    return out;
  }
  const plan = pass === 'ingest' && config.source === 'live' ? icp.search_plan.slice(0, 4) : icp.search_plan;
  out.searches = plan.length;
  log('researcher', 'start', `${pass === 'ingest' ? 'Refreshing signals' : 'Discovery'}: running ${plan.length} searches from ICP v${icp.version}.`);

  const found = new Set<string>();
  for (let i = 0; i < plan.length; i += 4) {
    const results = await Promise.all(plan.slice(i, i + 4).map(search));
    for (const list of results) for (const url of list) found.add(url);
  }

  if (config.source === 'live') {
    out.targets = [...found].slice(0, 18).map((url) => ({ url, name: new URL(url).host.replace(/^www\./, '') }));
    log('researcher', 'handoff', `${found.size} result pages found. Reading the first ${out.targets.length} in parallel, one task each.`);
    return out;
  }

  const roots = new Set<string>();
  for (const u of found) {
    const root = worldSiteOf(u);
    if (root) roots.add(root);
  }
  // Known accounts are re-read on every pass. This is the continuous signal ingestion.
  for (const c of [...listCompanies('prospect'), ...listCompanies('competitor')]) if (isWorldUrl(c.site_url)) roots.add(c.site_url);

  const customers = new Set(profile.customers.map((c) => c.toLowerCase()));
  const tally: Tally = { receipts: [], rejected: 0 };
  const indexes = await Promise.all([...roots].map(async (root) => ({ root, index: await fetchPage(root) })));
  for (const { root, index } of indexes) {
    if (!index.ok) continue;
    const { name } = siteIdentity(index, root);
    if (customers.has(name.toLowerCase())) continue;
    const hasPricing = links(index.html, root).some((u) => u.replace(/\/$/, '').endsWith('/pricing'));
    if (hasPricing) {
      const site = await crawlSite(root);
      if (site && isCompetitor(site, icp)) {
        readCompetitor(site, profile, tally);
        out.competitors++;
        continue;
      }
    }
    out.targets.push({ url: root, name });
  }
  out.receipts = tally.receipts;
  log(
    'researcher',
    'handoff',
    `${out.targets.length} accounts to read${out.competitors ? ` and ${out.competitors} competitor${out.competitors === 1 ? '' : 's'} recorded` : ''}. One read task per account, in parallel.`,
  );
  return out;
}

// ---------- the read task ----------

/** Read one account and append its receipts. Scoped to a single company, so read tasks never collide. */
export async function readTarget(url: string, icp: IcpVersion, profile: Profile): Promise<ReadOutcome> {
  return isWorldUrl(url) ? readWorldSite(url, icp) : readLivePage(url, icp, profile);
}

async function readWorldSite(url: string, icp: IcpVersion): Promise<ReadOutcome> {
  const tally: Tally = { receipts: [], rejected: 0 };
  const site = await crawlSite(url);
  if (!site) throw new Error(`Could not open ${url}`);
  const out: ReadOutcome = { name: site.name, company_id: null, lead_id: null, receipts: tally.receipts, rejected: 0, pages: site.pages.length };

  const company = ensureCompany(site.name, site.domain, site.url, 'prospect');
  out.company_id = company.id;
  if (company.kind !== 'prospect') return { ...out, skipped: 'Already recorded as a competitor.' };

  const rivals = listCompanies('competitor').map((c) => c.name);
  const about = pageNamed(site, 'about');
  if (about) applyFacts(company, about, ruleFacts(mainText(about.html), site.name), tally);
  for (const page of site.pages) applySignals(company, page, ruleSignals(mainText(page.html), site.name, rivals), pageDate(page.html), tally);
  applyRegionExclusion(company.id, icp, tally);

  out.lead_id = (leadForCompany(company.id) ?? createLead(company.id)).id;
  out.rejected = tally.rejected;
  return out;
}

async function readLivePage(url: string, icp: IcpVersion, profile: Profile): Promise<ReadOutcome> {
  const tally: Tally = { receipts: [], rejected: 0 };
  const out: ReadOutcome = { name: new URL(url).host.replace(/^www\./, ''), company_id: null, lead_id: null, receipts: tally.receipts, rejected: 0, pages: 1 };
  const page = await fetchPage(url);
  if (!page.ok) throw new Error(page.error ?? 'page is unreachable');
  if (page.text.length <= 200) return { ...out, skipped: 'The page has too little text to read.' };

  const reading = await llmReadPage(page.text, page.url, `${profile.product_name}: ${profile.description}`);
  if (!reading) return { ...out, skipped: 'No company could be read from this page.' };
  out.name = reading.company_name;
  tally.rejected += reading.rejected;
  if (reading.rejected > 0) log('researcher', 'warn', `Dropped ${reading.rejected} extracted claim(s) whose snippet was not on the page.`, { ref: page.url });
  if (profile.customers.some((c) => c.toLowerCase() === reading.company_name.toLowerCase())) return { ...out, rejected: tally.rejected, skipped: 'Existing customer.' };
  if (reading.facts.length === 0 && reading.signals.length === 0) return { ...out, rejected: tally.rejected, skipped: 'Nothing quotable on the page.' };

  const domain = reading.company_domain || new URL(page.url).host.replace(/^www\./, '');
  const company = ensureCompany(reading.company_name, domain, `https://${domain}/`, reading.is_competitor ? 'competitor' : 'prospect');
  out.company_id = company.id;
  applyFacts(company, page, reading.facts, tally);
  if (company.kind === 'competitor') return { ...out, rejected: tally.rejected, skipped: 'Recorded as a competitor.' };
  applySignals(company, page, reading.signals, pageDate(page.html), tally);
  applyRegionExclusion(company.id, icp, tally);
  out.lead_id = (leadForCompany(company.id) ?? createLead(company.id)).id;
  out.rejected = tally.rejected;
  return out;
}
