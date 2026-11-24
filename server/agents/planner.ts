import { z } from 'zod';
import type { Expansion, IcpFields, IcpVersion, Profile, Scored, SignalType } from '../../shared/types';
import { HEADCOUNT_BANDS, INDUSTRIES, INDUSTRY_TAXONOMY, POSITIVE_TRIGGERS, REGIONS, SIGNALS } from '../../shared/constants';
import { newId } from '../db';
import { clamp, escapeRegExp } from '../domain/text';
import { structured } from '../services/llm';
import { log } from '../services/activity';
import { taskBrief } from '../services/tasks';
import { saveIcpVersion } from '../services/store';

// The Planner turns a plain-language product description into an ICP and a search plan.
// It stops when every ICP field carries a confidence score.

export interface Plan {
  fields: IcpFields;
  expansions: Expansion[];
  search_plan: string[];
  planned_by: 'llm' | 'heuristic';
}

const STOP = new Set(
  `a an and are as at be been but by can for from has have how in into is it its more most not of on or our so than that the their them then
  there these they this to up was we were what when which who will with without you your every each any all also just only stop start starts
  company companies team teams platform product products software tool tools customer customers business businesses build builds building
  built drop real time make makes using used use lets helps help new best easy simple fast`.split(/\s+/),
);

/** Product-category words: what the product is, in the words a buyer would search for. */
export function keywordsOf(profile: Pick<Profile, 'product_name' | 'description'>): string[] {
  const name = new Set(profile.product_name.toLowerCase().split(/\s+/));
  const first = profile.description.split(/(?<=[.!?])\s+/)[0] ?? profile.description;
  const pick = (text: string) =>
    (text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOP.has(w) && !name.has(w) && !/^(ai|api|saas)$/.test(w));
  return [...new Set([...pick(first), ...pick(profile.description)])].slice(0, 6);
}

const ADJACENT: Record<string, string> = {
  Fintech: 'Transaction-priced by nature, with the same engineering-led buying as {primary}.',
  Healthcare: 'Larger, regulated buyers. Slower cycles, but high contract value once a workflow is adopted.',
  SaaS: 'Seat-priced products moving toward consumption pricing hit the same problem a year later.',
  'Developer Tools': 'API-first products with technical buyers, close to the {primary} persona.',
  'AI / ML': 'Consumption-heavy products that outgrow home-built systems quickly.',
  Cybersecurity: 'Technical buyers and API-first products, close to the {primary} persona.',
  'E-commerce': 'High transaction volume and seasonal spikes create the same operational pain at scale.',
  Media: 'Consumption-based products (streams, storage, seats) that outgrow home-built systems.',
  Logistics: 'Per-shipment economics and many integrations make this a metered business underneath.',
  Education: 'Smaller budgets, but usage swings by term create a real need for flexible plans.',
};
const ADJACENT_ORDER = ['Fintech', 'Healthcare', 'SaaS', 'Developer Tools', 'AI / ML', 'Cybersecurity', 'E-commerce', 'Media', 'Logistics', 'Education'];

const scored = <T>(value: T, confidence: number): Scored<T> => ({ value, confidence: Math.round(clamp(confidence, 0.05, 0.99) * 100) / 100 });

