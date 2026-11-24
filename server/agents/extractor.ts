import { z } from 'zod';
import type { Sign, SignalType } from '../../shared/types';
import { INDUSTRIES, INDUSTRY_TAXONOMY, SIGNALS } from '../../shared/constants';
import { containsSnippet, escapeRegExp, htmlToText, splitSentences } from '../domain/text';
import { structured } from '../services/llm';

// Two extractors with one contract: every extracted fact carries the exact words that support it.
// The rule extractor reads plainly written pages without a model. The LLM extractor handles the
// open web. Either way the caller re-checks the snippet against the page before writing a receipt.

export interface SignalHit {
  signal_type: SignalType;
  sign: Sign;
  claim: string;
  snippet: string;
  confidence: number;
  data: Record<string, string>;
  event_at?: string | null;
}

export interface FactHit {
  field: 'industry' | 'headcount' | 'hq' | 'region';
  value: string;
  claim: string;
  snippet: string;
  confidence: number;
}

export interface PersonHit {
  name: string;
  title: string;
  email: string | null;
  previous: string[];
  snippet: string;
  email_snippet: string | null;
}

/** Text of the page's main content, without navigation and footers. */
export function mainText(html: string): string {
  const m = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ?? html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  return htmlToText(m ? m[1] : html);
}

// ---------- signals ----------

const JOB = /\b(?:is|are|we're|we are)\s+hiring\s+(?:an?\s+|our\s+(?:first\s+)?)?([A-Z][^.]*?)(?=\s+to\s|\s+in\s|\s+for\s+(?:our|its|the)\s|[.,]|$)/;
const FUNDING = /\brais(?:es|ed|ing)\s+(\$[\d.,]+\s?(?:million|billion|m|bn|k)?)\s+(?:in\s+)?(?:an?\s+)?(series\s+[a-f]|pre-seed|seed(?:\s+extension|\s+round)?)/i;
const EXEC = /\b(?:appoints|appointed|names|named|hires|hired|welcomes)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)+)\s+as\s+(?:its\s+|the\s+)?(?:new\s+|first\s+)?((?:Chief|VP|Vice President|SVP|Head|Director)[\w\s]*?)(?=\s+to\s|\s+ahead\s|[.,]|$)/;
const CHANGE = /\b(?:is|are|will be|has started)\s+((?:moving|switching|migrating)\s+to\s+[^.]+?|(?:introducing|launching|rolling out)\s+[^.]*?(?:pricing|billing|plans)[^.]*?)(?=\.|$)/i;
const LAYOFFS = /\b(?:reducing\s+(?:its|our)\s+workforce|laying\s+off|laid\s+off|layoffs?)\b/i;
const FREEZE = /\b(?:hiring\s+freeze|paus(?:ed|es|ing)\s+(?:all\s+)?hiring|froz(?:e|en)\s+hiring|freez(?:e|es|ing)\s+hiring)\b/i;
const SIGNED = /\b(?:signs?|signed|selects?|selected|chooses?|chose|picks?|picked|standardi[sz]es?\s+on|partners?\s+with)\b/i;

/** Read buying signals, positive and negative, out of plain page text. */
export function ruleSignals(text: string, company: string, competitors: string[]): SignalHit[] {
  const hits: SignalHit[] = [];
  const name = new RegExp(`\\b${escapeRegExp(company)}\\b`, 'i');
  const add = (signal_type: SignalType, claim: string, snippet: string, confidence: number, data: Record<string, string>) =>
    hits.push({ signal_type, sign: SIGNALS[signal_type].sign, claim, snippet, confidence, data });

  for (const s of splitSentences(text)) {
    if (!name.test(s)) continue;

    const rival = competitors.find((c) => new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i').test(s));
    if (rival && SIGNED.test(s)) {
      add('competitor_signed', `${company} signed with ${rival}, a competitor.`, s, 0.85, { competitor: rival });
      continue;
    }
    if (LAYOFFS.test(s)) {
      const pct = s.match(/\bby\s+(\d+(?:\.\d+)?%)/)?.[1];
      add('layoffs', `${company} is reducing its workforce${pct ? ` by ${pct}` : ''}.`, s, 0.85, pct ? { percent: pct } : {});
      continue;
    }
    if (FREEZE.test(s)) {
      add('hiring_freeze', `${company} has paused hiring.`, s, 0.85, {});
      continue;
    }
    const job = s.match(JOB);
    if (job) {
      const role = job[1].trim();
      add('job_posting', `${company} has an open role: ${role}.`, s, 0.85, { role });
      continue;
    }
    const funding = s.match(FUNDING);
    if (funding) {
      const amount = funding[1].trim();
      const round = funding[2].replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bSeed\b/, 'seed').replace('Extension', 'extension').replace('Round', 'round');
      add('funding', `${company} raised ${amount} (${round}).`, s, 0.9, { amount, round });
      continue;
    }
    const exec = s.match(EXEC);
    if (exec) {
      const person = exec[1].trim();
      const title = exec[2].trim();
      add('exec_hire', `${company} appointed ${person} as ${title}.`, s, 0.85, { person, title });
      continue;
    }
    const change = s.match(CHANGE);
    if (change) {
      const what = change[1].trim();
      add('tech_change', `${company} is ${what}.`, s, 0.8, { change: what });
    }
  }
  return hits;
}

