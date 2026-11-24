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
import { recomputeAll } from '../services/leads';
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
// It stops when every lead has a live receipt or a dormant reason.

interface Tally {
  receipts: number;
  rejected: number;
  companies: number;
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

/** Write a receipt only if the page really contains the snippet. Returns whether a new receipt was written. */
function accept(page: FetchedPage, input: NewReceipt, tally: Tally): boolean {
  if (!containsSnippet(page.text, input.snippet)) {
    tally.rejected++;
    log('researcher', 'warn', `Rejected a claim with no matching text on the page: "${input.claim}"`, { ref: input.source_url });
    return false;
  }
  const { created } = addReceipt(input);
  if (created) tally.receipts++;
  return created;
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
function applyRegionExclusion(companyId: string, icp: IcpVersion): void {
  const company = getCompany(companyId);
  if (!company?.region || !icp.fields.excluded_regions.includes(company.region)) return;
  const basis = receiptsFor([company.id]).find((r) => r.field === 'region' && r.sign === 'positive');
  if (!basis) return;
  addReceipt({
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
}

function ensureCompany(name: string, domain: string, siteUrl: string, kind: Company['kind'], tally: Tally): Company {
  const existing = findCompany(siteUrl, domain);
  if (existing) return existing;
  tally.companies++;
  return createCompany({ name, domain, site_url: siteUrl, kind });
}

// ---------- seeded world: search, crawl each site, read with rules ----------

interface Site {
  url: string;
  name: string;
  domain: string;
  pages: FetchedPage[];
}

async function crawlSite(siteUrl: string): Promise<Site | null> {
  const index = await fetchPage(siteUrl);
  if (!index.ok) return null;
  const urls = links(index.html, siteUrl).filter((u) => u.startsWith(siteUrl) && u !== siteUrl).slice(0, 16);
  const pages = (await Promise.all(urls.map((u) => fetchPage(u)))).filter((p) => p.ok);
  const name = metaContent(index.html, 'og:site_name') ?? new URL(siteUrl).pathname.split('/').filter(Boolean).pop() ?? siteUrl;
  const domain = index.text.match(/\b([a-z0-9-]+\.(?:example|test))\b/)?.[1] ?? new URL(siteUrl).host;
  return { url: siteUrl, name, domain, pages };
}

const pageNamed = (site: Site, slug: string) => site.pages.find((p) => p.url.replace(/\/$/, '').endsWith(`/${slug}`));

async function researchWorld(icp: IcpVersion, profile: Profile, urls: string[], tally: Tally): Promise<void> {
  const roots = new Set<string>();
  for (const u of urls) {
    const root = worldSiteOf(u);
    if (root) roots.add(root);
  }
  // Known accounts are re-read on every pass. This is the continuous signal ingestion.
  for (const c of [...listCompanies('prospect'), ...listCompanies('competitor')]) if (isWorldUrl(c.site_url)) roots.add(c.site_url);

  const sites = (await Promise.all([...roots].map(crawlSite))).filter((s): s is Site => s !== null);
  log('researcher', 'info', `Read ${sites.reduce((n, s) => n + s.pages.length, 0)} pages across ${sites.length} sites.`);

  const customers = new Set(profile.customers.map((c) => c.toLowerCase()));
  const keywords = icp.fields.keywords.map((k) => k.toLowerCase());
  const isCompetitor = (site: Site) => {
    const about = pageNamed(site, 'about');
    if (!about || !pageNamed(site, 'pricing')) return false;
    const text = mainText(about.html).toLowerCase();
    return keywords.filter((k) => text.includes(k)).length >= 2;
  };

  const rivals = sites.filter(isCompetitor);
  for (const site of rivals) {
    const company = ensureCompany(site.name, site.domain, site.url, 'competitor', tally);
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

  const rivalNames = listCompanies('competitor').map((c) => c.name);
  for (const site of sites) {
    if (rivals.includes(site) || customers.has(site.name.toLowerCase())) continue;
    const company = ensureCompany(site.name, site.domain, site.url, 'prospect', tally);
    if (company.kind !== 'prospect') continue;
    const about = pageNamed(site, 'about');
    if (about) applyFacts(company, about, ruleFacts(mainText(about.html), site.name), tally);
    for (const page of site.pages) {
      applySignals(company, page, ruleSignals(mainText(page.html), site.name, rivalNames), pageDate(page.html), tally);
    }
    applyRegionExclusion(company.id, icp);
    if (!leadForCompany(company.id)) createLead(company.id);
  }
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

// ---------- live web: search, fetch each result ourselves, read with the model ----------

async function researchLive(icp: IcpVersion, profile: Profile, urls: string[], tally: Tally): Promise<void> {
  const summary = `${profile.product_name}: ${profile.description}`;
  const customers = new Set(profile.customers.map((c) => c.toLowerCase()));
  const pages = (await Promise.all(urls.slice(0, 18).map((u) => fetchPage(u)))).filter((p) => p.ok && p.text.length > 200);
  log('researcher', 'info', `Fetched ${pages.length} of ${Math.min(urls.length, 18)} result pages from the live web.`);

  for (const page of pages) {
    const reading = await llmReadPage(page.text, page.url, summary);
    if (!reading) continue;
    tally.rejected += reading.rejected;
    if (reading.rejected > 0) log('researcher', 'warn', `Dropped ${reading.rejected} extracted claim(s) whose snippet was not on the page.`, { ref: page.url });
    if (customers.has(reading.company_name.toLowerCase())) continue;
    if (reading.facts.length === 0 && reading.signals.length === 0) continue;

    const domain = reading.company_domain || new URL(page.url).host.replace(/^www\./, '');
    const company = ensureCompany(reading.company_name, domain, `https://${domain}/`, reading.is_competitor ? 'competitor' : 'prospect', tally);
    applyFacts(company, page, reading.facts, tally);
    if (company.kind === 'competitor') continue;
    applySignals(company, page, reading.signals, pageDate(page.html), tally);
    applyRegionExclusion(company.id, icp);
    if (!leadForCompany(company.id)) createLead(company.id);
  }
}

/** One research pass: run the search plan, read the sources, write receipts, then re-derive every lead. */
export async function runResearcher(icp: IcpVersion, profile: Profile, pass: 'discovery' | 'ingest'): Promise<Tally> {
  const tally: Tally = { receipts: 0, rejected: 0, companies: 0 };
  if (config.source === 'live' && !llmEnabled()) {
    log('researcher', 'block', 'Live web mode needs model credentials. Set ANTHROPIC_API_KEY, or switch RECEIPTS_SOURCE back to world.');
    return tally;
  }
  const plan = pass === 'ingest' && config.source === 'live' ? icp.search_plan.slice(0, 4) : icp.search_plan;
  log('researcher', 'start', `${pass === 'ingest' ? 'Refreshing signals' : 'Discovery'}: running ${plan.length} searches from ICP v${icp.version}.`);

  const found = new Set<string>();
  for (const batch of chunk(plan, 4)) {
    const results = await Promise.all(batch.map(search));
    for (const list of results) for (const url of list) found.add(url);
  }

  if (config.source === 'live') await researchLive(icp, profile, [...found], tally);
  else await researchWorld(icp, profile, [...found], tally);

  recomputeAll({ announce: pass === 'discovery' });
  log(
    'researcher',
    'done',
    `${tally.receipts} new receipt${tally.receipts === 1 ? '' : 's'} written` +
      (tally.companies ? `, ${tally.companies} new account${tally.companies === 1 ? '' : 's'}` : '') +
      (tally.rejected ? `, ${tally.rejected} claim${tally.rejected === 1 ? '' : 's'} rejected for having no matching source text` : '') +
      '.',
  );
  return tally;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