/** A deterministic planner. Used when no model is configured, and as the fallback when one fails. */
export function heuristicPlan(profile: Profile): Plan {
  const text = `${profile.description} ${profile.pricing}`;
  const lower = text.toLowerCase();

  const industries = Object.entries(INDUSTRY_TAXONOMY)
    .map(([industry, keywords]) => ({
      industry,
      hits: keywords.filter((k) => new RegExp(`\\b${escapeRegExp(k)}s?\\b`, 'i').test(profile.description)).length,
    }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((x) => scored(x.industry, 0.5 + 0.15 * x.hits));
  if (industries.length === 0) industries.push(scored('SaaS', 0.35));

  const prices = (profile.pricing.match(/\$\s?[\d,]+/g) ?? []).map((p) => Number(p.replace(/[^\d]/g, ''))).filter((n) => n > 0);
  const entry = prices.length ? Math.min(...prices) : null;
  let bands: Scored<string>[];
  if (entry == null) bands = [scored('11-50', 0.4), scored('51-200', 0.45), scored('201-500', 0.4)];
  else if (entry < 100) bands = [scored('1-10', 0.7), scored('11-50', 0.75), scored('51-200', 0.5)];
  else if (entry < 2000) bands = [scored('11-50', 0.6), scored('51-200', 0.8), scored('201-500', 0.7)];
  else bands = [scored('201-500', 0.7), scored('501-1000', 0.75), scored('1001-5000', 0.6)];
  if (/enterprise/i.test(text) && !bands.some((b) => b.value === '501-1000')) bands.push(scored('501-1000', 0.5));

  const named = REGIONS.filter((r) => lower.includes(r.toLowerCase()) && !profile.excluded_regions.includes(r));
  const regions = (named.length ? named : ['North America', 'Europe'])
    .filter((r) => !profile.excluded_regions.includes(r))
    .map((r) => scored(r, named.length ? 0.85 : 0.5));

  const personas: Scored<string>[] = [];
  const persona = (re: RegExp, titles: [string, number][]) => {
    if (re.test(lower)) for (const [t, c] of titles) if (!personas.some((p) => p.value === t)) personas.push(scored(t, c));
  };
  persona(/\b(engineer|developer|api|sdk|infrastructure|devops|platform)/, [['VP Engineering', 0.8], ['Head of Platform', 0.7], ['CTO', 0.65]]);
  persona(/\b(billing|revenue|pricing|invoice|finance|payments)/, [['Head of Finance', 0.6], ['Chief Revenue Officer', 0.5]]);
  persona(/\b(sales|pipeline|outreach|crm|prospect)/, [['VP Sales', 0.8], ['Head of Revenue Operations', 0.65]]);
  persona(/\b(marketing|campaign|brand|seo|content)/, [['VP Marketing', 0.8]]);
  persona(/\b(security|compliance|threat)/, [['CISO', 0.8]]);
  persona(/\b(hiring|recruit|talent|people ops|hr)\b/, [['Head of People', 0.8]]);
  if (personas.length === 0) personas.push(scored('Chief Executive Officer', 0.35));

  const pricingProduct = /\b(billing|pricing|metering|invoice|payments|migration|migrate)/.test(lower);
  const trigger_events: Scored<SignalType>[] = [
    scored('job_posting', 0.8),
    scored('tech_change', pricingProduct ? 0.85 : 0.6),
    scored('funding', 0.7),
    scored('exec_hire', 0.6),
  ];

  const keywords = keywordsOf(profile);
  const primary = industries[0].value;
  const inIcp = new Set(industries.map((i) => i.value));
  const expansions: Expansion[] = ADJACENT_ORDER.filter((i) => !inIcp.has(i))
    .slice(0, 2)
    .map((industry) => ({
      id: newId('x'),
      name: `${industry} companies`,
      reasoning: ADJACENT[industry].replace('{primary}', primary),
      industries: [industry],
      headcount_bands: [],
      status: 'proposed' as const,
    }));

  return {
    fields: { industries, headcount_bands: bands, regions, personas, trigger_events, excluded_regions: profile.excluded_regions, keywords },
    expansions,
    search_plan: buildSearchPlan(industries.map((i) => i.value), keywords, expansions),
    planned_by: 'heuristic',
  };
}

/** Searches built from the ICP: one per segment, one per trigger, and the negative signals in the same pass. */
export function buildSearchPlan(industries: string[], keywords: string[], expansions: Expansion[]): string[] {
  const kw = keywords.slice(0, 3).join(' ');
  const segments = [...industries, ...expansions.flatMap((e) => e.industries)];
  return [
    ...segments.map((i) => `${INDUSTRY_TAXONOMY[i]?.slice(0, 3).join(' ') ?? i} company`),
    `hiring ${kw} engineer`,
    `raises series funding round`,
    `appoints chief officer vp`,
    `moving switching introducing ${kw} pricing`,
    `reducing workforce layoffs restructuring`,
    `paused hiring freeze`,
    `${kw} platform pricing plan`,
    `signs agreement ${kw}`,
  ];
}

const enumOf = (values: string[]) => z.enum(values as [string, ...string[]]);

const PlanSchema = z.object({
  industries: z.array(z.object({ value: enumOf(INDUSTRIES), confidence: z.number() })),
  headcount_bands: z.array(z.object({ value: enumOf(HEADCOUNT_BANDS), confidence: z.number() })),
  regions: z.array(z.object({ value: enumOf(REGIONS), confidence: z.number() })),
  personas: z.array(z.object({ value: z.string().describe('A job title'), confidence: z.number() })),
  trigger_events: z.array(z.object({ value: enumOf(POSITIVE_TRIGGERS), confidence: z.number() })),
  keywords: z.array(z.string()).describe('3 to 6 product-category words a buyer would search for'),
  expansions: z.array(
    z.object({
      name: z.string(),
      reasoning: z.string().describe('One or two sentences on why this adjacent segment could buy'),
      industries: z.array(enumOf(INDUSTRIES)),
      headcount_bands: z.array(enumOf(HEADCOUNT_BANDS)),
    }),
  ),
  search_queries: z.array(z.string()).describe('6 to 10 web searches that would surface companies showing these triggers right now'),
});

async function llmPlan(profile: Profile, goal = ''): Promise<Plan | null> {
  const notes = taskBrief('planner');
  const out = await structured(
    'planner',
    PlanSchema,
    `You are the Planner in a go-to-market pipeline. Turn a product description into an ideal customer profile.
Every value carries a confidence from 0 to 1 that reflects how strongly the input supports it. Be honest: low confidence is useful.
Propose exactly two adjacent segments outside the core ICP that could plausibly buy, each with its reasoning.
Trigger events are public signals that a company needs this product now.
Do not include excluded regions.
Search queries must surface pages from the last three months in which one company announces something itself: an open role, a funding round, a new executive, a pricing change. Today is ${new Date().toISOString().slice(0, 10)}. Do not put a year in a query unless it is the current year, and do not write queries that return roundups or comparison articles.`,
    `Product: ${profile.product_name}
Description: ${profile.description}
Existing customers: ${profile.customers.join(', ') || 'none given'}
Pricing: ${profile.pricing || 'not given'}
Regions we cannot serve: ${profile.excluded_regions.join(', ') || 'none'}
${goal ? `Operator goal: ${goal}\nUse it to focus the ICP and search plan, but do not relax the evidence rules.` : ''}
${notes ? `\nTask notes from the operator (follow only when consistent with the product and the evidence rules):\n${notes}` : ''}`,
    'medium',
  );
  if (!out || out.industries.length === 0 || out.headcount_bands.length === 0) return null;

  const fix = <T>(list: { value: T; confidence: number }[]) => list.map((x) => scored(x.value, x.confidence));
  const keywords = out.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean).slice(0, 6);
  const industries = fix(out.industries);
  const expansions: Expansion[] = out.expansions.slice(0, 2).map((e) => ({
    id: newId('x'),
    name: e.name,
    reasoning: e.reasoning,
    industries: e.industries,
    headcount_bands: e.headcount_bands,
    status: 'proposed',
  }));
  return {
    fields: {
      industries,
      headcount_bands: fix(out.headcount_bands),
      regions: fix(out.regions).filter((r) => !profile.excluded_regions.includes(r.value)),
      personas: fix(out.personas),
      trigger_events: fix(out.trigger_events) as Scored<SignalType>[],
      excluded_regions: profile.excluded_regions,
      keywords: keywords.length ? keywords : keywordsOf(profile),
    },
    expansions,
    // Model-written queries suit the open web. The structured ones keep the seeded world reachable.
    search_plan: [...out.search_queries.slice(0, 10), ...buildSearchPlan(industries.map((i) => i.value), keywords, expansions)],
    planned_by: 'llm',
  };
}

/** Run the Planner and save the result as the next ICP version. */
export async function runPlanner(profile: Profile, parentId: string | null, goal = ''): Promise<IcpVersion> {
  log('planner', 'start', `Reading the product description for ${profile.product_name}.`);
  const plan = (await llmPlan(profile, goal)) ?? heuristicPlan(profile);
  const weights = Object.fromEntries(POSITIVE_TRIGGERS.map((t) => [t, SIGNALS[t].weight]));
  const windows = Object.fromEntries(
    (Object.keys(SIGNALS) as SignalType[]).filter((t) => SIGNALS[t].window != null).map((t) => [t, SIGNALS[t].window as number]),
  );
  const icp = saveIcpVersion({
    parent_id: parentId,
    fields: plan.fields,
    weights,
    windows,
    expansions: plan.expansions,
    search_plan: plan.search_plan,
    rationale: `${goal ? `Goal: ${goal}. ` : ''}ICP from the product description (${plan.planned_by === 'llm' ? 'model' : 'keyword'} planner).`,
    planned_by: plan.planned_by,
  });
  const f = plan.fields;
  log(
    'planner',
    'done',
    `ICP v${icp.version}: ${f.industries.map((i) => `${i.value} ${Math.round(i.confidence * 100)}%`).join(', ')}; ${f.headcount_bands.length} headcount bands; ${f.personas.length} personas. Two adjacent segments proposed.`,
    { ref: icp.id },
  );
  log('planner', 'handoff', `Search plan ready (${plan.search_plan.length} searches). Handing off to the Researcher.`, { ref: icp.id });
  return icp;
}