// ---------- firmographics ----------

const REGION_HINTS: [RegExp, string][] = [
  [/\b(united states|usa|california|texas|new york|washington|massachusetts|colorado|illinois|florida|canada|toronto|vancouver|montreal|san francisco|seattle|boston|austin|denver|chicago|los angeles)\b/i, 'North America'],
  [/\b(united kingdom|england|london|germany|berlin|munich|france|paris|netherlands|amsterdam|ireland|dublin|spain|madrid|sweden|stockholm|denmark|copenhagen|norway|finland|italy|switzerland|zurich|poland|portugal|belgium|austria)\b/i, 'Europe'],
  [/\b(singapore|australia|sydney|melbourne|japan|tokyo|india|bangalore|bengaluru|mumbai|china|korea|seoul|indonesia|vietnam|new zealand|hong kong)\b/i, 'APAC'],
  [/\b(brazil|mexico|argentina|chile|colombia|sao paulo|buenos aires)\b/i, 'LATAM'],
  [/\b(israel|tel aviv|uae|dubai|saudi arabia|egypt|nigeria|lagos|kenya|nairobi|south africa|cape town|turkey)\b/i, 'Middle East & Africa'],
];

export function regionOf(place: string): string | null {
  for (const [re, region] of REGION_HINTS) if (re.test(place)) return region;
  return null;
}

export function industryOf(text: string): { industry: string; hits: number } | null {
  let best: { industry: string; hits: number } | null = null;
  for (const [industry, keywords] of Object.entries(INDUSTRY_TAXONOMY)) {
    const hits = keywords.filter((k) => new RegExp(`\\b${escapeRegExp(k)}s?\\b`, 'i').test(text)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { industry, hits };
  }
  return best;
}

/** Read industry, headcount and location from an about page. Each fact keeps its sentence. */
export function ruleFacts(text: string, company: string): FactHit[] {
  const facts: FactHit[] = [];
  const sentences = splitSentences(text);

  for (const s of sentences) {
    const n = s.match(/\bteam of ([\d,]+)\b/i) ?? s.match(/\b([\d,]+)-person\b/i) ?? s.match(/\b([\d,]+)\s+(?:employees|people)\b/i);
    if (n && !facts.some((f) => f.field === 'headcount')) {
      const value = n[1].replace(/,/g, '');
      facts.push({ field: 'headcount', value, claim: `${company} has about ${value} employees.`, snippet: s, confidence: 0.85 });
    }
    const hq = s.match(/\b(?:headquartered|based)\s+in\s+([A-Z][^.]*?)(?=\.|$)/);
    if (hq && !facts.some((f) => f.field === 'hq')) {
      const place = hq[1].trim();
      facts.push({ field: 'hq', value: place, claim: `${company} is headquartered in ${place}.`, snippet: s, confidence: 0.9 });
      const region = regionOf(place);
      if (region) facts.push({ field: 'region', value: region, claim: `${company} is based in ${region}.`, snippet: s, confidence: 0.8 });
    }
  }

  let best: { industry: string; hits: number; sentence: string } | null = null;
  for (const s of sentences) {
    const found = industryOf(s);
    if (found && (!best || found.hits > best.hits)) best = { ...found, sentence: s };
  }
  if (best) {
    facts.push({
      field: 'industry',
      value: best.industry,
      claim: `${company} operates in ${best.industry}.`,
      snippet: best.sentence,
      confidence: Math.min(0.9, 0.5 + 0.15 * best.hits),
    });
  }
  return facts;
}

// ---------- people ----------

const PERSON_LINE = /^([A-Z][\w'-]+(?:\s+(?:de|van|von|der|[A-Z][\w'-]+))+),\s+([^.]+)\.(.*)$/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

/** Read a team page written as "Name, Title. Previously at X. Email: y". */
export function rulePeople(text: string): PersonHit[] {
  const people: PersonHit[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(PERSON_LINE);
    if (!m) continue;
    const rest = m[3] ?? '';
    const prev = rest.match(/Previously at ([^.]+)\./i)?.[1] ?? '';
    const email = rest.match(EMAIL)?.[0] ?? null;
    people.push({
      name: m[1].trim(),
      title: m[2].trim(),
      email,
      previous: prev ? prev.split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean) : [],
      snippet: line.trim(),
      email_snippet: email ? line.trim() : null,
    });
  }
  return people;
}

// ---------- competitor cards ----------

export function rulePricing(text: string): string | null {
  return splitSentences(text).find((s) => /\$\s?\d|\d%/.test(s)) ?? null;
}

export function rulePositioning(text: string, company: string): string | null {
  const name = new RegExp(`\\b${escapeRegExp(company)}\\b`, 'i');
  return splitSentences(text).find((s) => name.test(s) && s.length > 30) ?? null;
}

// ---------- LLM extraction for the open web ----------

const TRIGGERS = ['job_posting', 'funding', 'exec_hire', 'tech_change', 'layoffs', 'hiring_freeze', 'competitor_signed'] as const;

const PageExtraction = z.object({
  company_name: z.string().describe('The company this page is mainly about. Empty string if unclear.'),
  company_domain: z.string().describe("That company's own website domain, e.g. acme.com. Empty string if unknown."),
  is_competitor: z.boolean().describe('True if this company sells a product in the same category as ours.'),
  facts: z.array(
    z.object({
      field: z.enum(['industry', 'headcount', 'hq']),
      value: z.string().describe(`For industry, exactly one of: ${INDUSTRIES.join(', ')}. For headcount, digits only.`),
      snippet: z.string().describe('Exact words copied from the page that support this fact.'),
    }),
  ),
  signals: z.array(
    z.object({
      signal_type: z.enum(TRIGGERS),
      claim: z.string().describe('One sentence stating the fact and naming the company.'),
      snippet: z.string().describe('Exact words copied from the page that support the claim. Must appear verbatim.'),
      event_date: z.string().describe('ISO date the event happened or was published, or empty string if the page does not say.'),
      confidence: z.number().describe('0 to 1.'),
    }),
  ),
});

export interface LlmReading {
  company_name: string;
  company_domain: string;
  is_competitor: boolean;
  facts: FactHit[];
  signals: SignalHit[];
  rejected: number;
}

/** Extract one page with the LLM. Anything whose snippet is not on the page is dropped and counted. */
export async function llmReadPage(pageText: string, url: string, productSummary: string): Promise<LlmReading | null> {
  const out = await structured(
    'page extraction',
    PageExtraction,
    `You extract verifiable B2B buying signals from one web page for a sales team.
Our product: ${productSummary}

Rules:
- Only report what this page states. Never infer and never add outside knowledge.
- Every snippet must be copied word for word from the page. A fact without a verbatim snippet must be left out.
- Signals are: job_posting, funding, exec_hire, tech_change (a technology or pricing change), layoffs, hiring_freeze, competitor_signed (the company signed with a competitor of ours).
- If the page is a list or roundup about many companies, report only the main one, or nothing.`,
    `URL: ${url}\n\nPAGE TEXT:\n${pageText.slice(0, 12000)}`,
  );
  if (!out || !out.company_name) return null;

  let rejected = 0;
  const company = out.company_name.trim();
  const facts: FactHit[] = [];
  for (const f of out.facts) {
    if (!containsSnippet(pageText, f.snippet)) {
      rejected++;
      continue;
    }
    if (f.field === 'industry' && !INDUSTRIES.includes(f.value)) continue;
    const value = f.field === 'headcount' ? f.value.replace(/\D/g, '') : f.value.trim();
    if (!value) continue;
    const claim =
      f.field === 'industry'
        ? `${company} operates in ${value}.`
        : f.field === 'headcount'
          ? `${company} has about ${value} employees.`
          : `${company} is headquartered in ${value}.`;
    facts.push({ field: f.field, value, claim, snippet: f.snippet, confidence: 0.7 });
    if (f.field === 'hq') {
      const region = regionOf(value);
      if (region) facts.push({ field: 'region', value: region, claim: `${company} is based in ${region}.`, snippet: f.snippet, confidence: 0.6 });
    }
  }
  const signals: SignalHit[] = [];
  for (const s of out.signals) {
    if (!containsSnippet(pageText, s.snippet)) {
      rejected++;
      continue;
    }
    const date = s.event_date ? new Date(s.event_date) : null;
    signals.push({
      signal_type: s.signal_type,
      sign: SIGNALS[s.signal_type].sign,
      claim: s.claim,
      snippet: s.snippet,
      confidence: Math.min(1, Math.max(0, s.confidence)),
      data: {},
      event_at: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    });
  }
  return { company_name: company, company_domain: out.company_domain.trim().toLowerCase(), is_competitor: out.is_competitor, facts, signals, rejected };
}

const PeopleExtraction = z.object({
  people: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      email: z.string().describe('Email address if printed on the page, else empty string.'),
      previous_companies: z.array(z.string()).describe('Previous employers named on the page.'),
      snippet: z.string().describe('Exact words copied from the page naming this person and their title.'),
    }),
  ),
});

export async function llmReadPeople(pageText: string, company: string): Promise<PersonHit[]> {
  const out = await structured(
    'people extraction',
    PeopleExtraction,
    `List the people this page names as working at ${company}, with their titles. Only report what the page states. Every snippet must be copied word for word from the page.`,
    pageText.slice(0, 12000),
  );
  if (!out) return [];
  return out.people
    .filter((p) => p.name && p.title && containsSnippet(pageText, p.snippet))
    .map((p) => {
      const email = p.email && pageText.toLowerCase().includes(p.email.toLowerCase()) ? p.email : null;
      return { name: p.name, title: p.title, email, previous: p.previous_companies, snippet: p.snippet, email_snippet: email };
    });
}
